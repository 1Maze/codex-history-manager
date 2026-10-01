"""Local Codex JSONL and SQLite synchronization; no model requests are made."""

import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid


HISTORY_TABLES = (
    "thread_turns", "thread_items", "thread_realtime_items",
    "thread_history_projection_state",
)


class StoreError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def connect(path, readonly=False):
    db = sqlite3.connect(path.as_uri() + ("?mode=ro" if readonly else "?mode=rw"),
                         uri=True, timeout=5, factory=ClosingConnection)
    db.row_factory = sqlite3.Row
    return db


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def fingerprint(data):
    return hashlib.sha256(data).hexdigest()


def jsonl_lines(source):
    parts = source.split("\n")
    if parts[-1] == "":
        parts.pop()
        return [part + "\n" for part in parts]
    return [part + "\n" for part in parts[:-1]] + parts[-1:]


def message_reference(record):
    payload = record.get("payload", {})
    message = payload.get("item") if record.get("type") == "event_msg" else payload
    if not isinstance(message, dict):
        return None
    if record.get("type") == "event_msg" and message.get("type") in ("AgentMessage", "UserMessage"):
        role = "assistant" if message["type"] == "AgentMessage" else "user"
    elif record.get("type") == "response_item" and message.get("type") == "message":
        role = message.get("role")
    else:
        return None
    content = message.get("content")
    if not message.get("id") or not isinstance(content, list) or len(content) != 1:
        return None
    if not isinstance(content[0], dict) or not isinstance(content[0].get("text"), str):
        return None
    return (message["id"], role), content[0]


def assistant_summary_references(records):
    current_turn = ""
    last = {}
    links = {}
    for index, record in enumerate(records):
        payload = record.get("payload", {})
        if record.get("type") == "event_msg" and payload.get("type") == "task_started":
            current_turn = payload.get("turn_id", "")
        turn = payload.get("turn_id") or payload.get(
            "internal_chat_message_metadata_passthrough", {}).get("turn_id") or current_turn
        reference = message_reference(record)
        if (reference and reference[0][1] == "assistant" and reference[1]["text"].strip()
                and payload.get("type") != "item_started"
                and payload.get("channel") != "analysis"):
            last[turn] = (reference[0], reference[1]["text"])
        if (record.get("type") == "event_msg" and payload.get("type") == "task_complete"
                and isinstance(payload.get("last_agent_message"), str) and turn in last):
            key, text = last[turn]
            if payload["last_agent_message"].strip() == text.strip():
                links[turn] = (key, payload["last_agent_message"])
    return links


def linked_messages(source, original):
    """Mirror changed/deleted plain-text messages across their persisted representations."""
    old = {}
    original_records = [json.loads(line) for line in jsonl_lines(original)]
    summary_links = assistant_summary_references(original_records)
    for record in original_records:
        reference = message_reference(record)
        if reference:
            key, content = reference
            old.setdefault(key, []).append(content["text"])
    lines = jsonl_lines(source)
    records = [json.loads(line) for line in lines]
    groups = {}
    for index, record in enumerate(records):
        reference = message_reference(record)
        if reference:
            key, content = reference
            groups.setdefault(key, []).append((index, content))
    modified = set()
    deleted = set()
    changed_texts = {}
    for key, original_texts in old.items():
        current = groups.get(key, [])
        if len(current) < len(original_texts):
            deleted.update(index for index, _ in current)
            continue
        changes = {content["text"] for _, content in current if content["text"] not in original_texts}
        if len(changes) > 1:
            raise StoreError(f"消息 {key[0]} 的多个副本文本冲突，请先统一文本。")
        if changes:
            text = changes.pop()
            changed_texts[key] = text
            for index, content in current:
                if content["text"] != text:
                    content["text"] = text
                    modified.add(index)
    for index, record in enumerate(records):
        payload = record.get("payload", {})
        if record.get("type") != "event_msg" or payload.get("type") != "task_complete":
            continue
        link = summary_links.get(payload.get("turn_id", ""))
        if not link or link[0] not in changed_texts:
            continue
        text = changed_texts[link[0]]
        if payload.get("last_agent_message") == link[1]:
            payload["last_agent_message"] = text
            modified.add(index)
        elif payload.get("last_agent_message") != text:
            raise StoreError("完成事件摘要与消息修改冲突，请先确认关联文本。")
    result = []
    for index, record in enumerate(records):
        if index in deleted:
            continue
        if index in modified:
            ending = "\r\n" if lines[index].endswith("\r\n") else "\n"
            result.append(encode(record) + ending)
        else:
            result.append(lines[index])
    return "".join(result), len(modified) + len(deleted)


