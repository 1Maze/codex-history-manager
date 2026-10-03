import json
from pathlib import Path
import tempfile
import unittest

from recovery import RecoveryService
from store import ChatStore, StoreError, connect, encode
from test_store import fixture, THREAD


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="recovery-test-")
        self.home = Path(self.temp.name)
        self.path, self.records = fixture(self.home)
        self.store = ChatStore(self.home)
        self.service = RecoveryService(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_manual_backup_and_target_only_restore(self):
        before = self.path.read_bytes()
        backup = self.service.backup(THREAD)
        self.assertEqual(backup["status"], "snapshot")
        folder = Path(backup["backupPath"])
        self.assertEqual((folder / "rollout.before.jsonl").read_bytes(), before)
        self.assertTrue((folder / "state.before.sqlite").is_file())
        self.assertTrue((folder / "thread_history.before.sqlite").is_file())
        self.assertEqual(self.service.backups(THREAD)["rows"][0]["backupId"], backup["backupId"])
        opened = self.store.open(THREAD)
        self.records[3]["payload"]["item"]["content"][0]["text"] = "edited"
        changed = self.store.save(THREAD, opened["version"], "".join(encode(r) + "\n" for r in self.records))
        restored = self.service.restore(THREAD, changed["version"], backup["backupId"])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(restored["info"]["health"], "aligned")
        self.assertNotEqual(restored["backup"], backup["backupPath"])

    def test_tampered_backup_and_bad_path_rejected(self):
        backup = self.service.backup(THREAD)
        folder = Path(backup["backupPath"])
        (folder / "rollout.before.jsonl").write_text("tampered")
        opened = self.store.open(THREAD)
        with self.assertRaisesRegex(StoreError, "校验失败"):
            self.service.restore(THREAD, opened["version"], backup["backupId"])
        with self.assertRaises(StoreError):
            self.service.backup_path("../state_5.sqlite")

    def test_preview_text_only_and_no_original_changes(self):
        original = self.path.read_bytes()
        opened = self.store.open(THREAD)
        preview = self.service.preview(THREAD, opened["version"], 1)
        self.assertEqual(preview["selectedTurns"], 1)
        self.assertIn("fixture question", preview["handoff"])
        self.assertEqual(preview["handoff"].count("original answer"), 1)
        self.assertEqual(self.path.read_bytes(), original)

    def test_create_independent_copy(self):
        original = self.path.read_bytes()
        opened = self.store.open(THREAD)
        preview = self.service.preview(THREAD, opened["version"], 1)
        copy = self.service.create_copy(THREAD, opened["version"], 1, preview["handoff"], mode="handoff")
        self.assertNotEqual(copy["threadId"], THREAD)
        raw = Path(copy["path"]).read_text()
        first = json.loads(raw.splitlines()[0])["payload"]
        self.assertFalse(first.get("history_base"))
        self.assertFalse(first.get("forked_from_id"))
        self.assertIn("fixture question", raw)
        messages = [json.loads(line) for line in raw.splitlines() if json.loads(line)["type"] == "response_item"]
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["payload"]["role"], "user")
        self.assertEqual(messages[0]["payload"]["internal_chat_message_metadata_passthrough"]["content_item_kinds"], ["user.text"])
        self.assertEqual(self.path.read_bytes(), original)
        with connect(self.store.state_db, True) as db:
            metadata = db.execute("SELECT cwd FROM threads WHERE id=?", (copy["threadId"],)).fetchone()
        self.assertEqual(metadata["cwd"], str(self.home))
        self.assertTrue(Path(copy["backupPath"]).is_dir())
        self.assertEqual(self.store.inspect(copy["threadId"])["health"], "aligned")
        with connect(self.store.state_db, True) as db:
            visible = db.execute("SELECT has_user_event,preview,first_user_message FROM threads WHERE id=?",
                                 (copy["threadId"],)).fetchone()
        self.assertEqual(visible["has_user_event"], 1)
        self.assertTrue(visible["preview"])
        self.assertEqual(visible["first_user_message"], preview["handoff"])
        with connect(self.store.history_db, True) as db:
            user_count = db.execute("SELECT count(*) FROM thread_items WHERE thread_id=? AND item_type='userMessage'",
                                    (copy["threadId"],)).fetchone()[0]
        self.assertEqual(user_count, 1)
        listed = self.store.parser.run_local(self.home, lambda request: request(2, "thread/list", {
            "useStateDbOnly": True, "cwd": str(self.home), "modelProviders": [],
            "sourceKinds": ["vscode", "cli", "appServer"], "limit": 100,
        }))
        self.assertIn(copy["threadId"], [thread["id"] for thread in listed["data"]])

    def test_repair_old_copy_visibility(self):
        opened = self.store.open(THREAD)
        copy = self.service.create_copy(THREAD, opened["version"], 1, "恢复文本", mode="handoff")
        opened_copy = self.store.open(copy["threadId"])
        legacy = [json.loads(line) for line in opened_copy["source"].splitlines()]
        legacy = [record for record in legacy if record["type"] != "event_msg"]
        for ordinal, record in enumerate(legacy):
            record["ordinal"] = ordinal
        self.store.save(copy["threadId"], opened_copy["version"],
                        "".join(encode(record) + "\n" for record in legacy), mirror=False)
        with connect(self.store.state_db) as db:
            db.execute("UPDATE threads SET has_user_event=0,preview='',first_user_message='' WHERE id=?",
                       (copy["threadId"],))
        result = self.service.repair_copy_visibility(copy["threadId"])
        self.assertEqual(result["info"]["metadata"]["has_user_event"], 1)
        self.assertEqual(result["info"]["metadata"]["preview"], "恢复文本")
        self.assertTrue(Path(result["backupPath"]).exists())
        with connect(self.store.history_db, True) as db:
            count = db.execute("SELECT count(*) FROM thread_items WHERE thread_id=? AND item_type='userMessage'",
                               (copy["threadId"],)).fetchone()[0]
        self.assertEqual(count, 1)

    def test_stale_preview_rejected(self):
        opened = self.store.open(THREAD)
        self.path.write_bytes(self.path.read_bytes() + b"\n")
        with self.assertRaisesRegex(StoreError, "外部修改"):
            self.service.preview(THREAD, opened["version"], 1)

    def test_conversation_copy_preserves_roles_tools_and_context(self):
        tool_records = [
            {"type": "turn_context", "payload": {"turn_id": self.records[1]["payload"]["turn_id"],
                "cwd": str(self.home), "approval_policy": "never",
                "sandbox_policy": {"type": "read-only"}, "model": "gpt-5", "summary": "auto"}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "functions.exec_command",
                "arguments": '{"cmd":"printf fixture"}', "call_id": "tool-one"}},
            {"type": "response_item", "payload": {"type": "function_call_output",
                "call_id": "tool-one", "output": "fixture output"}},
            {"type": "event_msg", "payload": {"type": "item_completed", "thread_id": THREAD,
                "turn_id": self.records[1]["payload"]["turn_id"], "item": {
                    "type": "CommandExecution", "id": "tool-one", "command": ["/bin/sh", "-c", "printf fixture"],
                    "cwd": "file://" + str(self.home), "parsed_cmd": [], "source": "unified_exec_startup",
                    "status": "completed", "stdout": "fixture output", "stderr": "",
                    "aggregated_output": "fixture output", "exit_code": 0, "process_id": "123",
                    "duration": {"secs": 0, "nanos": 1000000}, "formatted_output": "fixture output"},
                "started_at_ms": 1790820000001, "completed_at_ms": 1790820000002}},
        ]
        self.records[3:3] = tool_records
        for ordinal, record in enumerate(self.records):
            record["ordinal"] = ordinal
            record.setdefault("timestamp", "2026-10-01T02:00:01Z")
        self.path.write_text("".join(encode(r) + "\n" for r in self.records))
        before = self.path.read_bytes()
        opened = self.store.open(THREAD)
        preview = self.service.preview(THREAD, opened["version"], 1)
        self.assertEqual(preview["selectedToolCalls"], 1)
        copy = self.service.create_copy(THREAD, opened["version"], 1, "not the original dialogue")
        records = [json.loads(line) for line in Path(copy["path"]).read_text().splitlines()]
        self.assertEqual(records[0]["payload"]["base_instructions"], self.records[0]["payload"]["base_instructions"])
        for original, cloned in zip(self.records[1:], records[1:]):
            expected = json.loads(encode(original))
            if expected["payload"].get("thread_id") == THREAD:
                expected["payload"]["thread_id"] = copy["threadId"]
            self.assertEqual(cloned["payload"], expected["payload"])
        types = {row["item_type"] for row in self.store.table(copy["threadId"], "thread_items")["rows"]}
        self.assertTrue({"userMessage", "agentMessage", "commandExecution"} <= types)
        self.assertNotIn("not the original dialogue", Path(copy["path"]).read_text())
        self.assertEqual(self.path.read_bytes(), before)
        listed = self.store.parser.run_local(self.home, lambda request: request(2, "thread/list", {
            "useStateDbOnly": True, "cwd": str(self.home), "modelProviders": [], "limit": 100,
        }))
        self.assertIn(copy["threadId"], [thread["id"] for thread in listed["data"]])

    def test_conversation_only_keeps_selected_turn_and_drops_old_checkpoint(self):
        old_turn = self.records[1]["payload"]["turn_id"]
        new_turn = "33333333-3333-4333-8333-333333333333"
        recent = json.loads(encode(self.records[1:]))
        for record in recent:
            record["payload"]["turn_id"] = new_turn
            if record["payload"].get("root_turn_id") == old_turn:
                record["payload"]["root_turn_id"] = new_turn
            if record["payload"].get("type") == "task_complete":
                record["payload"]["last_agent_message"] = "recent answer"
            item = record["payload"].get("item")
            if item:
                item["id"] += "-recent"
                if item["type"] == "UserMessage":
                    item["content"][0]["text"] = "recent question"
                if item["type"] == "AgentMessage":
                    item["content"][0]["text"] = "recent answer"
            if record["type"] == "response_item":
                record["payload"]["id"] += "-recent"
                record["payload"]["content"][0]["text"] = "recent answer"
                record["payload"]["internal_chat_message_metadata_passthrough"]["turn_id"] = new_turn
        recent.insert(2, {"type": "compacted", "timestamp": "2026-10-01T02:00:01Z",
                          "payload": {"message": "unselected old history", "replacement_history": []}})
        all_records = self.records + recent
        for ordinal, record in enumerate(all_records):
            record["ordinal"] = ordinal
        self.path.write_text("".join(encode(r) + "\n" for r in all_records))
        original = self.path.read_bytes()
        opened = self.store.open(THREAD)
        preview = self.service.preview(THREAD, opened["version"], 1)
        self.assertEqual(preview["omittedCheckpoints"], 1)
        copy = self.service.create_copy(THREAD, opened["version"], 1)
        raw = Path(copy["path"]).read_text()
        self.assertIn("recent question", raw)
        self.assertIn("recent answer", raw)
        self.assertNotIn("fixture question", raw)
        self.assertNotIn("original answer", raw)
        self.assertNotIn("unselected old history", raw)
        self.assertNotIn('"type":"compacted"', raw)
        self.assertEqual(self.path.read_bytes(), original)

    def test_conversation_rejects_orphan_tool_output(self):
        self.records.insert(3, {"type": "response_item", "payload": {
            "type": "function_call_output", "call_id": "missing-call", "output": "orphan"}})
        self.path.write_text("".join(encode(r) + "\n" for r in self.records))
        opened = self.store.open(THREAD)
        with self.assertRaisesRegex(StoreError, "工具"):
            self.service.create_copy(THREAD, opened["version"], 1, "")

    def test_incomplete_turn_not_selected(self):
        self.path.write_text("".join(encode(record) + "\n" for record in self.records[:-1]), encoding="utf-8")
        opened = self.store.open(THREAD)
        preview = self.service.preview(THREAD, opened["version"], 1)
        self.assertEqual(preview["selectedTurns"], 0)
        with self.assertRaisesRegex(StoreError, "没有可选"):
            self.service.create_copy(THREAD, opened["version"], 1, preview["handoff"])

    def test_copy_rejects_oversized_handoff(self):
        opened = self.store.open(THREAD)
        with self.assertRaisesRegex(StoreError, "64 KiB"):
            self.service.create_copy(THREAD, opened["version"], 1, "x" * 65537, mode="handoff")


if __name__ == "__main__":
    unittest.main()
