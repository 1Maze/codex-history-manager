"""Manual backups and independent conversation or text continuation sessions."""

import contextlib
import datetime
import hashlib
import json
from pathlib import Path
import re
import tempfile
import uuid

from store import (StoreError, HISTORY_TABLES, atomic_write, backup_database,
                   connect, encode, fingerprint, jsonl_lines)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def text_content(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(part.get("text", "") for part in content
                     if isinstance(part, dict) and isinstance(part.get("text"), str))


def recovery_turns(sources):
    turns, ordered = {}, []
    current = ""
    position = 0
    for source in sources:
        for index, line in enumerate(jsonl_lines(source["source"])):
            position += 1
            record = json.loads(line)
            if record.get("type") == "session_meta":
                continue
            payload = record.get("payload", {})
            if record.get("type") == "event_msg" and payload.get("type") == "task_started":
                current = payload.get("turn_id", "")
            metadata = payload.get("internal_chat_message_metadata_passthrough", {})
            turn_id = payload.get("turn_id") or metadata.get("turn_id") or current
            if not turn_id:
                continue
            if turn_id not in turns:
                turns[turn_id] = {"id": turn_id, "status": "incomplete", "records": 0,
                                 "bytes": 0, "messages": [], "seen": {}, "raw": [],
                                 "toolCalls": 0, "checkpoints": 0}
                ordered.append(turn_id)
            turn = turns[turn_id]
            turn["records"] += 1
            turn["bytes"] += len(line.encode("utf-8"))
            if record.get("type") == "compacted":
                turn["checkpoints"] += 1
            else:
                turn["raw"].append((position, record))
            if record.get("type") == "response_item" and payload.get("type") in (
                    "function_call", "custom_tool_call", "tool_search_call", "web_search_call"):
                turn["toolCalls"] += 1
            if record.get("type") == "event_msg":
                if payload.get("type") == "task_complete":
                    turn["status"] = "completed"
                elif payload.get("type") in ("turn_aborted", "task_failed"):
                    turn["status"] = "incomplete"
            role, text, identity, priority = None, "", "", 0
            item = payload.get("item", {})
            if (record.get("type") == "event_msg" and payload.get("type") == "item_completed"
                    and item.get("type") in ("UserMessage", "AgentMessage")):
                role = "user" if item["type"] == "UserMessage" else "assistant"
                text, identity, priority = text_content(item.get("content")) or item.get("text", ""), item.get("id"), 3
                if item.get("phase") == "analysis":
                    continue
            elif record.get("type") == "response_item" and payload.get("type") == "message":
                role, text, identity, priority = payload.get("role"), text_content(payload.get("content")), payload.get("id"), 1
                if role not in ("user", "assistant") or payload.get("channel") == "analysis":
                    continue
                kinds = metadata.get("content_item_kinds", [])
                if role == "user" and kinds and not any(str(kind).startswith("user.") for kind in kinds):
                    continue
            elif record.get("type") == "event_msg" and payload.get("type") in ("user_message", "agent_message"):
                role = "user" if payload["type"] == "user_message" else "assistant"
                text, priority = payload.get("message", ""), 2
            if not role or not isinstance(text, str) or not text.strip():
                continue
            if role == "user" and re.match(r"\s*<(environment_context|turn_aborted|external_codex_apps_open_page)", text):
                continue
            text = text.strip()
            if text.startswith(("## Referenced chats with Codex:", "# Files mentioned by the user:")) and "## My request:" in text:
                text = text.split("## My request:", 1)[1].strip()
            key = (role, identity) if identity else None
            existing = turn["seen"].get(key) if key else None
            if existing is None and turn["messages"]:
                last = turn["messages"][-1]
                if last["role"] == role and last["text"] == text and last["priority"] != priority:
                    existing = last
            if existing is not None:
                if priority >= existing["priority"]:
                    existing.update(text=text, priority=priority, position=position)
            else:
                existing = {"role": role, "text": text, "priority": priority, "position": position}
                turn["messages"].append(existing)
            if key:
                turn["seen"][key] = existing
    return [turns[key] for key in ordered]


def conversation_records(native_meta, source_meta, selected, thread_id):
    """Copy protocol records, not a flattened text transcript or old model checkpoint."""
    first = json.loads(encode(source_meta))
    for field in ("history_base", "forked_from_id", "forked_from_ordinal_exclusive"):
        first.pop(field, None)
    for field in ("id", "session_id", "timestamp"):
        if field in native_meta:
            first[field] = native_meta[field]
    first.update(id=thread_id, session_id=thread_id, history_mode="paginated")
    records = [{"type": "session_meta", "timestamp": native_meta.get("timestamp"), "payload": first}]
    calls = {}
    pairs = {"function_call_output": "function_call", "custom_tool_call_output": "custom_tool_call",
             "tool_search_output": "tool_search_call"}
    ordered = sorted((entry for turn in selected for entry in turn["raw"]), key=lambda entry: entry[0])
    for _, original in ordered:
        record = json.loads(encode(original))
        payload = record.get("payload", {})
        if record["type"] == "response_item":
            kind, call_id = payload.get("type"), payload.get("call_id")
            if kind in pairs.values():
                if not call_id or call_id in calls:
                    raise StoreError("工具调用 ID 缺失或重复，拒绝创建不完整的对话截选。")
                calls[call_id] = kind
            elif kind in pairs:
                if calls.pop(call_id, None) != pairs[kind]:
                    raise StoreError("工具返回值缺少对应调用，请保留更多完整轮次。")
        # Only rewrite protocol ownership, never IDs or paths inside user text/tool results.
        if "thread_id" in payload:
            payload["thread_id"] = thread_id
        records.append(record)
    if calls:
        raise StoreError("所选轮次中有未返回的工具调用，不能创建完整对话截选。")
    for ordinal, record in enumerate(records):
        record["ordinal"] = ordinal
    return records


def conversation_preview(selected):
    items, calls = [], {}
    for turn in selected:
        items.extend({"role": message["role"], "text": message["text"][:6000],
                      "position": message["position"]} for message in turn["messages"])
        for position, record in turn["raw"]:
            if record["type"] != "response_item":
                continue
            payload = record["payload"]
            kind = payload.get("type")
            if kind in ("function_call", "custom_tool_call", "tool_search_call", "web_search_call"):
                arguments = payload.get("arguments", payload.get("input", payload.get("action", "")))
                item = {"role": "tool", "position": position,
                        "name": payload.get("name") or kind,
                        "text": (arguments if isinstance(arguments, str) else encode(arguments))[:2000]}
                calls[payload.get("call_id")] = item
                items.append(item)
            elif kind in ("function_call_output", "custom_tool_call_output", "tool_search_output"):
                item = calls.get(payload.get("call_id"))
                if item:
                    output = payload.get("output", payload.get("tools", ""))
                    item["output"] = (output if isinstance(output, str) else encode(output))[:2000]
    return sorted(items, key=lambda item: item["position"])


def materialize_imported_user(records, thread_id, handoff):
    """Give the injected handoff a durable UI-visible user event without running a model."""
    if any(record.get("type") == "event_msg" and
           (record.get("payload", {}).get("type") == "user_message" or
            record.get("payload", {}).get("item", {}).get("type") == "UserMessage")
           for record in records):
        return records
    records = json.loads(encode(records))
    turn_id, user_id = str(uuid.uuid4()), str(uuid.uuid4())
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    for record in records:
        if record.get("type") == "response_item" and record["payload"].get("role") == "user":
            record["payload"].setdefault("internal_chat_message_metadata_passthrough", {})["turn_id"] = turn_id
    start = {"timestamp": timestamp, "type": "event_msg", "payload": {
        "type": "task_started", "turn_id": turn_id, "root_turn_id": turn_id,
        "started_at": now_ms // 1000, "model_context_window": None,
        "collaboration_mode_kind": "default"}}
    index = next((i for i, record in enumerate(records) if record["type"] == "response_item"), len(records))
    records.insert(index, start)
    records.append({"timestamp": timestamp, "type": "event_msg", "payload": {
        "type": "item_completed", "thread_id": thread_id, "turn_id": turn_id,
        "item": {"type": "UserMessage", "id": user_id, "client_id": str(uuid.uuid4()),
                 "content": [{"type": "text", "text": handoff, "text_elements": []}]},
        "started_at_ms": now_ms, "completed_at_ms": now_ms}})
    # Import stops before inference. Do not fabricate an assistant reply or a successful model turn.
    records.append({"timestamp": timestamp, "type": "event_msg", "payload": {
        "type": "turn_aborted", "turn_id": turn_id, "reason": "interrupted", "started_at": now_ms // 1000}})
    for ordinal, record in enumerate(records):
        record["ordinal"] = ordinal
    return records


def visible_copy_metadata(row, metadata, handoff):
    row = dict(row)
    row.update(has_user_event=1, first_user_message=handoff, preview=handoff[:500],
               source=metadata.get("source", "vscode"), cwd=metadata["cwd"],
               model_provider=metadata["model_provider"], project_id=metadata.get("project_id"))
    for field in ("model", "reasoning_effort", "creator_user_id", "creator_account_id", "thread_source", "originator"):
        if field in row:
            row[field] = metadata.get(field)
    return row


class RecoveryService:
    def __init__(self, store):
        self.store = store

    def repair_copy_visibility(self, thread_id):
        """Repair only a copy created by this tool; never alter its source session."""
        store = self.store
        install = store.recovery_root / ("copy-" + thread_id)
        if not (install / "journal.json").is_file():
            raise StoreError("此会话没有恢复副本创建记录，拒绝自动修复。")
        journal = json.loads((install / "journal.json").read_text("utf-8"))
        if journal.get("threadId") != thread_id or journal.get("status") != "committed":
            raise StoreError("副本创建日志未完成，请先检查日志。", 409)
        source_id = journal.get("sourceThreadId")
        source_metadata, _ = store.thread(source_id)
        with store.mutex:
            backup = self.backup(thread_id, kind="visibility-repair")
            opened = store.open(thread_id)
            records = [json.loads(line) for line in jsonl_lines(opened["source"])]
            if records[0]["payload"].get("history_base"):
                raise StoreError("副本仍包含继承关系，不能自动修复。")
            handoffs = [text_content(record["payload"].get("content")) for record in records
                        if record["type"] == "response_item" and record["payload"].get("role") == "user"]
            if len(handoffs) != 1 or not handoffs[0].strip():
                raise StoreError("副本不是单条续聊文本，拒绝自动修复。")
            handoff = handoffs[0]
            updated = materialize_imported_user(records, thread_id, handoff)
            result = store.save(thread_id, opened["version"],
                                "".join(encode(record) + "\n" for record in updated), mirror=False)
            with store.writer_lock(thread_id):
                metadata, path = store.thread(thread_id)
                baseline = store.snapshots[result["version"]]
                store.check_baseline(thread_id, baseline, metadata, path, path.read_bytes())
                patch = visible_copy_metadata(metadata, source_metadata, handoff)
                fields = ("has_user_event", "first_user_message", "preview", "source", "cwd",
                          "project_id", "creator_user_id", "creator_account_id", "thread_source", "originator")
                with connect(store.state_db) as db:
                    db.execute("BEGIN IMMEDIATE")
                    live = dict(db.execute("SELECT * FROM threads WHERE id=?", (thread_id,)).fetchone())
                    if fingerprint(encode(live).encode()) != baseline["metadataHash"]:
                        raise StoreError("副本元数据在修复期间变化，请重试。", 409)
                    db.execute("UPDATE threads SET " + ",".join('"' + field + '"=?' for field in fields) +
                               " WHERE id=?", [patch[field] for field in fields] + [thread_id])
            journal.update(visibilityRepairedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                           visibilityBackup=backup["backupPath"])
            store.write_journal(install, journal)
            return {"threadId": thread_id, "backupPath": backup["backupPath"], "info": store.inspect(thread_id)}

    def backup(self, thread_id, kind="manual", _locked=False):
        store = self.store
        with store.mutex, contextlib.ExitStack() as stack:
            parents = store.lineage(thread_id)
            if not _locked:
                for identifier in sorted({thread_id, *(parent["id"] for parent in parents)}):
                    stack.enter_context(store.writer_lock(identifier))
            opened = store.open(thread_id)
            baseline = store.snapshots[opened["version"]]
            metadata, path = store.thread(thread_id)
            raw = path.read_bytes()
            now = datetime.datetime.now(datetime.timezone.utc)
            name = now.strftime("%Y%m%d-%H%M%S") + "-" + kind + "-" + uuid.uuid4().hex[:12]
            directory = store.recovery_root / name
            directory.mkdir(parents=True, mode=0o700)
            entry = {"threadId": thread_id, "title": metadata.get("name") or metadata["title"],
                     "path": str(path), "kind": kind, "status": "snapshot_preparing",
                     "createdAt": now.isoformat(), "beforeHash": fingerprint(raw), "fileBytes": len(raw)}
            store.write_journal(directory, entry)
            atomic_write(directory / "rollout.before.jsonl", raw)
            backup_database(store.history_db, directory / "thread_history.before.sqlite")
            backup_database(store.state_db, directory / "state.before.sqlite")
            ancestor_manifest = []
            for parent in parents:
                filename = "ancestor-" + parent["id"] + ".jsonl"
                atomic_write(directory / filename, parent["data"])
                ancestor_manifest.append({"id": parent["id"], "file": filename, "prefixHash": parent["prefixHash"]})
            try:
                live_metadata, live_path = store.thread(thread_id)
                store.check_baseline(thread_id, baseline, live_metadata, live_path, live_path.read_bytes())
                with connect(directory / "thread_history.before.sqlite", True) as db:
                    if store.database_fingerprint(thread_id, db) != baseline["historyHash"]:
                        raise StoreError("备份期间索引发生变化，请重试。", 409)
            except Exception:
                entry["status"] = "snapshot_failed"
                store.write_journal(directory, entry)
                raise
            entry.update(status="snapshot", ancestors=ancestor_manifest,
                         historyHash=file_hash(directory / "thread_history.before.sqlite"),
                         stateHash=file_hash(directory / "state.before.sqlite"))
            store.write_journal(directory, entry)
            return {**entry, "backupId": name, "backupPath": str(directory)}

    def backup_path(self, backup_id):
        if not isinstance(backup_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", backup_id):
            raise StoreError("备份 ID 无效。")
        root = self.store.recovery_root.resolve()
        path = (root / backup_id).resolve()
        if path.parent != root or not (path / "journal.json").is_file():
            raise StoreError("备份不存在。", 404)
        return path

    def backups(self, thread_id=None):
        rows = []
        if self.store.recovery_root.exists():
            for journal in self.store.recovery_root.glob("*/journal.json"):
                if journal.parent.is_symlink():
                    continue
                try:
                    entry = json.loads(journal.read_text("utf-8"))
                    if entry.get("kind") == "recovery_copy":
                        continue
                    if thread_id and entry.get("threadId") != thread_id:
                        continue
                    raw_path = journal.parent / "rollout.before.jsonl"
                    rows.append({"backupId": journal.parent.name, "threadId": entry.get("threadId"),
                                 "title": entry.get("title") or entry.get("threadId", ""),
                                 "createdAt": entry.get("createdAt", ""), "kind": entry.get("kind", "automatic"),
                                 "status": entry.get("status"), "fileBytes": raw_path.stat().st_size if raw_path.exists() else 0,
                                 "backupPath": str(journal.parent),
                                 "restorable": entry.get("status") in ("snapshot", "committed", "rolled_back") and raw_path.is_file()})
                except (OSError, ValueError):
                    continue
        rows.sort(key=lambda row: row["backupId"], reverse=True)
        return {"rows": rows}

    def restore(self, thread_id, version, backup_id):
        directory = self.backup_path(backup_id)
        entry = json.loads((directory / "journal.json").read_text("utf-8"))
        if entry.get("threadId") != thread_id:
            raise StoreError("备份属于另一条会话，拒绝恢复。")
        if entry.get("status") not in ("snapshot", "committed", "rolled_back"):
            raise StoreError("此备份未完成，需要先检查恢复日志。", 409)
        data = (directory / "rollout.before.jsonl").read_bytes()
        if not entry.get("beforeHash") or fingerprint(data) != entry["beforeHash"]:
            raise StoreError("备份文件校验失败，未恢复。", 409)
        current_parents = {parent["id"]: parent["prefixHash"] for parent in self.store.lineage(thread_id)}
        for ancestor in entry.get("ancestors", []):
            if current_parents.get(ancestor["id"]) != ancestor["prefixHash"]:
                raise StoreError("父会话继承内容已变化，不能自动恢复此备份；请先检查父会话。", 409)
        # save() backs up the current state and only replaces this thread's rows.
        result = self.store.save(thread_id, version, data.decode("utf-8"), mirror=False)
        result["restoredFrom"] = backup_id
        return result

    def preview(self, thread_id, version, keep=1, _include_records=False):
        if type(keep) is not int or not 1 <= keep <= 20:
            raise StoreError("保留轮次必须为 1 到 20。")
        store = self.store
        with store.mutex:
            baseline = store.snapshots.get(version)
            if not baseline or baseline["threadId"] != thread_id:
                raise StoreError("会话快照失效，请重新读取。", 409)
            metadata, path = store.thread(thread_id)
            store.check_baseline(thread_id, baseline, metadata, path, path.read_bytes())
            sources = [{"id": parent["id"], "source": parent["data"][:parent["end"]].decode("utf-8")}
                       for parent in reversed(store.lineage(thread_id))]
            sources.append({"id": thread_id, "source": path.read_text("utf-8")})
            turns = recovery_turns(sources)
            complete = [turn for turn in turns if turn["status"] == "completed" and turn["messages"]]
            selected = complete[-keep:]
            title = metadata.get("name") or metadata["title"]
            text = ["# 续聊信息", "", f"来源会话：{title}", "",
                    "目标：待确认", "约束：待确认", "已完成与关键文件：待确认",
                    "已验证 / 未验证：待确认", "下一步：待确认", "",
                    "# 所选完整轮次的文本摘录"]
            for index, turn in enumerate(selected, 1):
                text.extend(["", f"## 轮次 {index}"])
                for message in turn["messages"]:
                    body = message["text"]
                    if len(body) > 3000:
                        body = body[:3000] + "\n[文本节选，完整内容见原会话]"
                    text.extend(["", "用户：" if message["role"] == "user" else "助手：", body])
            result = {"threadId": thread_id, "version": version, "title": title, "keep": keep,
                    "turns": [{"id": turn["id"], "status": turn["status"], "records": turn["records"],
                               "bytes": turn["bytes"], "messages": len(turn["messages"]),
                               "toolCalls": turn["toolCalls"],
                               "selected": turn in selected,
                               "prompt": next((m["text"][:120] for m in turn["messages"] if m["role"] == "user"), "")}
                              for turn in turns],
                    "completeTurns": len(complete), "selectedTurns": len(selected),
                    "originalBytes": sum(len(source["source"].encode("utf-8")) for source in sources),
                    "selectedRawBytes": sum(turn["bytes"] for turn in selected),
                    "selectedToolCalls": sum(turn["toolCalls"] for turn in selected),
                    "omittedCheckpoints": sum(turn["checkpoints"] for turn in selected),
                    "conversation": conversation_preview(selected),
                    "handoff": "\n".join(text), "textBytes": len("\n".join(text).encode("utf-8"))}
            if _include_records:
                result["_selected"] = selected
                result["_sessionMeta"] = json.loads(jsonl_lines(path.read_text("utf-8"))[0])["payload"]
            return result

    def create_copy(self, thread_id, version, keep, handoff=None, mode="conversation"):
        if mode not in ("conversation", "handoff"):
            raise StoreError("恢复副本模式无效。")
        if mode == "handoff":
            if not isinstance(handoff, str) or not handoff.strip():
                raise StoreError("续聊文本不能为空。")
            if len(handoff.encode("utf-8")) > 64 * 1024:
                raise StoreError("续聊文本超过 64 KiB，请精简后再创建。")
        store = self.store
        with store.mutex:
            plan = self.preview(thread_id, version, keep, _include_records=True)
            if not plan["selectedTurns"]:
                raise StoreError("没有可选的完整轮次，请先导出并手工整理续聊信息。")
            baseline = store.snapshots[version]
            metadata, path = store.thread(thread_id)
            if mode == "conversation":
                # Validate tool pairing before backups or creating a native temporary thread.
                conversation_records({}, plan["_sessionMeta"], plan["_selected"], thread_id)
                handoff = next((m["text"] for turn in plan["_selected"] for m in turn["messages"]
                                if m["role"] == "user"), "对话截选")
            suffix = " · 对话截选" if mode == "conversation" else " · 恢复副本"
            with contextlib.ExitStack() as stack:
                for identifier in sorted({thread_id, *(p["id"] for p in store.lineage(thread_id))}):
                    stack.enter_context(store.writer_lock(identifier))
                backup = self.backup(thread_id, kind="recovery", _locked=True)
                with tempfile.TemporaryDirectory(prefix="codex-recovery-copy-") as temporary:
                    home = Path(temporary).resolve()
                    new_id = store.parser.create_text_session(home, handoff, plan["title"][:120] + suffix)
                    with connect(home / "state_5.sqlite", True) as db:
                        row = dict(db.execute("SELECT * FROM threads WHERE id=?", (new_id,)).fetchone())
                    source = Path(row["rollout_path"]).read_bytes()
                    records = [json.loads(line) for line in jsonl_lines(source.decode("utf-8"))]
                    # Drop temporary-home setup prompts; retain only native metadata and the injected handoff.
                    records = [record for record in records if record["type"] == "session_meta" or
                               (record["type"] == "event_msg" and record["payload"].get("type") == "thread_settings_applied") or
                               (record["type"] == "response_item" and record["payload"].get("role") == "user" and
                                text_content(record["payload"].get("content")) == handoff)]
                    if not any(record["type"] == "response_item" for record in records):
                        raise StoreError("原生会话未持久化续聊文本，未创建副本。", 503)
                    for ordinal, record in enumerate(records):
                        record["ordinal"] = ordinal
                        if record["type"] == "response_item":
                            record["payload"].setdefault("internal_chat_message_metadata_passthrough", {})["content_item_kinds"] = ["user.text"]
                    first = records[0]["payload"]
                    if first.get("history_base") or first.get("forked_from_id"):
                        raise StoreError("新会话意外继承了旧历史，拒绝注册。", 503)
                    first.update(cwd=metadata["cwd"], runtime_workspace_roots=[metadata["cwd"]],
                                 model_provider=metadata["model_provider"], source=metadata.get("source", "vscode"))
                    first.pop("git", None)
                    for record in records:
                        payload = record.get("payload", {})
                        if record["type"] == "turn_context":
                            payload["cwd"] = metadata["cwd"]
                        if payload.get("type") == "thread_settings_applied":
                            settings = payload.get("thread_settings", {})
                            settings.update(cwd=metadata["cwd"], runtime_workspace_roots=[metadata["cwd"]],
                                            model_provider_id=metadata["model_provider"])
                            if metadata.get("model"):
                                settings["model"] = metadata["model"]
                    records = materialize_imported_user(records, new_id, handoff)
                    if mode == "conversation":
                        records = conversation_records(first, plan["_sessionMeta"], plan["_selected"], new_id)
                    source = ("".join(encode(record) + "\n" for record in records)).encode("utf-8")
                    if len(source) > 180 * 1024 * 1024:
                        raise StoreError("对话截选超过 180 MiB，请减少保留轮次。")
                    native_path = Path(row["rollout_path"])
                    atomic_write(native_path, source)
                    with connect(home / "thread_history_1.sqlite") as db:
                        for table in HISTORY_TABLES:
                            db.execute(f'DELETE FROM "{table}" WHERE thread_id=?', (new_id,))
                    store.parser.project(home, new_id)
                    with connect(home / "thread_history_1.sqlite", True) as db:
                        projected = store.history_rows(new_id, db)
                    if mode == "conversation":
                        expected_ids = {record["payload"]["item"]["id"] for record in records
                                        if record["type"] == "event_msg" and
                                        record["payload"].get("type") == "item_completed" and
                                        record["payload"].get("item", {}).get("id")}
                        actual_ids = {item["item_id"] for item in projected.get("thread_items", [])}
                        if not expected_ids <= actual_ids:
                            raise StoreError("原生解析未保留全部消息或工具项目，未注册副本。", 503)
                    projection = projected.get("thread_history_projection_state", [])
                    if len(projection) != 1 or projection[0]["next_rollout_byte_offset"] != len(source):
                        raise StoreError("独立副本索引校验失败，未注册。", 503)
                    live_metadata, live_path = store.thread(thread_id)
                    store.check_baseline(thread_id, baseline, live_metadata, live_path, live_path.read_bytes())
                    destination = store.home / "sessions" / native_path.relative_to(home / "sessions")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    row = visible_copy_metadata(row, metadata, handoff)
                    row["rollout_path"] = str(destination)
                    install = store.recovery_root / ("copy-" + new_id)
                    install.mkdir(mode=0o700)
                    journal = {"threadId": new_id, "sourceThreadId": thread_id, "kind": "recovery_copy",
                               "mode": mode, "keep": keep, "selectedTurnIds": [t["id"] for t in plan["_selected"]],
                               "status": "prepared", "path": str(destination),
                               "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                    store.write_journal(install, journal)
                    with connect(store.state_db) as db:
                        db.execute("ATTACH DATABASE ? AS history", (str(store.history_db),))
                        created_file = False
                        try:
                            db.execute("BEGIN IMMEDIATE")
                            columns = [r["name"] for r in db.execute("PRAGMA table_info(threads)")]
                            if set(columns) != set(row):
                                raise StoreError("原生数据库结构与本机不一致，未创建副本。", 503)
                            db.execute("INSERT INTO threads (" + ",".join('"' + c + '"' for c in columns) +
                                       ") VALUES (" + ",".join("?" for _ in columns) + ")", [row[c] for c in columns])
                            for table, rows in projected.items():
                                names = [r["name"] for r in db.execute(f'PRAGMA history.table_info("{table}")')]
                                for values in rows:
                                    if set(names) != set(values):
                                        raise StoreError("历史索引结构不一致，未创建副本。", 503)
                                    db.execute(f'INSERT INTO history."{table}" (' +
                                               ",".join('"' + c + '"' for c in names) + ") VALUES (" +
                                               ",".join("?" for _ in names) + ")", [values[c] for c in names])
                            if destination.exists():
                                raise StoreError("副本路径已经存在，拒绝覆盖。", 409)
                            created_file = True
                            atomic_write(destination, source)
                            db.commit()
                        except Exception:
                            db.rollback()
                            if created_file and destination.exists() and destination.read_bytes() == source:
                                destination.unlink()
                            journal["status"] = "rolled_back"
                            store.write_journal(install, journal)
                            raise
                    journal["status"] = "committed"
                    try:
                        store.write_journal(install, journal)
                    except OSError:
                        store.blocked.add(new_id)
                        raise StoreError(f"副本已创建，但恢复日志未完成，请检查 {install}", 500)
                    return {"threadId": new_id, "title": row["name"], "backupId": backup["backupId"],
                            "backupPath": backup["backupPath"], "path": str(destination),
                            "mode": mode, "selectedTurns": plan["selectedTurns"],
                            "toolCalls": plan["selectedToolCalls"] if mode == "conversation" else 0,
                            "fileBytes": len(source), "textBytes": len(handoff.encode("utf-8"))}
