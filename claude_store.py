"""Claude Code JSONL editing, with independent backups and no model invocations."""

import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import uuid

from store import StoreError, atomic_write, encode, fingerprint, jsonl_lines
from backup_management import backup_deletable, backup_title, delete_backup as delete_backup_directory


UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
MAX_BYTES = 180 * 1024 * 1024
REQUEST_CACHE = {"api-request", "api-request-shape", "api-request-blob"}


def message_content(record):
    message = record.get("message")
    return message.get("content") if isinstance(message, dict) else None


def text(record):
    content = message_content(record)
    if isinstance(content, str):
        return content
    return "\n".join(part["text"] for part in content if isinstance(part, dict)
                     and part.get("type") == "text" and isinstance(part.get("text"), str)) if isinstance(content, list) else ""


def human(record):
    return record.get("type") == "user" and not record.get("isMeta") and not record.get("isSidechain") and bool(text(record).strip())


def serialize(records):
    return "".join(encode(record) + "\n" for record in records).encode("utf-8")


def parse(source, session_id):
    if not isinstance(source, str) or not source.strip() or source.startswith("\ufeff"):
        raise StoreError("需要无 BOM 的非空 Claude JSONL。")
    records, seen = [], set()
    for number, line in enumerate(jsonl_lines(source), 1):
        try:
            record = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("非有限数值")))
        except ValueError as error:
            raise StoreError(f"Claude 第 {number} 行不是有效 JSON：{error}")
        if not isinstance(record, dict) or not isinstance(record.get("type"), str):
            raise StoreError(f"Claude 第 {number} 行必须是带 type 的记录。")
        if record.get("sessionId") not in (None, session_id):
            raise StoreError(f"Claude 第 {number} 行属于另一条会话。")
        identifier = record.get("uuid")
        if identifier is not None:
            if not isinstance(identifier, str) or not UUID.fullmatch(identifier) or identifier in seen:
                raise StoreError(f"Claude 第 {number} 行 uuid 无效或重复。")
            seen.add(identifier)
        parent = record.get("parentUuid")
        if parent is not None and (not isinstance(parent, str) or not UUID.fullmatch(parent)):
            raise StoreError(f"Claude 第 {number} 行 parentUuid 无效。")
        if record["type"] in ("user", "assistant"):
            if "cwd" in record and not isinstance(record["cwd"], str):
                raise StoreError(f"Claude 第 {number} 行 cwd 必须为字符串。")
            message = record.get("message")
            if not identifier or not isinstance(message, dict) or message.get("role") != record["type"]:
                raise StoreError(f"Claude 第 {number} 行消息身份无效。")
            content = message.get("content")
            if not isinstance(content, (str, list)):
                raise StoreError(f"Claude 第 {number} 行 content 必须为文本或内容块数组。")
            if isinstance(content, list) and any(not isinstance(part, dict) or
                                                not isinstance(part.get("type"), str) for part in content):
                raise StoreError(f"Claude 第 {number} 行包含无效内容块。")
            for part in content if isinstance(content, list) else []:
                if part["type"] == "text" and not isinstance(part.get("text"), str):
                    raise StoreError(f"Claude 第 {number} 行文本块必须为字符串。")
                if part["type"] == "tool_result" and (record["type"] != "user" or
                        not isinstance(part.get("tool_use_id"), str)):
                    raise StoreError(f"Claude 第 {number} 行工具返回结构无效。")
                if part["type"] == "tool_use" and record["type"] != "assistant":
                    raise StoreError(f"Claude 第 {number} 行工具调用必须属于助手。")
        records.append(record)
    return records


