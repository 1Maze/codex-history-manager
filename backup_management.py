"""Snapshot-derived backup names and bounded backup-directory deletion."""

from functools import lru_cache
import json
from pathlib import Path, PurePosixPath
import re
import shutil

from store import StoreError


def _content_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(part["text"] for part in content if isinstance(part, dict)
                     and isinstance(part.get("text"), str)
                     and part.get("type") not in ("tool_result", "thinking"))


@lru_cache(maxsize=512)
def _snapshot_name(path, size, modified, changed):
    cwd, prompt = "", ""
    with Path(path).open(encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict):
                continue
            payload = record.get("payload")
            payload = payload if isinstance(payload, dict) else {}
            location = payload.get("cwd") if record.get("type") == "session_meta" else record.get("cwd")
            if not cwd and isinstance(location, str):
                cwd = location
            if record.get("isMeta") or record.get("isSidechain"):
                continue
            text = ""
            if record.get("type") == "user" and isinstance(record.get("message"), dict):
                text = _content_text(record["message"].get("content"))
            elif record.get("type") == "event_msg":
                item = payload.get("item")
                if payload.get("type") == "user_message":
                    text = payload.get("message", "")
                elif payload.get("type") == "item_completed" and isinstance(item, dict) and item.get("type") == "UserMessage":
                    text = _content_text(item.get("content")) or item.get("text", "")
            elif record.get("type") == "response_item" and payload.get("type") == "message" and payload.get("role") == "user":
                metadata = payload.get("internal_chat_message_metadata_passthrough")
                kinds = metadata.get("content_item_kinds") if isinstance(metadata, dict) else None
                if isinstance(kinds, list) and kinds and not any(
                        isinstance(kind, str) and kind.startswith("user.") for kind in kinds):
                    continue
                text = _content_text(payload.get("content"))
            if not isinstance(text, str) or not text.strip():
                continue
            text = text.strip()
            if re.match(r"<(?:environment_context|external_codex_apps_open_page|turn_aborted|permissions|collaboration_mode|user_instructions)(?:>|\s)", text):
                continue
            if text.startswith(("## Referenced chats with Codex:", "# Files mentioned by the user:")) and "## My request:" in text:
                text = text.split("## My request:", 1)[1].strip()
            normalized = " ".join(text.split())
            if normalized:
                prompt = normalized[:20]
    return cwd, prompt


def backup_title(snapshot, thread_id, fallback_cwd=""):
    cwd, prompt = "", ""
    try:
        if not snapshot.is_symlink() and snapshot.is_file():
            stat = snapshot.stat()
            cwd, prompt = _snapshot_name(str(snapshot), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    except (OSError, UnicodeError):
        pass
    location = cwd or fallback_cwd
    location = location.replace("\\", "/") if isinstance(location, str) else ""
    folder = PurePosixPath(location).name if location else ""
    session_id = str(thread_id or "未知会话").rsplit("/", 1)[-1]
    return f"{folder or '未知文件夹'} · {session_id} · {prompt or '无用户发言'}"


def backup_deletable(entry):
    return (isinstance(entry, dict)
            and entry.get("kind") not in ("copy", "recovery_copy")
            and entry.get("status") in ("snapshot", "committed", "rolled_back", "snapshot_failed"))


def delete_backup(root, backup_id):
    if not isinstance(backup_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", backup_id):
        raise StoreError("备份 ID 无效。")
    root = root.resolve()
    directory = root / backup_id
    if directory.is_symlink() or directory.resolve().parent != root:
        raise StoreError("备份目录无效。", 403)
    journal = directory / "journal.json"
    if not directory.is_dir() or not journal.is_file():
        raise StoreError("备份不存在。", 404)
    if journal.is_symlink():
        raise StoreError("备份日志不能是符号链接。", 403)
    try:
        entry = json.loads(journal.read_text("utf-8"))
    except (ValueError, UnicodeError) as error:
        raise StoreError("备份日志损坏，拒绝删除。", 409) from error
    if not isinstance(entry, dict) or not isinstance(entry.get("threadId"), str) or not entry["threadId"]:
        raise StoreError("无法确认备份身份，拒绝删除。", 409)
    if not backup_deletable(entry):
        raise StoreError("此目录包含未完成的恢复记录或独立副本日志，不能删除。", 409)
    shutil.rmtree(directory)
    return {"deleted": backup_id, "backupPath": str(directory)}