def backup_database(source, destination):
    with connect(source, True) as src, sqlite3.connect(destination, factory=ClosingConnection) as dst:
        src.backup(dst)


def atomic_write(path, data, mode=0o600):
    fd, name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class NativeParser:
    def __init__(self, binary=None):
        bundled = Path("/Applications/Codex.app/Contents/Resources/codex")
        self.binary = binary or shutil.which("codex") or (
            str(bundled) if bundled.exists() else None)

    def project(self, home, thread_id):
        if not self.binary:
            raise StoreError("找不到 Codex CLI；未修改原文件。", 503)
        env = dict(os.environ, CODEX_HOME=str(home))
        # An isolated home has no login, plugins, or model credentials.
        with tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen(
                [self.binary, "-c", "sqlite_home=" + json.dumps(str(home)),
                 "--enable", "transcript_v2", "app-server", "--stdio"], env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                text=True, encoding="utf-8",
            )
            replies = queue.Queue()

            def consume():
                try:
                    for line in process.stdout:
                        replies.put(json.loads(line))
                except Exception as error:
                    replies.put(error)
                finally:
                    replies.put(None)

            reader = threading.Thread(target=consume, daemon=True)
            reader.start()

            def send(message):
                process.stdin.write(encode(message) + "\n")
                process.stdin.flush()

            def request(number, method, params):
                send({"id": number, "method": method, "params": params})
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    try:
                        reply = replies.get(timeout=max(.01, deadline - time.monotonic()))
                    except queue.Empty:
                        break
                    if reply is None or isinstance(reply, Exception):
                        break
                    if reply.get("id") == number:
                        if "error" in reply:
                            raise StoreError("Codex 校验失败：" +
                                             reply["error"].get("message", encode(reply["error"])))
                        return reply.get("result")
                    if "id" in reply and "method" in reply:
                        send({"id": reply["id"], "error": {
                            "code": -32601, "message": "Offline parser does not allow external actions"}})
                raise StoreError("Codex 本地解析超时或退出，未修改原文件。", 503)

            try:
                request(1, "initialize", {
                    "clientInfo": {"name": "local_chat_sync", "version": "1.0"},
                    "capabilities": {"experimentalApi": True,
                                     "explicitGatewayOauth": True},
                })
                send({"method": "initialized", "params": {}})
                # Fork preparation performs a full durable projection, unlike list/read.
                # This child exists exclusively in the temporary home and is discarded.
                result = request(2, "thread/fork", {
                    "threadId": thread_id, "excludeTurns": True, "ephemeral": True,
                    "cwd": str(home), "modelProvider": "openai", "sandbox": "read-only",
                    "config": {"features.hooks": False, "features.plugins": False,
                               "features.shell_snapshot": False},
                })
                return {"keys": list(result)}
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                reader.join(timeout=5)
                process.stdin.close()
                process.stdout.close()


