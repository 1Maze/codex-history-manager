import json
from pathlib import Path
import tempfile
import unittest

from backup_management import backup_deletable, backup_title, delete_backup
from store import StoreError


class BackupManagementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="backup-management-")
        self.home = Path(self.temporary.name)
        self.root = self.home / "backups"
        self.root.mkdir()
        self.snapshot = self.home / "snapshot.jsonl"

    def tearDown(self):
        self.temporary.cleanup()

    def source(self, records):
        self.snapshot.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n"
                                         for record in records), encoding="utf-8")

    def backup(self, name="fixture", status="snapshot", kind="manual"):
        directory = self.root / name
        directory.mkdir()
        (directory / "journal.json").write_text(json.dumps({
            "threadId": "session-one", "status": status, "kind": kind,
        }))
        (directory / "rollout.before.jsonl").write_text("snapshot")
        return directory

    def test_codex_last_prompt_and_unicode_limit(self):
        prompt = "最后一轮用户发言需要截取前二十个字符用于显示名称"
        self.source([
            {"type": "session_meta", "payload": {"cwd": "/workspace/project-folder"}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "first prompt"}},
            {"type": "event_msg", "payload": {"type": "item_completed", "item": {
                "type": "UserMessage", "content": [{"type": "text", "text": prompt}]}}},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "<environment_context>ignore</environment_context>"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "not a user prompt"}],
                "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["system.context"]}}},
        ])
        self.assertEqual(backup_title(self.snapshot, "session-one"),
                         "project-folder · session-one · " + prompt[:20])

    def test_claude_excludes_hidden_sidechain_and_tools(self):
        self.source([
            {"type": "user", "cwd": "/workspace/example", "message": {"content": "old prompt"}},
            {"type": "user", "message": {"content": [{"type": "text", "text": "last\nuser question"}]}},
            {"type": "user", "isMeta": True, "message": {"content": "hidden context"}},
            {"type": "user", "isSidechain": True, "message": {"content": "sidechain prompt"}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "call", "content": "tool output"}]}},
            {"type": "last-prompt", "lastPrompt": "derived context"},
        ])
        self.assertEqual(backup_title(self.snapshot, "encoded-project/session-two"),
                         "example · session-two · last user question")

    def test_wrapped_request_legacy_records_and_windows_folder(self):
        self.source([
            {"type": "session_meta", "payload": {"cwd": "C:\\workspace\\project\\"}},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
                "content": [{"type": "input_text", "text":
                    "## Referenced chats with Codex:\ncontext\n## My request:\nactual request"}]}},
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "not user"}},
        ])
        self.assertEqual(backup_title(self.snapshot, "session"),
                         "project · session · actual request")
        self.source([{"type": "event_msg", "payload": {"type": "user_message", "message": "new prompt"}}])
        self.assertEqual(backup_title(self.snapshot, "session", "/fallback/folder"),
                         "folder · session · new prompt")

    def test_empty_missing_and_invalid_snapshots_have_fallback(self):
        self.assertEqual(backup_title(self.snapshot, "project/session"),
                         "未知文件夹 · session · 无用户发言")
        self.snapshot.write_text("invalid JSON\n[]\n{}\n")
        self.assertEqual(backup_title(self.snapshot, "session", "/work/folder"),
                         "folder · session · 无用户发言")

    def test_delete_only_selected_backup_and_do_not_follow_inner_links(self):
        target = self.backup()
        other = self.backup("other")
        original = self.home / "original.jsonl"
        original.write_text("keep original")
        (target / "external-link").symlink_to(original)
        result = delete_backup(self.root, target.name)
        self.assertEqual(result["deleted"], target.name)
        self.assertFalse(target.exists())
        self.assertTrue(other.exists())
        self.assertEqual(original.read_text(), "keep original")

    def test_pending_and_independent_copy_journals_cannot_be_deleted(self):
        for index, (status, kind) in enumerate([
            ("prepared", "save"), ("file_replaced", "automatic"), ("recovery_required", "save"),
            ("snapshot_preparing", "manual"), ("installing", "recovery_copy"),
            ("committed", "recovery_copy"), ("snapshot", "copy"), ("unexpected", "manual"),
        ]):
            with self.subTest(status=status, kind=kind):
                target = self.backup(f"blocked-{index}", status, kind)
                self.assertFalse(backup_deletable({"status": status, "kind": kind}))
                with self.assertRaises(StoreError):
                    delete_backup(self.root, target.name)
                self.assertTrue(target.exists())
        for status in ("snapshot", "committed", "rolled_back", "snapshot_failed"):
            self.assertTrue(backup_deletable({"status": status, "kind": "manual"}))

    def test_bad_ids_symlinks_and_unrecognized_directories_rejected(self):
        target = self.backup()
        for identifier in ("../fixture", ".", "", "/tmp", None, 42):
            with self.subTest(identifier=identifier), self.assertRaises(StoreError):
                delete_backup(self.root, identifier)
        alias = self.root / "alias"
        alias.symlink_to(target, target_is_directory=True)
        with self.assertRaises(StoreError):
            delete_backup(self.root, alias.name)
        alias.unlink()
        journal = target / "journal.json"
        external = self.home / "outside-journal.json"
        external.write_bytes(journal.read_bytes())
        journal.unlink()
        journal.symlink_to(external)
        with self.assertRaises(StoreError):
            delete_backup(self.root, target.name)
        journal.unlink()
        journal.write_text("not JSON")
        with self.assertRaises(StoreError):
            delete_backup(self.root, target.name)
        journal.write_text("[]")
        with self.assertRaises(StoreError):
            delete_backup(self.root, target.name)
        journal.unlink()
        with self.assertRaises(StoreError):
            delete_backup(self.root, target.name)
        self.assertTrue(target.exists())
        with self.assertRaises(StoreError):
            delete_backup(self.root, "missing")


if __name__ == "__main__":
    unittest.main()
