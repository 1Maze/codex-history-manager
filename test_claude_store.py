import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from claude_store import ClaudeStore, parse, prepare, serialize
from store import StoreError, atomic_write


SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER = "11111111-1111-4111-8111-111111111111"
ASSISTANT = "22222222-2222-4222-8222-222222222222"
RESULT = "33333333-3333-4333-8333-333333333333"
FINAL = "44444444-4444-4444-8444-444444444444"


def claude_fixture(home):
    directory = home / "projects" / "project-a"
    directory.mkdir(parents=True)
    cwd = "/workspace/example"
    records = [
        {"type": "mode", "sessionId": SESSION, "mode": "normal"},
        {"type": "user", "uuid": USER, "parentUuid": None, "sessionId": SESSION, "cwd": cwd,
         "timestamp": "2026-11-13T01:00:00Z", "message": {"role": "user", "content": "question one"}},
        {"type": "assistant", "uuid": ASSISTANT, "parentUuid": USER, "sessionId": SESSION, "cwd": cwd,
         "requestRef": "old-request", "message": {"id": "api-message", "role": "assistant", "content": [
             {"type": "thinking", "thinking": "opaque reasoning", "signature": "keep-signature"},
             {"type": "text", "text": "answer one"},
             {"type": "tool_use", "id": "tool-one", "name": "Read", "input": {"file_path": "sample.txt"}}]}},
        {"type": "user", "uuid": RESULT, "parentUuid": ASSISTANT, "sessionId": SESSION,
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "tool-one", "content": "file contents"}]}},
        {"type": "assistant", "uuid": FINAL, "parentUuid": RESULT, "sessionId": SESSION,
         "message": {"role": "assistant", "content": [{"type": "text", "text": "final answer"}]}},
        {"type": "api-request-blob", "hash": "old-hash", "sessionId": SESSION,
         "message": {"role": "assistant", "content": [{"type": "text", "text": "answer one"}]}},
        {"type": "api-request", "sessionId": SESSION, "tail": ["old-hash"]},
        {"type": "last-prompt", "sessionId": SESSION, "lastPrompt": "question one", "leafUuid": FINAL},
        {"type": "unknown-version-record", "future": {"preserve": True}},
    ]
    path = directory / (SESSION + ".jsonl")
    path.write_bytes(serialize(records))
    index = {"version": 1, "entries": [
        {"sessionId": SESSION, "fullPath": str(path), "firstPrompt": "question one", "messageCount": 4,
         "created": "2026-11-13T01:00:00Z", "projectPath": cwd, "extra": "preserve"},
        {"sessionId": "other", "firstPrompt": "unrelated", "messageCount": 9},
    ]}
    (directory / "sessions-index.json").write_text(json.dumps(index))
    history = [
        {"sessionId": SESSION, "project": cwd, "display": "question one", "timestamp": 1, "pastedContents": {}},
        {"sessionId": "other", "project": cwd, "display": "unrelated", "timestamp": 2, "pastedContents": {}},
        {"sessionId": SESSION, "project": "/other/project", "display": "question one", "timestamp": 3},
    ]
    (home / "history.jsonl").write_bytes(serialize(history))
    return path, records


class ClaudeStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="claude-store-test-")
        self.home = Path(self.temp.name)
        self.path, self.records = claude_fixture(self.home)
        self.store = ClaudeStore(self.home, check_processes=False)
        self.identifier = "project-a/" + SESSION

    def tearDown(self):
        self.temp.cleanup()

    def draft(self):
        return json.loads(json.dumps(self.records))

    def test_discovery_and_open_are_read_only(self):
        before = self.path.read_bytes()
        sidebar = self.store.sidebar()
        self.assertEqual(sidebar["total"], 1)
        self.assertEqual(sidebar["groups"][0]["name"], "example")
        opened = self.store.open(self.identifier)
        self.assertEqual(opened["info"]["provider"], "claude")
        self.assertEqual(opened["source"].encode(), before)
        self.assertEqual(self.path.read_bytes(), before)

    def test_backup_title_and_deletion_use_only_selected_snapshot(self):
        first = self.store.backup(self.identifier)
        second = self.store.backup(self.identifier)
        self.path.write_bytes(serialize(self.records).replace(b"question one", b"later prompt"))
        rows = self.store.backups(self.identifier)["rows"]
        row = next(row for row in rows if row["backupId"] == first["backupId"])
        self.assertEqual(row["title"], f"example · {SESSION} · question one")
        self.assertTrue(row["deletable"])
        originals = {p: self.store.read(p) for p in self.store.files(self.path)}
        self.store.delete_backup(first["backupId"])
        self.assertFalse(Path(first["backupPath"]).exists())
        self.assertTrue(Path(second["backupPath"]).exists())
        for path, data in originals.items():
            self.assertEqual(self.store.read(path), data)
        self.assertEqual(len(self.store.backups(self.identifier)["rows"]), 1)

    def test_incomplete_backup_and_copy_journals_cannot_be_deleted(self):
        for status, kind in (("prepared", "save"), ("snapshot", "copy")):
            backup = self.store.backup(self.identifier)
            directory = Path(backup["backupPath"])
            manifest = json.loads((directory / "journal.json").read_text())
            manifest.update(status=status, kind=kind)
            (directory / "journal.json").write_text(json.dumps(manifest))
            with self.assertRaises(StoreError):
                self.store.delete_backup(backup["backupId"])
            self.assertTrue(directory.is_dir())

    def test_text_edits_preserve_signature_tools_and_unknown_records(self):
        opened = self.store.open(self.identifier)
        records = self.draft()
        records[2]["message"]["content"][1]["text"] = "edited answer"
        result = self.store.save(self.identifier, opened["version"], serialize(records).decode())
        saved = parse(result["source"], SESSION)
        assistant = next(r for r in saved if r.get("uuid") == ASSISTANT)
        self.assertEqual(assistant["message"]["content"][0]["signature"], "keep-signature")
        self.assertEqual(assistant["message"]["content"][2]["id"], "tool-one")
        self.assertEqual(assistant["message"]["content"][1]["text"], "edited answer")
        self.assertNotIn("requestRef", assistant)
        self.assertFalse(any(r["type"].startswith("api-request") for r in saved))
        self.assertIn(self.records[-1], saved)
        self.assertTrue((Path(result["backup"]) / "before-0.bin").exists())
        index = json.loads((self.path.parent / "sessions-index.json").read_text())
        self.assertEqual(index["entries"][1]["firstPrompt"], "unrelated")
        self.assertEqual(index["entries"][0]["extra"], "preserve")

    def test_prompt_edit_updates_only_matching_input_history(self):
        opened = self.store.open(self.identifier)
        records = self.draft()
        records[1]["message"]["content"] = "edited question"
        self.store.save(self.identifier, opened["version"], serialize(records).decode())
        history = [json.loads(line) for line in (self.home / "history.jsonl").read_text().splitlines()]
        self.assertEqual(history[0]["display"], "edited question")
        self.assertEqual(history[1]["display"], "unrelated")
        self.assertEqual(history[2]["display"], "question one")
        index = json.loads((self.path.parent / "sessions-index.json").read_text())
        self.assertEqual(index["entries"][0]["firstPrompt"], "edited question")

    def test_delete_reconnects_chain_and_removes_orphan_result(self):
        opened = self.store.open(self.identifier)
        records = [r for r in self.draft() if r.get("uuid") != ASSISTANT]
        result = self.store.save(self.identifier, opened["version"], serialize(records).decode())
        saved = parse(result["source"], SESSION)
        self.assertFalse(any(r.get("uuid") in (ASSISTANT, RESULT) for r in saved))
        self.assertEqual(next(r for r in saved if r.get("uuid") == FINAL)["parentUuid"], USER)
        self.assertEqual(saved[-1]["leafUuid"], FINAL)

    def test_deleted_prompt_becomes_null_parent_and_history_entry_removed(self):
        opened = self.store.open(self.identifier)
        records = [r for r in self.draft() if r.get("uuid") != USER]
        result = self.store.save(self.identifier, opened["version"], serialize(records).decode())
        self.assertIsNone(next(r for r in parse(result["source"], SESSION)
                               if r.get("uuid") == ASSISTANT)["parentUuid"])
        history = [json.loads(line) for line in (self.home / "history.jsonl").read_text().splitlines()]
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["sessionId"], "other")

    def test_invalid_parent_foreign_session_and_signed_edits_rejected(self):
        opened = self.store.open(self.identifier)
        for mutate in (
            lambda rows: rows[1].update(parentUuid=FINAL),
            lambda rows: rows[1].update(sessionId="other"),
            lambda rows: rows[2]["message"]["content"][0].update(signature="changed"),
        ):
            records = self.draft()
            mutate(records)
            with self.assertRaises(StoreError):
                self.store.save(self.identifier, opened["version"], serialize(records).decode())
        self.assertEqual(self.path.read_bytes(), serialize(self.records))

    def test_active_session_rejects_write_but_allows_independent_copy(self):
        (self.home / "sessions").mkdir()
        (self.home / "sessions" / f"{os.getpid()}.json").write_text(json.dumps({"pid": os.getpid(), "sessionId": SESSION}))
        opened = self.store.open(self.identifier)
        originals = {p: p.read_bytes() for p in self.store.files(self.path)}
        with self.assertRaises(StoreError) as error:
            self.store.save(self.identifier, opened["version"], opened["source"])
        self.assertEqual(error.exception.code, "writer_locked")
        copied = self.store.create_edited_copy(self.identifier, opened["version"], opened["source"], opened["source"])
        new = self.store.open(copied["threadId"])
        self.assertNotEqual(new["info"]["metadata"]["sessionId"], SESSION)
        self.assertIn("编辑副本", new["info"]["metadata"]["name"])
        for p, value in originals.items():
            self.assertEqual(p.read_bytes(), value)

    def test_non_utf8_process_arguments_allow_save_when_claude_is_inactive(self):
        self.store.check_processes = True
        opened = self.store.open(self.identifier)
        result = subprocess.CompletedProcess(
            ["ps"], 0, stdout=b"/usr/bin/unrelated unrelated \xe4\xb8\n", stderr=b"\xff")
        with patch("claude_store.subprocess.run", return_value=result) as run:
            saved = self.store.save(self.identifier, opened["version"], opened["source"])
        self.assertIn("backup", saved)
        self.assertEqual(run.call_count, 2)
        self.assertNotIn("text", run.call_args.kwargs)
        self.assertTrue(run.call_args.kwargs["capture_output"])

    def test_non_utf8_process_arguments_do_not_hide_active_claude(self):
        self.store.check_processes = True
        opened = self.store.open(self.identifier)
        before = {p: p.read_bytes() for p in self.store.files(self.path)}
        for process in (
            b"/usr/local/bin/claude claude --resume session",
            b"/Users/example/.local/share/claude/versions/2.1.311",
            b"node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        ):
            with self.subTest(process=process):
                result = subprocess.CompletedProcess(
                    ["ps"], 0, stdout=b"/usr/bin/other other \xff\n" + process + b" \xe4\xb8\n",
                    stderr=b"\xff")
                with patch("claude_store.subprocess.run", return_value=result):
                    with self.assertRaises(StoreError) as error:
                        self.store.save(self.identifier, opened["version"], opened["source"])
                self.assertEqual(error.exception.code, "writer_locked")
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)

    def test_process_check_failure_still_blocks_writes(self):
        self.store.check_processes = True
        for result in (
            subprocess.CompletedProcess(["ps"], 1, stdout=b"", stderr=b"\xff"),
            OSError("process list unavailable"),
            subprocess.TimeoutExpired(["ps"], 5),
        ):
            with self.subTest(result=result):
                kwargs = {"side_effect": result} if isinstance(result, Exception) else {"return_value": result}
                with patch("claude_store.subprocess.run", **kwargs):
                    with self.assertRaisesRegex(StoreError, "无法检查 Claude 进程") as error:
                        self.store.assert_inactive()
                self.assertEqual(error.exception.status, 503)

    def test_conversation_and_history_decoding_remain_strict(self):
        original = self.path.read_bytes()
        self.path.write_bytes(original + b"\xff")
        with self.assertRaises(UnicodeDecodeError):
            self.store.open(self.identifier)
        self.path.write_bytes(original)
        history = self.home / "history.jsonl"
        history.write_bytes(history.read_bytes() + b"\xff")
        opened = self.store.open(self.identifier)
        with self.assertRaises(UnicodeDecodeError):
            self.store.save(self.identifier, opened["version"], opened["source"])
        self.assertEqual(self.path.read_bytes(), original)

    def test_changed_file_and_sidecar_rejected(self):
        opened = self.store.open(self.identifier)
        (self.home / "history.jsonl").write_bytes(serialize([{"display": "external"}]))
        with self.assertRaisesRegex(StoreError, "外部修改"):
            self.store.save(self.identifier, opened["version"], opened["source"])

    def test_backup_restore_and_rollback(self):
        backup = self.store.backup(self.identifier)
        opened = self.store.open(self.identifier)
        records = self.draft()
        records[1]["message"]["content"] = "new question"
        changed = self.store.save(self.identifier, opened["version"], serialize(records).decode())
        restored = self.store.restore(self.identifier, changed["version"], backup["backupId"])
        self.assertEqual(next(r for r in parse(restored["source"], SESSION)
                              if r.get("uuid") == USER)["message"]["content"], "question one")
        opened = self.store.open(self.identifier)
        originals = {p: p.read_bytes() for p in self.store.files(self.path)}
        calls = 0
        def fail_index(path, data, *args):
            nonlocal calls
            if path == self.path.parent.resolve() / "sessions-index.json" and calls == 0:
                calls += 1
                raise OSError("fixture write failure")
            return atomic_write(path, data, *args)
        with patch("claude_store.atomic_write", side_effect=fail_index):
            with self.assertRaisesRegex(OSError, "fixture write failure"):
                self.store.save(self.identifier, opened["version"], opened["source"])
        for p, value in originals.items():
            self.assertEqual(p.read_bytes(), value)

    def test_path_escape_and_bad_backup_id(self):
        for identifier in ("../" + SESSION, "project-a/../../secret", "project-a/" + SESSION + "/more"):
            with self.assertRaises(StoreError):
                self.store.open(identifier)
        with self.assertRaises(StoreError):
            self.store.restore(self.identifier, "version", "../bad")

    def test_unicode_line_separator_and_duplicate_request_tool_snapshots(self):
        records = self.draft()
        records[1]["message"]["content"] = "before\u2028after"
        source = serialize(records).decode()
        prepared, _, _ = prepare(source, source, SESSION)
        self.assertEqual(next(r for r in prepared if r.get("uuid") == USER)["message"]["content"], "before\u2028after")

    def test_restore_reinstates_deleted_input_without_reverting_other_sessions(self):
        backup = self.store.backup(self.identifier)
        opened = self.store.open(self.identifier)
        records = [r for r in self.draft() if r.get("uuid") != USER]
        changed = self.store.save(self.identifier, opened["version"], serialize(records).decode())
        history_path = self.home / "history.jsonl"
        history = [json.loads(line) for line in history_path.read_text().splitlines()]
        history.append({"sessionId": "new-other", "project": "/other", "display": "new entry", "timestamp": 4})
        history_path.write_bytes(serialize(history))
        current = self.store.open(self.identifier)
        self.store.restore(self.identifier, current["version"], backup["backupId"])
        restored = [json.loads(line) for line in history_path.read_text().splitlines()]
        self.assertEqual(restored[0]["display"], "question one")
        self.assertIn(history[-1], restored)

    def test_duplicate_session_uuid_in_another_project_is_isolated(self):
        directory = self.home / "projects" / "project-b"
        directory.mkdir()
        other = self.draft()
        for record in other:
            if "cwd" in record:
                record["cwd"] = "/workspace/other"
        other_path = directory / (SESSION + ".jsonl")
        other_path.write_bytes(serialize(other))
        before = other_path.read_bytes()
        self.assertEqual(self.store.sidebar()["total"], 2)
        opened = self.store.open(self.identifier)
        draft = self.draft()
        draft[1]["message"]["content"] = "only project a"
        self.store.save(self.identifier, opened["version"], serialize(draft).decode())
        self.assertEqual(other_path.read_bytes(), before)

    def test_incomplete_journal_blocks_further_writes(self):
        backup = self.store.backup(self.identifier)
        path = Path(backup["backupPath"]) / "journal.json"
        entry = json.loads(path.read_text())
        entry["status"] = "prepared"
        path.write_text(json.dumps(entry))
        opened = self.store.open(self.identifier)
        with self.assertRaisesRegex(StoreError, "未完成"):
            self.store.save(self.identifier, opened["version"], opened["source"])

    def test_unknown_message_field_is_preserved(self):
        records = self.draft()
        records.append({"type": "future-metadata", "message": "not a conversation object"})
        source = serialize(records).decode()
        output, _, _ = prepare(source, source, SESSION)
        self.assertIn(records[-1], output)

    def test_duplicate_tool_snapshots_are_not_treated_as_corruption(self):
        records = self.draft()
        duplicate = {"type": "assistant", "uuid": "55555555-5555-4555-8555-555555555555",
                     "parentUuid": ASSISTANT, "sessionId": SESSION, "message": {
                         "role": "assistant", "id": "api-message", "content": [
                             {"type": "tool_use", "id": "tool-one", "name": "Read", "input": {"file_path": "updated.txt"}}]}}
        records.insert(3, duplicate)
        records[4]["parentUuid"] = duplicate["uuid"]
        source = serialize(records).decode()
        output, _, _ = prepare(source, source, SESSION)
        self.assertIn(duplicate, output)
        self.assertTrue(any(r.get("uuid") == RESULT for r in output))

    def test_invalid_parent_type_and_new_forged_signature_rejected(self):
        records = self.draft()
        records[1]["parentUuid"] = []
        with self.assertRaisesRegex(StoreError, "parentUuid"):
            prepare(serialize(records).decode(), serialize(self.records).decode(), SESSION)
        records = self.draft()
        records[2]["uuid"] = "55555555-5555-4555-8555-555555555555"
        records[2]["message"]["content"][0]["signature"] = "forged"
        with self.assertRaisesRegex(StoreError, "伪造"):
            prepare(serialize(records).decode(), serialize(self.records).decode(), SESSION)

    def test_external_snake_case_session_metadata_is_not_ownership(self):
        records = self.draft()
        external = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        records[1]["session_id"] = external
        self.path.write_bytes(serialize(records))
        opened = self.store.open(self.identifier)
        copy = self.store.create_edited_copy(self.identifier, opened["version"], opened["source"], opened["source"])
        copied = self.store.open(copy["threadId"])
        user = next(r for r in parse(copied["source"], copied["info"]["metadata"]["sessionId"])
                    if r.get("uuid") == USER)
        self.assertEqual(user["session_id"], external)
        self.assertNotEqual(user["sessionId"], SESSION)


if __name__ == "__main__":
    unittest.main()
