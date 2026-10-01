import fcntl
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from store import ChatStore, ClosingConnection, StoreError, connect, encode


THREAD = "11111111-1111-4111-8111-111111111111"
TURN = "22222222-2222-4222-8222-222222222222"


def clone_schema(source, target):
    with connect(source, True) as src, sqlite3.connect(target, factory=ClosingConnection) as dst:
        for row in src.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL "
                               "AND name NOT LIKE 'sqlite_%' ORDER BY type='table' DESC"):
            dst.execute(row[0])
        rows = src.execute("SELECT * FROM _sqlx_migrations").fetchall()
        if rows:
            dst.executemany("INSERT INTO _sqlx_migrations VALUES (" +
                            ",".join("?" for _ in rows[0]) + ")", [tuple(row) for row in rows])


def fixture(home):
    source_home = Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
    clone_schema(source_home / "state_5.sqlite", home / "state_5.sqlite")
    clone_schema(source_home / "thread_history_1.sqlite", home / "thread_history_1.sqlite")
    path = home / "sessions" / ("rollout-2026-10-01T10-00-00-" + THREAD + ".jsonl")
    path.parent.mkdir()
    records = [
        {"type": "session_meta", "payload": {
            "id": THREAD, "session_id": THREAD, "timestamp": "2026-10-01T02:00:00Z",
            "cwd": str(home), "originator": "fixture", "cli_version": "0.155.0",
            "source": "cli", "model_provider": "openai", "history_mode": "paginated",
            "base_instructions": {"text": "Fixture", "provenance": None},
        }},
        {"type": "event_msg", "payload": {
            "type": "task_started", "turn_id": TURN, "root_turn_id": TURN,
            "started_at": 1790820000, "model_context_window": 258400,
            "collaboration_mode_kind": "default",
        }},
        {"type": "event_msg", "payload": {
            "type": "item_completed", "thread_id": THREAD, "turn_id": TURN,
            "item": {"type": "UserMessage", "id": "user-one",
                     "client_id": "e06433a0-5434-4029-82ef-44db2ea054e1",
                     "content": [{"type": "text", "text": "fixture question", "text_elements": []}]},
            "started_at_ms": 1790820000000, "completed_at_ms": 1790820000000,
        }},
        {"type": "event_msg", "payload": {
            "type": "item_completed", "thread_id": THREAD, "turn_id": TURN,
            "item": {"type": "AgentMessage", "id": "agent-one",
                     "content": [{"type": "Text", "text": "original answer"}],
                     "phase": "final_answer"},
            "started_at_ms": 1790820000100, "completed_at_ms": 1790820000200,
        }},
        {"type": "response_item", "payload": {
            "type": "message", "id": "agent-one", "role": "assistant",
            "content": [{"type": "output_text", "text": "original answer"}],
            "phase": "final_answer",
            "internal_chat_message_metadata_passthrough": {"turn_id": TURN},
        }},
        {"type": "event_msg", "payload": {
            "type": "task_complete", "turn_id": TURN, "last_agent_message": "original answer",
            "started_at": 1790820000, "completed_at": 1790820001, "duration_ms": 1000,
        }},
    ]
    for index, row in enumerate(records):
        row["timestamp"] = "2026-10-01T02:00:01Z"
        row["ordinal"] = index
    path.write_text("".join(encode(row) + "\n" for row in records), encoding="utf-8")
    row = dict(
        id=THREAD, rollout_path=str(path), created_at=1790820000, updated_at=1790820001,
        source="cli", model_provider="openai", cwd=str(home), title="同步测试聊天",
        sandbox_policy=encode({"type": "read-only"}), approval_mode="never",
        name="同步测试聊天", history_mode="paginated",
    )
    with connect(home / "state_5.sqlite") as db:
        columns = list(row)
        db.execute('INSERT INTO threads (' + ','.join('"' + c + '"' for c in columns) +
                   ') VALUES (' + ','.join('?' for _ in columns) + ')',
                   [row[c] for c in columns])
    return path, records


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="chat-sync-fixture-")
        self.home = Path(self.temporary.name)
        self.path, self.records = fixture(self.home)
        self.store = ChatStore(self.home)

    def tearDown(self):
        self.temporary.cleanup()

    def serialize(self, records):
        return "".join(encode(row) + "\n" for row in records)

    def test_native_save_edit_and_suffix_delete(self):
        opened = self.store.open(THREAD)
        self.records[3]["payload"]["item"]["content"][0]["text"] = "中文新回复"
        self.records[4]["payload"]["content"][0]["text"] = "中文新回复"
        self.records[5]["payload"]["last_agent_message"] = "中文新回复"
        saved = self.store.save(THREAD, opened["version"], self.serialize(self.records))
        self.assertEqual(saved["info"]["health"], "aligned")
        rows = self.store.table(THREAD, "thread_items")["rows"]
        item = next(json.loads(row["item_json"]) for row in rows if row["item_id"] == "agent-one")
        self.assertEqual(item["text"], "中文新回复")
        backup = Path(saved["backup"])
        self.assertEqual(json.loads((backup / "journal.json").read_text())["status"], "committed")
        self.assertIn("original answer", (backup / "rollout.before.jsonl").read_text())
        # Remove the assistant records and completion, leaving a partial turn.
        saved = self.store.save(THREAD, saved["version"], self.serialize(self.records[:3]))
        self.assertEqual(saved["info"]["health"], "aligned")
        self.assertFalse(any(row["item_id"] == "agent-one"
                             for row in self.store.table(THREAD, "thread_items")["rows"]))

    def test_ordinal_renumber_and_unicode_byte_offsets(self):
        opened = self.store.open(THREAD)
        self.records[2]["ordinal"] = 99
        saved = self.store.save(THREAD, opened["version"], self.serialize(self.records))
        parsed = [json.loads(line) for line in saved["source"].splitlines()]
        self.assertEqual([r["ordinal"] for r in parsed], list(range(len(parsed))))
        self.assertEqual(saved["info"]["projection"]["next_rollout_byte_offset"], self.path.stat().st_size)

    def test_external_file_change_rejected(self):
        opened = self.store.open(THREAD)
        self.path.write_text(opened["source"] + encode(self.records[-1]) + "\n")
        expected = self.path.read_bytes()
        with self.assertRaisesRegex(StoreError, "JSONL 已被外部修改"):
            self.store.save(THREAD, opened["version"], opened["source"])
        self.assertEqual(self.path.read_bytes(), expected)

    def test_database_change_rejected(self):
        opened = self.store.open(THREAD)
        with connect(self.store.history_db) as db:
            db.execute("INSERT INTO thread_history_projection_state VALUES (?,?,?)", (THREAD, 42, 1))
        with self.assertRaisesRegex(StoreError, "SQLite 已被外部修改"):
            self.store.save(THREAD, opened["version"], opened["source"])

    def test_writer_lock_rejected(self):
        opened = self.store.open(THREAD)
        locks = self.home / "thread-writer-locks"
        locks.mkdir()
        with (locks / (THREAD + ".lock")).open("a+b") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(StoreError, "Codex 正在使用"):
                self.store.save(THREAD, opened["version"], opened["source"])

    def test_invalid_and_cross_thread_jsonl_rejected(self):
        opened = self.store.open(THREAD)
        original = self.path.read_bytes()
        for source in ("bad", "", "{}\n", "\ufeff" + opened["source"]):
            with self.assertRaises(StoreError):
                self.store.save(THREAD, opened["version"], source)
        self.records[0]["payload"]["id"] = "other-thread"
        with self.assertRaises(StoreError):
            self.store.save(THREAD, opened["version"], self.serialize(self.records))
        self.assertEqual(self.path.read_bytes(), original)

    def test_rolls_back_file_and_database_after_failure(self):
        opened = self.store.open(THREAD)
        before = self.path.read_bytes()
        db_hash = self.store.database_fingerprint(THREAD)
        actual = self.store.write_journal
        def fail(backup, journal):
            if journal["status"] == "file_replaced":
                raise OSError("injected journal failure")
            return actual(backup, journal)
        with patch.object(self.store, "write_journal", fail):
            with self.assertRaisesRegex(OSError, "injected"):
                self.store.save(THREAD, opened["version"], opened["source"])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.store.database_fingerprint(THREAD), db_hash)

    def test_sql_and_path_allowlist(self):
        with self.assertRaises(StoreError):
            self.store.table(THREAD, "threads; DROP TABLE threads")
        with connect(self.store.state_db) as db:
            db.execute("UPDATE threads SET rollout_path='/etc/passwd' WHERE id=?", (THREAD,))
        with self.assertRaisesRegex(StoreError, "sessions"):
            self.store.open(THREAD)

    def test_stale_version_rejected(self):
        with self.assertRaisesRegex(StoreError, "快照"):
            self.store.save(THREAD, "not-a-version", self.serialize(self.records))

    def test_message_mirror_edit_and_delete(self):
        opened = self.store.open(THREAD)
        self.records[4]["payload"]["content"][0]["text"] = "response-only edit"
        saved = self.store.save(THREAD, opened["version"], self.serialize(self.records))
        self.assertEqual(saved["linkedChanges"], 1)
        rows = self.store.table(THREAD, "thread_items")["rows"]
        item = next(json.loads(row["item_json"]) for row in rows if row["item_id"] == "agent-one")
        self.assertEqual(item["text"], "response-only edit")
        edited = [json.loads(line) for line in saved["source"].splitlines()]
        del edited[4]
        saved = self.store.save(THREAD, saved["version"], self.serialize(edited))
        self.assertEqual(saved["linkedChanges"], 1)
        self.assertFalse(any(row["item_id"] == "agent-one" for row in
                             self.store.table(THREAD, "thread_items")["rows"]))

    def test_message_mirror_can_be_disabled(self):
        opened = self.store.open(THREAD)
        self.records[4]["payload"]["content"][0]["text"] = "only this row"
        saved = self.store.save(THREAD, opened["version"], self.serialize(self.records), mirror=False)
        self.assertIn("original answer", saved["source"])
        self.assertIn("only this row", saved["source"])
        self.assertEqual(saved["linkedChanges"], 0)

    def test_unicode_line_separator_inside_json_string(self):
        opened = self.store.open(THREAD)
        self.records[3]["payload"]["item"]["content"][0]["text"] = "一\u2028二"
        saved = self.store.save(THREAD, opened["version"], self.serialize(self.records))
        self.assertEqual(saved["records"], 6)
        rows = self.store.table(THREAD, "thread_items")["rows"]
        item = next(json.loads(row["item_json"]) for row in rows if row["item_id"] == "agent-one")
        self.assertEqual(item["text"], "一\u2028二")

    def test_native_rejects_invalid_message_shape_without_writing(self):
        opened = self.store.open(THREAD)
        self.records[2]["payload"]["item"]["content"][0]["type"] = "UnsupportedText"
        with self.assertRaisesRegex(StoreError, "消息结构"):
            self.store.save(THREAD, opened["version"], self.serialize(self.records))
        self.assertEqual(self.path.read_text(), opened["source"])

    def test_does_not_delete_other_threads_cache(self):
        other = "other-fixture-thread"
        with connect(self.store.history_db) as db:
            db.execute("INSERT INTO thread_history_projection_state VALUES (?,?,?)", (other, 42, 7))
        opened = self.store.open(THREAD)
        self.store.save(THREAD, opened["version"], opened["source"])
        with connect(self.store.history_db, True) as db:
            row = db.execute("SELECT * FROM thread_history_projection_state WHERE thread_id=?", (other,)).fetchone()
        self.assertEqual(row["next_rollout_byte_offset"], 42)

    def make_branch(self):
        branch = "33333333-3333-4333-8333-333333333333"
        meta = json.loads(encode(self.records[0]))
        meta["payload"].update(id=branch, session_id=branch, forked_from_id=THREAD,
                               history_base={"thread_id": THREAD, "end_ordinal_exclusive": 6,
                                             "end_byte_offset": self.path.stat().st_size})
        meta["ordinal"] = 6
        aborted = {"type": "event_msg", "timestamp": "2026-10-01T02:00:02Z", "ordinal": 7,
                   "payload": {"type": "turn_aborted", "turn_id": TURN, "reason": "interrupted",
                               "started_at": 1790820000}}
        path = self.path.parent / ("rollout-2026-10-01T10-01-00-" + branch + ".jsonl")
        path.write_text(self.serialize([meta, aborted]), encoding="utf-8")
        with connect(self.store.state_db) as db:
            row = dict(db.execute("SELECT * FROM threads WHERE id=?", (THREAD,)).fetchone())
            row.update(id=branch, rollout_path=str(path), title="分支测试聊天")
            names = list(row)
            db.execute("INSERT INTO threads (" + ",".join('"' + n + '"' for n in names) +
                       ") VALUES (" + ",".join("?" for _ in names) + ")", [row[n] for n in names])
        return branch, path

    def test_branch_preserves_inherited_ordinal_and_parent_file(self):
        branch, path = self.make_branch()
        parent_before = self.path.read_bytes()
        opened = self.store.open(branch)
        self.assertEqual(opened["inherited"][0]["id"], THREAD)
        self.assertIn("original answer", opened["inherited"][0]["source"])
        saved = self.store.save(branch, opened["version"], opened["source"])
        self.assertEqual([json.loads(line)["ordinal"] for line in saved["source"].splitlines()], [6, 7])
        self.assertEqual(saved["info"]["projection"]["next_rollout_ordinal"], 8)
        self.assertEqual(self.path.read_bytes(), parent_before)
        self.assertEqual(saved["info"]["fileBytes"], path.stat().st_size)

    def test_branch_rejects_changed_parent_prefix(self):
        branch, _ = self.make_branch()
        opened = self.store.open(branch)
        self.path.write_text(self.path.read_text().replace("original answer", "changed! answer"))
        with self.assertRaisesRegex(StoreError, "父聊天记录已被修改"):
            self.store.save(branch, opened["version"], opened["source"])

    def test_sidebar_uses_codex_name_and_project_group(self):
        with connect(self.store.state_db) as db:
            db.execute("INSERT INTO projects VALUES (?,?,?,?,?,?)",
                       ("fixture-project", "研究项目", "{}", 0, 0, 0))
            db.execute("UPDATE threads SET name=?,title=?,project_id=? WHERE id=?",
                       ("Codex 短标题", "原始问题\n很长的正文", "fixture-project", THREAD))
        sidebar = self.store.sidebar()
        self.assertEqual(sidebar["total"], 1)
        self.assertEqual(sidebar["groups"][0]["name"], "研究项目")
        self.assertEqual(sidebar["groups"][0]["threads"], [{"id": THREAD, "title": "Codex 短标题"}])
        self.assertEqual(self.store.sidebar("研究项目")["total"], 1)
        self.assertEqual(self.store.sidebar("很长的正文")["total"], 0)
        self.assertEqual(self.store.sidebar(project_key="project:fixture-project")["total"], 1)
        self.assertEqual(self.store.sidebar(project_key="cwd:missing")["total"], 0)

    def test_sidebar_cwd_fallback_and_archive_group(self):
        self.assertEqual(self.store.sidebar()["groups"][0]["name"], self.home.name)
        with connect(self.store.state_db) as db:
            db.execute("UPDATE threads SET archived=1 WHERE id=?", (THREAD,))
        self.assertEqual(self.store.sidebar()["groups"][0]["key"], "archived")

    def test_sidebar_first_five_and_group_pagination(self):
        with connect(self.store.state_db) as db:
            original = dict(db.execute("SELECT * FROM threads WHERE id=?", (THREAD,)).fetchone())
            db.execute("UPDATE threads SET recency_at_ms=0 WHERE id=?", (THREAD,))
            for index in range(1, 12):
                row = dict(original, id=f"sidebar-thread-{index}", name=f"对话 {index}",
                           recency_at_ms=index * 1000)
                names = list(row)
                db.execute("INSERT INTO threads (" + ",".join('"' + n + '"' for n in names) +
                           ") VALUES (" + ",".join("?" for _ in names) + ")", [row[n] for n in names])
        group = self.store.sidebar()["groups"][0]
        self.assertEqual(group["total"], 12)
        self.assertEqual(len(group["threads"]), 5)
        self.assertEqual(group["threads"][0]["title"], "对话 11")
        page = self.store.sidebar(group_key=group["key"], offset=5)
        self.assertEqual(len(page["rows"]), 5)
        self.assertEqual(page["rows"][0]["title"], "对话 6")
        self.assertEqual(page["nextOffset"], 10)
        self.assertTrue(page["hasMore"])
        last = self.store.sidebar(group_key=group["key"], offset=10)
        self.assertEqual(len(last["rows"]), 2)
        self.assertFalse(last["hasMore"])
        with self.assertRaisesRegex(StoreError, "分组不存在"):
            self.store.sidebar(group_key="invalid-key")


if __name__ == "__main__":
    unittest.main()