def prepare(source, original, session_id, signed_source=None):
    records, before = parse(source, session_id), parse(original, session_id)
    old = {r["uuid"]: r for r in before if r.get("uuid")}
    kept = {r["uuid"] for r in records if r.get("uuid")}
    removed = set(old) - kept
    protected = set()
    for record in before + (signed_source or []):
        content = message_content(record)
        for part in content if isinstance(content, list) else []:
            if isinstance(part, dict) and part.get("type") in ("thinking", "redacted_thinking"):
                protected.add(encode(part))
    calls, old_calls = set(), set()
    for collection, target in ((before, old_calls), (records, calls)):
        for record in collection:
            if record["type"] not in ("user", "assistant"):
                continue
            content = message_content(record)
            for part in content if isinstance(content, list) else []:
                if part.get("type") == "tool_use":
                    identifier = part.get("id")
                    if not isinstance(identifier, str) or not identifier:
                        raise StoreError("Claude 工具调用 ID 无效。")
                    target.add(identifier)
    candidates = {r["uuid"]: r for r in records if r.get("uuid")}
    def has_call(parent, call_id):
        visited = set()
        while parent:
            if parent in visited:
                raise StoreError("Claude 消息链存在循环。")
            visited.add(parent)
            item = candidates.get(parent) if parent in kept else old.get(parent)
            if item is None:
                return False
            content = message_content(item)
            if parent in kept and isinstance(content, list) and any(
                    isinstance(p, dict) and p.get("type") == "tool_use" and p.get("id") == call_id for p in content):
                return True
            parent = item.get("parentUuid")
        return False
    changes, output = 0, []
    for record in records:
        content = message_content(record)
        if isinstance(content, list) and any(isinstance(part, dict) and part.get("type") in ("thinking", "redacted_thinking") and
                                             encode(part) not in protected for part in content):
            raise StoreError("不能新增或伪造签名思考块。")
        identifier = record.get("uuid")
        previous = old.get(identifier)
        if previous:
            if record["type"] != previous["type"]:
                raise StoreError("不能更改已有 Claude 记录的角色类型。")
            old_content = message_content(previous)
            content = message_content(record)
            signed = lambda value: [p for p in value if isinstance(p, dict) and p.get("type") in ("thinking", "redacted_thinking")] if isinstance(value, list) else []
            if signed(old_content) != signed(content):
                raise StoreError("不能改写或移除保留消息中的签名思考块；可删除整条记录。")
        if record["type"] in REQUEST_CACHE or record["type"] == "last-prompt":
            changes += 1
            continue
        if removed and record["type"] in ("file-history-snapshot", "file-history-delta"):
            changes += 1
            continue
        if any(isinstance(record.get(key), str) and record[key] in removed for key in ("messageId", "commandUuid")):
            changes += 1
            continue
        if record["type"] in ("user", "assistant"):
            for key in ("requestRef", "apiBlockIndex"):
                if key in record:
                    del record[key]
                    changes += 1
            content = record["message"]["content"]
            if isinstance(content, list):
                filtered = []
                for part in content:
                    if part.get("type") == "tool_result" and not has_call(
                            record.get("parentUuid"), part.get("tool_use_id")):
                        if part.get("tool_use_id") not in old_calls:
                            raise StoreError("Claude 工具返回值没有对应的工具调用。")
                        changes += 1
                    else:
                        filtered.append(part)
                record["message"]["content"] = filtered
                if content and not filtered:
                    if identifier:
                        removed.add(identifier)
                        kept.discard(identifier)
                    continue
        output.append(record)
    def ancestor(parent):
        visited = set()
        while parent in removed:
            if parent in visited:
                raise StoreError("Claude 原始消息链存在循环。")
            visited.add(parent)
            parent = old.get(parent, {}).get("parentUuid")
        return parent
    seen = set()
    for record in output:
        if "parentUuid" in record:
            parent = ancestor(record["parentUuid"])
            if parent is not None and parent not in seen:
                raise StoreError("Claude parentUuid 指向不存在或后续的记录，不能保存。")
            if parent != record["parentUuid"]:
                record["parentUuid"] = parent
                changes += 1
        if isinstance(record.get("leafUuid"), str) and record["leafUuid"] in removed:
            record["leafUuid"] = ancestor(record["leafUuid"])
        if record.get("uuid"):
            seen.add(record["uuid"])
    prompts = [record for record in output if human(record)]
    leaf = next((r["uuid"] for r in reversed(output) if r.get("uuid")), None)
    if prompts and leaf:
        output.append({"type": "last-prompt", "sessionId": session_id,
                       "lastPrompt": text(prompts[-1]), "leafUuid": leaf})
    return output, before, changes