class ChatStore:
    def __init__(self, home=None, parser=None):
        self.home = Path(home or os.environ.get("CODEX_HOME", "~/.codex")).expanduser().resolve()
        self.state_db = self.home / "state_5.sqlite"
        self.history_db = self.home / "thread_history_1.sqlite"
        self.parser = parser or NativeParser()
        self.mutex = threading.RLock()
        self.snapshots = {}
        self.blocked = set()
        if not self.state_db.is_file() or not self.history_db.is_file():
            raise StoreError("目录中缺少 state_5.sqlite 或 thread_history_1.sqlite。")
        self.recovery_root = self.home / "backups" / "chat-sync-workbench"
        if self.recovery_root.exists():
            for journal in self.recovery_root.glob("*/journal.json"):
                try:
                    entry = json.loads(journal.read_text("utf-8"))
                    if entry.get("status") in ("prepared", "file_replaced", "recovery_required"):
                        self.blocked.add(entry["threadId"])
                except (ValueError, OSError, KeyError):
                    raise StoreError("发现不可读的同步恢复记录；请先检查备份目录。", 503)

    def thread(self, thread_id):
        with connect(self.state_db, True) as db:
            row = db.execute("SELECT * FROM threads WHERE id=?", (thread_id,)).fetchone()
        if row is None:
            raise StoreError("聊天不存在。", 404)
        path = Path(row["rollout_path"]).expanduser().resolve()
        if not any(path.is_relative_to((self.home / directory).resolve())
                   for directory in ("sessions", "archived_sessions")):
            raise StoreError("聊天记录不在当前 Codex 的 sessions 目录内。")
        if not path.is_file():
            raise StoreError("聊天记录文件不存在。", 404)
        return dict(row), path

    def threads(self, query="", offset=0, limit=60):
        with connect(self.state_db, True) as db:
            predicate = "(title LIKE ? OR id LIKE ? OR cwd LIKE ?)"
            pattern = "%" + query + "%"
            count = db.execute("SELECT count(*) FROM threads WHERE " + predicate,
                               (pattern,) * 3).fetchone()[0]
            rows = db.execute(
                "SELECT id,title,cwd,rollout_path,archived,updated_at,history_mode "
                "FROM threads WHERE " + predicate +
                " ORDER BY recency_at_ms DESC,id LIMIT ? OFFSET ?",
                (pattern,) * 3 + (limit, offset),
            ).fetchall()
        return {"rows": [dict(row) for row in rows], "total": count,
                "offset": offset, "limit": limit}

    def sidebar(self, query="", group_key=None, offset=0, limit=5, project_key=None):
        with connect(self.state_db, True) as db:
            rows = db.execute(
                "SELECT t.id,COALESCE(NULLIF(t.name,''),t.title) AS title,t.cwd,"
                "t.project_id,t.archived,p.name AS project_name,p.position AS project_position "
                "FROM threads t LEFT JOIN projects p ON p.id=t.project_id "
                "ORDER BY t.recency_at_ms DESC,t.id"
            ).fetchall()
        groups = {}
        scratch = Path.home() / "Documents" / "Codex"
        total = 0
        needle = query.strip().casefold()
        for row in rows:
            if row["archived"]:
                key, name, order = "archived", "归档", (2, 0, "")
            elif row["project_name"]:
                key, name = "project:" + row["project_id"], row["project_name"]
                order = (0, row["project_position"] or 0, name.casefold())
            elif row["cwd"] and not Path(row["cwd"]).is_relative_to(scratch):
                key, name = "cwd:" + row["cwd"], Path(row["cwd"]).name or row["cwd"]
                order = (0, 100000, name.casefold())
            else:
                key, name, order = "unassigned", "其他聊天", (1, 0, "")
            if project_key and key != project_key:
                continue
            if needle and not any(needle in str(value or "").casefold()
                                  for value in (row["title"], row["id"], row["cwd"], name)):
                continue
            group = groups.setdefault(key, {"key": key, "name": name, "order": order, "threads": []})
            title = " ".join((row["title"] or "未命名聊天").split())
            group["threads"].append({"id": row["id"], "title": title})
            total += 1
        ordered = sorted(groups.values(), key=lambda group: group["order"])
        if group_key is not None:
            group = groups.get(group_key)
            if not group:
                raise StoreError("项目分组不存在或不匹配当前搜索。", 404)
            rows = group["threads"][offset:offset + limit]
            next_offset = offset + len(rows)
            return {"key": group_key, "rows": rows, "total": len(group["threads"]),
                    "nextOffset": next_offset, "hasMore": next_offset < len(group["threads"])}
        for group in ordered:
            del group["order"]
            group["total"] = len(group["threads"])
            group["threads"] = group["threads"][:limit]
            group["nextOffset"] = len(group["threads"])
        return {"groups": ordered, "total": total}

    def history_rows(self, thread_id, db=None):
        if db is None:
            with connect(self.history_db, True) as connection:
                return self.history_rows(thread_id, connection)
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {
            table: [dict(row) for row in db.execute(
                f'SELECT * FROM "{table}" WHERE thread_id=? ORDER BY rowid', (thread_id,))]
            for table in HISTORY_TABLES if table in tables
        }

    def database_fingerprint(self, thread_id, db=None):
        return fingerprint(encode(self.history_rows(thread_id, db)).encode("utf-8"))

    def lineage(self, thread_id):
        _, path = self.thread(thread_id)
        with path.open("rb") as handle:
            meta = json.loads(handle.readline())["payload"]
        visited = {thread_id}
        parents = []
        while meta.get("history_base"):
            base = meta["history_base"]
            parent_id = base.get("thread_id")
            if parent_id in visited or len(parents) >= 16:
                raise StoreError("聊天继承链存在循环或超过 16 层。")
            visited.add(parent_id)
            _, parent_path = self.thread(parent_id)
            raw = parent_path.read_bytes()
            end = base.get("end_byte_offset", len(raw))
            if type(end) is not int or end < 0 or end > len(raw):
                raise StoreError("父聊天记录已缩短，当前分支的继承边界失效。", 409)
            meta = json.loads(raw.split(b"\n", 1)[0])["payload"]
            parents.append({"id": parent_id, "path": parent_path, "data": raw,
                            "prefixHash": fingerprint(raw[:end]), "end": end})
        return parents

    def lineage_fingerprint(self, thread_id):
        return fingerprint(encode([
            {"id": p["id"], "path": str(p["path"]), "prefixHash": p["prefixHash"], "end": p["end"]}
            for p in self.lineage(thread_id)
        ]).encode())

    def inspect(self, thread_id):
        metadata, path = self.thread(thread_id)
        with connect(self.history_db, True) as db:
            projection = db.execute(
                "SELECT * FROM thread_history_projection_state WHERE thread_id=?",
                (thread_id,)).fetchone()
            counts = {}
            for table in HISTORY_TABLES:
                counts[table] = db.execute(
                    f'SELECT count(*) FROM "{table}" WHERE thread_id=?', (thread_id,)).fetchone()[0]
        size = path.stat().st_size
        offset = projection["next_rollout_byte_offset"] if projection else None
        with path.open("rb") as handle:
            history_base = json.loads(handle.readline()).get("payload", {}).get("history_base")
        return {
            "metadata": metadata, "path": str(path), "fileBytes": size,
            "projection": dict(projection) if projection else None, "counts": counts,
            "health": "missing" if offset is None else
                      "ahead" if offset > size else "behind" if offset < size else "aligned",
            "blocked": thread_id in self.blocked,
            "historyBase": history_base,
        }

    def open(self, thread_id):
        with self.mutex:
            metadata, path = self.thread(thread_id)
            raw = path.read_bytes()
            if len(raw) > 180 * 1024 * 1024:
                raise StoreError("文件超过本地编辑器的 180 MiB 上限。")
            try:
                source = raw.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                raise StoreError("文件不是有效 UTF-8。")
            inherited = []
            total_bytes = len(raw)
            for parent in reversed(self.lineage(thread_id)):
                data = parent["data"][:parent["end"]]
                total_bytes += len(data)
                if total_bytes > 180 * 1024 * 1024:
                    raise StoreError("会话及继承记录合计超过 180 MiB 上限。")
                parent_metadata, _ = self.thread(parent["id"])
                inherited.append({"id": parent["id"],
                                  "name": parent_metadata.get("name") or parent_metadata["title"],
                                  "source": data.decode("utf-8", errors="strict")})
            token = uuid.uuid4().hex
            self.snapshots[token] = {
                "threadId": thread_id, "path": str(path),
                "fileHash": fingerprint(raw),
                "historyHash": self.database_fingerprint(thread_id),
                "metadataHash": fingerprint(encode(metadata).encode()),
                "lineageHash": self.lineage_fingerprint(thread_id),
            }
            if len(self.snapshots) > 100:
                self.snapshots.pop(next(iter(self.snapshots)))
            return {"source": source, "inherited": inherited, "version": token, "name": path.name,
                    "info": self.inspect(thread_id)}

    def table(self, thread_id, table, offset=0, limit=30):
        if table not in ("threads",) + HISTORY_TABLES:
            raise StoreError("只允许读取聊天相关数据表。")
        self.thread(thread_id)
        target = self.state_db if table == "threads" else self.history_db
        key = "id" if table == "threads" else "thread_id"
        with connect(target, True) as db:
            columns = [dict(row) for row in db.execute(f'PRAGMA table_info("{table}")')]
            count = db.execute(f'SELECT count(*) FROM "{table}" WHERE "{key}"=?',
                               (thread_id,)).fetchone()[0]
            rows = [dict(row) for row in db.execute(
                f'SELECT * FROM "{table}" WHERE "{key}"=? ORDER BY rowid LIMIT ? OFFSET ?',
                (thread_id, limit, offset))]
        return {"table": table, "columns": columns, "rows": rows, "total": count,
                "offset": offset, "limit": limit}

    def normalize(self, source, thread_id):
        if not isinstance(source, str) or not source or source.startswith("\ufeff"):
            raise StoreError("需要无 BOM 的非空 UTF-8 JSONL 文件。")
        lines = jsonl_lines(source)
        records = []
        result = []
        start_ordinal = 0
        for index, line in enumerate(lines):
            try:
                record = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError("不允许 NaN/Infinity")))
            except ValueError as error:
                raise StoreError(f"第 {index + 1} 行不是有效 JSON：{error}")
            if not isinstance(record, dict) or "type" not in record or "payload" not in record:
                raise StoreError(f"第 {index + 1} 行不是 Codex 事件记录。")
            if not isinstance(record["payload"], dict):
                raise StoreError(f"第 {index + 1} 行 payload 必须为对象。")
            if index == 0:
                base = record["payload"].get("history_base")
                if base:
                    start_ordinal = base.get("end_ordinal_exclusive")
                    if type(start_ordinal) is not int or start_ordinal < 0:
                        raise StoreError("继承历史的 ordinal 边界无效。")
            if record["payload"].get("thread_id", thread_id) != thread_id:
                raise StoreError(f"第 {index + 1} 行引用了另一条聊天。")
            records.append(record)
            # Keep untouched bytes, including line endings, unless an ordinal needs updating.
            ordinal = start_ordinal + index
            if type(record.get("ordinal")) is not int or record["ordinal"] != ordinal:
                record["ordinal"] = ordinal
                ending = "\r\n" if line.endswith("\r\n") else "\n"
                line = encode(record) + ending
            result.append(line if line.endswith("\n") else line + "\n")
        if records[0]["type"] != "session_meta" or records[0]["payload"].get("id") != thread_id:
            raise StoreError("首行必须保留当前聊天的 session_meta 和原始 id。")
        return "".join(result).encode("utf-8"), len(records)

    @contextlib.contextmanager
    def writer_lock(self, thread_id):
        directory = self.home / "thread-writer-locks"
        directory.mkdir(exist_ok=True)
        with (directory / (thread_id + ".lock")).open("a+b") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise StoreError("Codex 正在使用这条聊天，请停止运行并关闭该聊天后再保存。", 409)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def build_projection(self, thread_id, data):
        with tempfile.TemporaryDirectory(prefix="codex-chat-verify-") as temporary:
            home = Path(temporary)
            backup_database(self.state_db, home / "state_5.sqlite")
            backup_database(self.history_db, home / "thread_history_1.sqlite")
            _, original_path = self.thread(thread_id)
            path = home / "sessions" / original_path.name
            path.parent.mkdir()
            path.write_bytes(data)
            parents = self.lineage(thread_id)
            staged_paths = {thread_id: path}
            for parent in parents:
                destination = path.parent / parent["path"].name
                destination.write_bytes(parent["data"])
                staged_paths[parent["id"]] = destination
            with connect(home / "state_5.sqlite") as db:
                db.execute("DELETE FROM threads WHERE id NOT IN (" +
                           ",".join("?" for _ in staged_paths) + ")", list(staged_paths))
                for identifier, destination in staged_paths.items():
                    db.execute("UPDATE threads SET rollout_path=?,history_mode='paginated' WHERE id=?",
                               (str(destination), identifier))
            with connect(home / "thread_history_1.sqlite") as db:
                for table in HISTORY_TABLES:
                    db.execute(f'DELETE FROM "{table}"')
            self.parser.project(home, thread_id)
            with connect(home / "thread_history_1.sqlite", True) as db:
                projected = self.history_rows(thread_id, db)
                columns = {
                    table: [r["name"] for r in db.execute(f'PRAGMA table_info("{table}")')]
                    for table in projected
                }
            projection = projected.get("thread_history_projection_state", [])
            staged_records = [json.loads(line) for line in jsonl_lines(data.decode("utf-8"))]
            expected_next = staged_records[-1]["ordinal"] + 1
            if (len(projection) != 1 or projection[0]["next_rollout_byte_offset"] != len(data)
                    or projection[0]["next_rollout_ordinal"] != expected_next):
                raise StoreError("Codex 未生成完整索引；未修改原文件。", 503)
            required_messages = set()
            for record in staged_records:
                payload = record.get("payload", {})
                item = payload.get("item", {})
                if (record["type"] == "event_msg" and payload.get("type") == "item_completed"
                        and isinstance(item, dict) and item.get("type") in ("AgentMessage", "UserMessage")):
                    required_messages.add(item.get("id"))
            generated_messages = {row["item_id"] for row in projected.get("thread_items", [])}
            if not required_messages.issubset(generated_messages):
                raise StoreError("消息结构无法被 Codex 解析，未写入。请检查 content/type/id 字段。")
            return projected, columns

    def save(self, thread_id, version, source, mirror=True):
        with self.mutex:
            baseline = self.snapshots.get(version)
            if not baseline or baseline["threadId"] != thread_id:
                raise StoreError("编辑快照已失效，请重新读取聊天。", 409)
            if thread_id in self.blocked:
                raise StoreError("这条聊天有待恢复的保存记录，已禁止再次写入。", 409)
            data, count = self.normalize(source, thread_id)
            if not isinstance(mirror, bool):
                raise StoreError("关联消息选项必须为布尔值。")
            linked_count = 0
            with self.writer_lock(thread_id):
                metadata, path = self.thread(thread_id)
                original = path.read_bytes()
                self.check_baseline(thread_id, baseline, metadata, path, original)
                original_meta = json.loads(original.split(b"\n", 1)[0])["payload"]
                candidate_meta = json.loads(data.split(b"\n", 1)[0])["payload"]
                if candidate_meta != original_meta:
                    raise StoreError("session_meta 为只读；当前版本仅同步聊天事件和历史索引。")
                if mirror:
                    linked_source, linked_count = linked_messages(
                        data.decode("utf-8"), original.decode("utf-8"))
                    data, count = self.normalize(linked_source, thread_id)
                projected, columns = self.build_projection(thread_id, data)
                # Native projection runs only on the isolated copy. Recheck live inputs before commit.
                metadata, path = self.thread(thread_id)
                original = path.read_bytes()
                self.check_baseline(thread_id, baseline, metadata, path, original)
                backup = self.recovery_root / (
                    datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
                backup.mkdir(parents=True, mode=0o700)
                (backup / "rollout.before.jsonl").write_bytes(original)
                backup_database(self.history_db, backup / "thread_history.before.sqlite")
                backup_database(self.state_db, backup / "state.before.sqlite")
                journal = {"threadId": thread_id, "path": str(path), "status": "prepared",
                           "beforeHash": fingerprint(original), "afterHash": fingerprint(data),
                           "createdAt": datetime.datetime.now().isoformat()}
                self.write_journal(backup, journal)
                replaced = False
                with connect(self.history_db) as db:
                    try:
                        db.execute("BEGIN IMMEDIATE")
                        if self.database_fingerprint(thread_id, db) != baseline["historyHash"]:
                            raise StoreError("SQLite 已被外部修改，请重新读取后再保存。", 409)
                        current_meta, current_path = self.thread(thread_id)
                        self.check_baseline(thread_id, baseline, current_meta, current_path,
                                            current_path.read_bytes(), check_history=False)
                        for table in HISTORY_TABLES:
                            db.execute(f'DELETE FROM "{table}" WHERE thread_id=?', (thread_id,))
                        for table, rows in projected.items():
                            names = columns[table]
                            placeholders = ",".join("?" for _ in names)
                            column_sql = ",".join('"' + name + '"' for name in names)
                            db.executemany(
                                f'INSERT INTO "{table}" ({column_sql}) VALUES ({placeholders})',
                                [[row[name] for name in names] for row in rows])
                        replaced = True
                        atomic_write(path, data, path.stat().st_mode & 0o777)
                        journal["status"] = "file_replaced"
                        self.write_journal(backup, journal)
                        db.commit()
                    except Exception:
                        db.rollback()
                        if replaced:
                            try:
                                existing_hash = fingerprint(path.read_bytes())
                                if existing_hash not in (fingerprint(data), fingerprint(original)):
                                    raise StoreError("文件在恢复前再次被修改，需人工检查备份。", 409)
                                atomic_write(path, original, path.stat().st_mode & 0o777)
                            except Exception:
                                journal["status"] = "recovery_required"
                                self.blocked.add(thread_id)
                                self.write_journal(backup, journal)
                                raise
                        journal["status"] = "rolled_back"
                        self.write_journal(backup, journal)
                        raise
                journal["status"] = "committed"
                try:
                    self.write_journal(backup, journal)
                except OSError:
                    self.blocked.add(thread_id)
                    raise StoreError(f"数据已写入，但恢复日志未完成。请检查 {backup}", 500)
                del self.snapshots[version]
                opened = self.open(thread_id)
                opened["backup"] = str(backup)
                opened["records"] = count
                opened["linkedChanges"] = linked_count
                return opened

    def check_baseline(self, thread_id, baseline, metadata, path, raw, check_history=True):
        if str(path) != baseline["path"] or fingerprint(raw) != baseline["fileHash"]:
            raise StoreError("JSONL 已被外部修改，请重新读取后再保存。", 409)
        if fingerprint(encode(metadata).encode()) != baseline["metadataHash"]:
            raise StoreError("聊天元数据已被外部修改，请重新读取后再保存。", 409)
        if check_history and self.database_fingerprint(thread_id) != baseline["historyHash"]:
            raise StoreError("SQLite 已被外部修改，请重新读取后再保存。", 409)
        if self.lineage_fingerprint(thread_id) != baseline["lineageHash"]:
            raise StoreError("继承的父聊天记录已被修改，请重新读取后再保存。", 409)

    def write_journal(self, backup, journal):
        atomic_write(backup / "journal.json", (encode(journal) + "\n").encode())