class ClaudeStore:
    def __init__(self, home=None, check_processes=True):
        self.home = Path(home or os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude")).expanduser().resolve()
        self.projects = self.home / "projects"
        self.recovery_root = self.home / "backups" / "chat-sync-workbench"
        self.snapshots, self.catalog_cache = {}, {}
        self.mutex = threading.RLock()
        self.check_processes = check_processes

    def owned(self, path):
        resolved = Path(path).resolve()
        if not resolved.is_relative_to(self.home):
            raise StoreError("Claude 文件不在当前配置目录内。", 403)
        return resolved

    def read(self, path):
        path = self.owned(path)
        if not path.exists():
            return None
        if not path.is_file() or path.stat().st_size > MAX_BYTES:
            raise StoreError("Claude 文件不是普通文件或超过 180 MiB。")
        return path.read_bytes()

    def session(self, identifier):
        if not isinstance(identifier, str):
            raise StoreError("Claude 会话 ID 无效。")
        parts = identifier.split("/")
        if len(parts) != 2 or parts[0] in ("", ".", "..") or not UUID.fullmatch(parts[1]):
            raise StoreError("Claude 会话 ID 无效。")
        path = self.owned(self.projects / parts[0] / (parts[1] + ".jsonl"))
        if path.parent.parent != self.projects or not path.is_file():
            raise StoreError("Claude 会话不存在。", 404)
        return path, parts[1]

    def metadata(self, identifier, path, records):
        prompts = [r for r in records if human(r)]
        custom, generated = "", ""
        for record in records:
            if record.get("type") == "custom-title" and isinstance(record.get("customTitle"), str):
                custom = record["customTitle"]
            if record.get("type") == "ai-title" and isinstance(record.get("aiTitle"), str):
                generated = record["aiTitle"]
        title = custom or generated
        hint, original_path = {}, None
        try:
            raw = self.read(path.parent / "sessions-index.json")
            index = json.loads(raw) if raw else {}
            if isinstance(index, dict):
                hint = next((r for r in index.get("entries", []) if isinstance(r, dict) and
                             r.get("sessionId") == path.stem), {})
                original_path = index.get("originalPath")
        except (ValueError, StoreError):
            pass
        title = title or hint.get("summary")
        cwd = next((r["cwd"] for r in records if isinstance(r.get("cwd"), str)),
                   hint.get("projectPath") or original_path or path.parent.name)
        if not isinstance(cwd, str):
            cwd = path.parent.name
        return {"id": identifier, "sessionId": path.stem, "cwd": cwd,
                "name": str(title or (text(prompts[0]) if prompts else path.stem)).strip()[:160],
                "title": str(title or (text(prompts[0]) if prompts else path.stem)).strip()[:160],
                "messageCount": sum(r["type"] in ("user", "assistant") for r in records)}

    def sidebar(self, query="", group_key=None, offset=0, limit=5, project_key=None):
        groups = {}
        for path in self.projects.glob("*/*.jsonl"):
            if not UUID.fullmatch(path.stem):
                continue
            identifier = path.parent.name + "/" + path.stem
            path, session_id = self.session(identifier)
            key = "claude:" + path.parent.name
            if project_key and key != project_key:
                continue
            stamp = (path.stat().st_mtime_ns, path.stat().st_size)
            cached = self.catalog_cache.get(path)
            if not cached or cached[0] != stamp:
                try:
                    info = self.metadata(identifier, path, parse(self.read(path).decode("utf-8"), session_id))
                except (StoreError, UnicodeError):
                    info = {"name": session_id, "cwd": path.parent.name}
                self.catalog_cache[path] = (stamp, info)
            else:
                info = cached[1]
            name = Path(info["cwd"]).name or info["cwd"]
            if query.casefold() not in " ".join((info["name"], identifier, info["cwd"], name)).casefold():
                continue
            group = groups.setdefault(key, {"key": key, "name": name, "threads": []})
            group["threads"].append({"id": identifier, "title": " ".join(info["name"].split()),
                                     "_mtime": stamp[0]})
        ordered = sorted(groups.values(), key=lambda g: g["name"].casefold())
        for group in ordered:
            group["threads"].sort(key=lambda row: (-row["_mtime"], row["id"]))
            for row in group["threads"]:
                del row["_mtime"]
            group["total"] = len(group["threads"])
        if group_key is not None:
            if group_key not in groups:
                raise StoreError("Claude 项目不存在。", 404)
            group = groups[group_key]
            rows = group["threads"][offset:offset + limit]
            return {"key": group_key, "rows": rows, "total": group["total"],
                    "nextOffset": offset + len(rows), "hasMore": offset + len(rows) < group["total"]}
        total = sum(g["total"] for g in ordered)
        for group in ordered:
            group["threads"] = group["threads"][:limit]
            group["nextOffset"] = len(group["threads"])
        return {"groups": ordered, "total": total}

    def files(self, path):
        return [path, self.owned(path.parent / "sessions-index.json"), self.owned(self.home / "history.jsonl")]

    def open(self, identifier):
        with self.mutex:
            path, session_id = self.session(identifier)
            data = {p: self.read(p) for p in self.files(path)}
            records = parse(data[path].decode("utf-8"), session_id)
            version = uuid.uuid4().hex
            info = self.metadata(identifier, path, records)
            self.snapshots[version] = {"id": identifier, "path": path, "metadata": info,
                "hashes": {str(p): fingerprint(raw) if raw is not None else None for p, raw in data.items()}}
            if len(self.snapshots) > 100:
                self.snapshots.pop(next(iter(self.snapshots)))
            return {"source": data[path].decode("utf-8"), "version": version, "name": path.name,
                    "inherited": [], "info": self.info(path, info, records)}

    def info(self, path, metadata, records):
        return {"metadata": metadata, "path": str(path), "fileBytes": path.stat().st_size,
                "health": "ready", "counts": {"messages": metadata["messageCount"], "records": len(records)},
                "projection": None, "historyBase": None, "blocked": False, "provider": "claude"}

    def inspect(self, identifier):
        return self.open(identifier)["info"]

    def active(self):
        for marker in (self.home / "sessions").glob("*.json"):
            if not marker.stem.isdigit():
                continue
            try:
                data = json.loads(self.read(marker))
                pid = data.get("pid")
                if isinstance(pid, int) and pid > 0:
                    try:
                        os.kill(pid, 0)
                        return True
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        return True
            except (ValueError, TypeError, OSError):
                raise StoreError("Claude 活动会话标记不可读，拒绝写入。", 409)
        if self.check_processes:
            try:
                result = subprocess.run(["ps", "-axo", "comm=,args="], capture_output=True, timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                raise StoreError("无法检查 Claude 进程，拒绝写入。", 503)
            if result.returncode:
                raise StoreError("无法检查 Claude 进程，拒绝写入。", 503)
            # OS process arguments need not be valid UTF-8, unlike conversation files.
            if any(re.search(r"(?:^|/)claude(?:\s|$)|/claude/versions/|@anthropic-ai/claude-code/cli\.js", line)
                   for line in os.fsdecode(result.stdout).splitlines()):
                return True
        return False

    def assert_inactive(self):
        if self.active():
            raise StoreError("检测到 Claude Code 仍在运行。输入历史为共享文件，请退出 Claude Code 后再保存。",
                             409, code="writer_locked")

    @contextlib.contextmanager
    def writer(self):
        self.home.mkdir(parents=True, exist_ok=True)
        with (self.home / ".history-manager.lock").open("a+b") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise StoreError("Claude 历史正在被本工具修改，请稍后重试。", 409)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def baseline(self, identifier, version):
        value = self.snapshots.get(version)
        if not value or value["id"] != identifier:
            raise StoreError("Claude 编辑快照已失效，请重新读取。", 409)
        return value

    def check(self, originals):
        for path, expected in originals.items():
            if self.read(path) != expected:
                raise StoreError("Claude 文件已被外部修改，请重新读取后再保存。", 409)

    def check_recovery(self, identifier):
        for path in self.recovery_root.glob("*/journal.json"):
            try:
                entry = json.loads(self.read(path))
            except (ValueError, OSError, TypeError):
                raise StoreError("Claude 备份日志损坏，检查后才能继续写入。", 409)
            if entry.get("threadId") == identifier and entry.get("status") in ("prepared", "recovery_required"):
                raise StoreError("Claude 会话有未完成的保存日志，检查备份后才能继续写入。", 409)

    def backup_data(self, identifier, originals, kind="manual"):
        name = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:12]
        directory = self.recovery_root / name
        directory.mkdir(parents=True, mode=0o700)
        manifest = {"threadId": identifier, "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "status": "snapshot", "kind": kind, "files": []}
        for number, (path, data) in enumerate(originals.items()):
            filename = f"before-{number}.bin"
            if data is not None:
                atomic_write(directory / filename, data)
            manifest["files"].append({"path": str(path.relative_to(self.home)), "file": filename,
                                     "hash": fingerprint(data) if data is not None else None})
        atomic_write(directory / "journal.json", encode(manifest).encode())
        return directory, manifest

    def backup(self, identifier):
        with self.mutex, self.writer():
            path, _ = self.session(identifier)
            originals = {p: self.read(p) for p in self.files(path)}
            directory, manifest = self.backup_data(identifier, originals)
            try:
                self.check(originals)
            except Exception:
                manifest["status"] = "snapshot_failed"
                atomic_write(directory / "journal.json", encode(manifest).encode())
                raise
            return {**manifest, "backupId": directory.name, "backupPath": str(directory)}

    def backups(self, identifier=None):
        rows = []
        for path in self.recovery_root.glob("*/journal.json"):
            if path.parent.is_symlink() or path.is_symlink():
                continue
            try:
                entry = json.loads(self.read(path))
                if not isinstance(entry, dict) or entry.get("kind") == "copy" or identifier and entry.get("threadId") != identifier:
                    continue
                snapshot = path.parent / "before-0.bin"
                rows.append({**entry, "backupId": path.parent.name, "backupPath": str(path.parent),
                             "title": backup_title(snapshot, entry.get("threadId"), entry.get("cwd", "")),
                             "fileBytes": snapshot.stat().st_size if snapshot.is_file() else 0,
                             "deletable": backup_deletable(entry),
                             "restorable": entry.get("status") in ("snapshot", "committed", "rolled_back") and snapshot.is_file()})
            except (OSError, ValueError, TypeError, StoreError):
                continue
        return {"rows": sorted(rows, key=lambda row: row["backupId"], reverse=True)}

    def delete_backup(self, backup_id):
        with self.mutex:
            return delete_backup_directory(self.recovery_root, backup_id)

    def sidecars(self, path, session_id, records, before, originals):
        index_path, history_path = self.files(path)[1:]
        changes = {}
        info = self.metadata(path.parent.name + "/" + session_id, path, records)
        if originals[index_path] is not None:
            index = json.loads(originals[index_path])
            if (not isinstance(index, dict) or not isinstance(index.get("entries"), list)
                    or any(not isinstance(row, dict) for row in index["entries"])):
                raise StoreError("Claude sessions-index.json 结构不支持，未写入。")
            for row in index["entries"]:
                if row.get("sessionId") == session_id:
                    row.update(fullPath=str(path), firstPrompt=next((text(r) for r in records if human(r)), "")[:200],
                               messageCount=info["messageCount"], modified=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                               fileMtime=int(datetime.datetime.now().timestamp() * 1000))
            changes[index_path] = (json.dumps(index, ensure_ascii=False, indent=2) + "\n").encode()
        if originals[history_path] is not None:
            history = [json.loads(line) for line in jsonl_lines(originals[history_path].decode("utf-8"))]
            if any(not isinstance(row, dict) for row in history):
                raise StoreError("Claude 输入历史结构不支持，未写入。")
            prompts = {}
            after = {r["uuid"]: r for r in records if human(r)}
            for record in before:
                if human(record):
                    prompts.setdefault((record.get("cwd") or info["cwd"], text(record).strip()), []).append(record["uuid"])
            result = []
            for row in history:
                candidates = prompts.get((row.get("project"), str(row.get("display", "")).strip()), [])
                if row.get("sessionId") == session_id and candidates:
                    identifier = candidates.pop(0)
                    if identifier not in after:
                        continue
                    replacement = text(after[identifier])
                    if replacement != row["display"]:
                        row["display"] = replacement
                        row["pastedContents"] = {}
                result.append(row)
            changes[history_path] = serialize(result)
        return changes

    def save(self, identifier, version, source, mirror=True, _restore_history=None, _signed_source=None):
        with self.mutex, self.writer():
            snap = self.baseline(identifier, version)
            self.check_recovery(identifier)
            self.assert_inactive()
            path, session_id = self.session(identifier)
            originals = {p: self.read(p) for p in self.files(path)}
            if any((fingerprint(data) if data is not None else None) != snap["hashes"].get(str(p))
                   for p, data in originals.items()):
                raise StoreError("Claude 文件已被外部修改，请重新读取后再保存。", 409)
            records, before, repaired = prepare(source, originals[path].decode("utf-8"), session_id,
                                               signed_source=_signed_source)
            data = serialize(records)
            if len(data) > MAX_BYTES:
                raise StoreError("Claude 会话超过 180 MiB。")
            updates = {path: data, **self.sidecars(path, session_id, records, before, originals)}
            if _restore_history is not None:
                history_path = self.files(path)[2]
                current = [json.loads(line) for line in jsonl_lines((originals[history_path] or b"").decode())]
                projects = {snap["metadata"]["cwd"], *(r.get("cwd") or snap["metadata"]["cwd"]
                            for r in records + before if human(r))}
                selected = lambda row: row.get("sessionId") == session_id and row.get("project") in projects
                restored = [row for row in _restore_history if selected(row)]
                other = [row for row in current if not selected(row)]
                stamp = lambda row: row.get("timestamp") if isinstance(row.get("timestamp"), (int, float)) else 0
                restored.sort(key=stamp)
                merged, cursor = [], 0
                for row in other:
                    while cursor < len(restored) and stamp(restored[cursor]) <= stamp(row):
                        merged.append(restored[cursor])
                        cursor += 1
                    merged.append(row)
                merged.extend(restored[cursor:])
                updates[history_path] = serialize(merged)
            directory, manifest = self.backup_data(identifier, originals, "save")
            self.check(originals)
            self.assert_inactive()
            manifest["status"] = "prepared"
            atomic_write(directory / "journal.json", encode(manifest).encode())
            written = []
            try:
                for target, value in updates.items():
                    self.check({p: old for p, old in originals.items() if p not in written})
                    written.append(target)
                    atomic_write(target, value)
                manifest["status"] = "committed"
                atomic_write(directory / "journal.json", encode(manifest).encode())
            except Exception:
                for target in reversed(written):
                    current = self.read(target)
                    if current == originals[target]:
                        continue
                    if current != updates[target]:
                        manifest["status"] = "recovery_required"
                        atomic_write(directory / "journal.json", encode(manifest).encode())
                        raise StoreError(f"Claude 文件在回滚前发生变化，请检查备份：{directory}", 409)
                    try:
                        if originals[target] is None:
                            target.unlink()
                        else:
                            atomic_write(target, originals[target])
                    except OSError:
                        manifest["status"] = "recovery_required"
                        atomic_write(directory / "journal.json", encode(manifest).encode())
                        raise StoreError(f"Claude 自动回滚未完成，请检查备份：{directory}", 500)
                manifest["status"] = "rolled_back"
                atomic_write(directory / "journal.json", encode(manifest).encode())
                raise
            self.snapshots.pop(version, None)
            result = self.open(identifier)
            return {**result, "backup": str(directory), "linkedChanges": repaired}

    def restore(self, identifier, version, backup_id):
        if not isinstance(backup_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", backup_id):
            raise StoreError("Claude 备份 ID 无效。")
        directory = self.owned(self.recovery_root / backup_id)
        manifest = json.loads(self.read(directory / "journal.json") or b"{}")
        if manifest.get("threadId") != identifier or manifest.get("status") not in ("snapshot", "committed", "rolled_back"):
            raise StoreError("Claude 备份不属于当前会话或未完成。")
        file = manifest["files"][0]
        if file["file"] != "before-0.bin":
            raise StoreError("Claude 备份文件名无效。")
        data = self.read(directory / file["file"])
        if data is None or fingerprint(data) != file["hash"]:
            raise StoreError("Claude 备份校验失败。")
        history = None
        if len(manifest["files"]) > 2:
            item = manifest["files"][2]
            if item["path"] != "history.jsonl" or item["file"] != "before-2.bin":
                raise StoreError("Claude 备份的输入历史标识无效。")
            history = []
            if item["hash"] is not None:
                raw = self.read(directory / item["file"])
                if raw is None or fingerprint(raw) != item["hash"]:
                    raise StoreError("Claude 输入历史备份校验失败。")
                history = [json.loads(line) for line in jsonl_lines(raw.decode())]
                if any(not isinstance(row, dict) for row in history):
                    raise StoreError("Claude 输入历史备份格式无效。")
        session_id = identifier.split("/")[-1]
        return self.save(identifier, version, data.decode("utf-8"), _restore_history=history,
                         _signed_source=parse(data.decode("utf-8"), session_id))

    def create_edited_copy(self, identifier, version, source, baseline_source, mirror=True):
        with self.mutex, self.writer():
            snap = self.baseline(identifier, version)
            if not isinstance(baseline_source, str) or fingerprint(baseline_source.encode()) != snap["hashes"][str(snap["path"])]:
                raise StoreError("Claude 原始编辑快照校验失败。", 409)
            session_id = snap["metadata"]["sessionId"]
            records, _, repaired = prepare(source, baseline_source, session_id)
            new_id = str(uuid.uuid4())
            records = [r for r in records if r["type"] not in ("file-history-snapshot", "file-history-delta")]
            for record in records:
                for key in ("sessionId", "session_id"):
                    if key in record and (key == "sessionId" or record[key] == session_id):
                        record[key] = new_id
            title = snap["metadata"]["name"] + " · 编辑副本"
            records.append({"type": "custom-title", "sessionId": new_id, "customTitle": title})
            destination = self.owned(snap["path"].parent / (new_id + ".jsonl"))
            data = serialize(records)
            if len(data) > MAX_BYTES or destination.exists():
                raise StoreError("Claude 副本过大或目标文件已存在。")
            directory, manifest = self.backup_data(identifier, {snap["path"]: baseline_source.encode()}, "copy")
            atomic_write(directory / "draft.jsonl", source.encode())
            atomic_write(destination, data)
            new_identifier = destination.parent.name + "/" + new_id
            return {"threadId": new_identifier, "title": title, "path": str(destination),
                    "backupPath": str(directory), "linkedChanges": repaired,
                    "resumeCommand": "claude --resume " + new_id}
