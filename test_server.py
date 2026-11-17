import http.client
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import Mock

from server import LocalServer
from store import StoreError


class ServerSecurityTests(unittest.TestCase):
    def setUp(self):
        self.store = Mock()
        self.store.home = Path("/fixture")
        self.store.state_db = self.store.home / "state_5.sqlite"
        self.store.history_db = self.store.home / "thread_history_1.sqlite"
        self.store.save.return_value = {"saved": True}
        self.server = LocalServer(("127.0.0.1", 0), self.store)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=5)

    def request(self, path="/", headers=None, method="GET", body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def navigation_headers(self, site="cross-site"):
        return {"Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Dest": "document"}

    def test_external_top_level_navigation_to_home_is_allowed(self):
        for site in ("cross-site", "same-site"):
            for path in ("/", "/index.html", "/?from=chat"):
                with self.subTest(site=site, path=path):
                    status, body = self.request(path, self.navigation_headers(site))
                    self.assertEqual(status, 200)
                    self.assertIn("对话截选".encode(), body)
        self.store.save.assert_not_called()

    def test_cross_site_fetches_and_frames_remain_blocked(self):
        for mode, destination in (("cors", "empty"), ("no-cors", "image"),
                                  ("navigate", "iframe"), ("navigate", "empty")):
            with self.subTest(mode=mode, destination=destination):
                headers = self.navigation_headers()
                headers.update({"Sec-Fetch-Mode": mode, "Sec-Fetch-Dest": destination})
                self.assertEqual(self.request(headers=headers)[0], 403)
        self.assertEqual(self.request(headers={"Sec-Fetch-Site": "cross-site"})[0], 403)

    def test_navigation_exception_does_not_allow_api_or_assets(self):
        headers = {**self.navigation_headers(), "X-Chat-Sync-Token": self.server.token}
        for path in ("/api/bootstrap", "/api/open?id=fixture", "/app.js"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path, headers)[0], 403)
        self.store.open.assert_not_called()

    def test_navigation_still_validates_host_and_origin(self):
        for extra in ({"Host": "attacker.invalid"}, {"Origin": "https://attacker.invalid"}):
            with self.subTest(extra=extra):
                headers = {**self.navigation_headers(), **extra}
                self.assertEqual(self.request(headers=headers)[0], 403)

    def test_same_origin_bootstrap_works_and_api_needs_token(self):
        headers = {"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors",
                   "Sec-Fetch-Dest": "empty"}
        status, body = self.request("/api/bootstrap", headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["token"], self.server.token)
        self.assertEqual(self.request("/api/open?id=fixture", headers)[0], 403)
        self.store.open.assert_not_called()

    def test_write_guards_remain_enabled(self):
        allowed = {"Sec-Fetch-Site": "same-origin", "Origin": self.server.origin,
                   "X-Chat-Sync-Token": self.server.token, "Content-Type": "application/json"}
        for extra in ({"Sec-Fetch-Site": "cross-site"}, {"Origin": "https://attacker.invalid"},
                      {"Origin": ""}, {"X-Chat-Sync-Token": ""}):
            with self.subTest(extra=extra):
                self.assertEqual(self.request("/api/save", {**allowed, **extra}, "POST", "{}")[0], 403)
        self.store.save.assert_not_called()
        self.assertEqual(self.request("/api/save", allowed, "POST", "{}")[0], 200)
        self.store.save.assert_called_once()

    def test_writer_lock_error_has_structured_code(self):
        self.store.save.side_effect = StoreError("held by Codex", 409, code="writer_locked")
        headers = {"Origin": self.server.origin, "X-Chat-Sync-Token": self.server.token,
                   "Content-Type": "application/json"}
        status, body = self.request("/api/save", headers, "POST", "{}")
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)["code"], "writer_locked")

    def test_copy_endpoint_requires_same_origin_and_token(self):
        self.server.recovery = Mock()
        self.server.recovery.create_edited_copy.return_value = {"threadId": "copy"}
        headers = {"Origin": self.server.origin, "X-Chat-Sync-Token": self.server.token,
                   "Content-Type": "application/json"}
        for extra in ({"Origin": "https://attacker.invalid"}, {"X-Chat-Sync-Token": ""},
                      {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(extra=extra):
                self.assertEqual(self.request("/api/copy", {**headers, **extra}, "POST", "{}")[0], 403)
        self.server.recovery.create_edited_copy.assert_not_called()
        status, _ = self.request("/api/copy", headers, "POST", json.dumps({
            "id": "thread", "version": "snapshot", "source": "draft", "baselineSource": "original"}))
        self.assertEqual(status, 200)
        self.server.recovery.create_edited_copy.assert_called_once_with(
            "thread", "snapshot", "draft", "original", True)

    def test_claude_routes_do_not_call_codex_store(self):
        self.server.claude = Mock()
        self.server.claude.open.return_value = {"source": "Claude"}
        self.server.claude.save.return_value = {"saved": True}
        headers = {"Origin": self.server.origin, "X-Chat-Sync-Token": self.server.token,
                   "Content-Type": "application/json"}
        status, body = self.request("/api/open?provider=claude&id=project/session", headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["source"], "Claude")
        self.store.open.assert_not_called()
        status, _ = self.request("/api/save", headers, "POST", json.dumps({
            "provider": "claude", "id": "project/session", "source": "draft", "version": "version"}))
        self.assertEqual(status, 200)
        self.server.claude.save.assert_called_once_with("project/session", "version", "draft", True)
        self.store.save.assert_not_called()
        self.assertEqual(self.request("/api/table?provider=claude&id=session", headers)[0], 400)
        self.store.table.assert_not_called()
        self.assertEqual(self.request("/api/open?provider=unrecognized", headers)[0], 400)


    def test_backup_deletion_guards_and_provider_isolation(self):
        self.server.recovery = Mock()
        self.server.claude = Mock()
        headers = {"Origin": self.server.origin, "X-Chat-Sync-Token": self.server.token,
                   "Content-Type": "application/json"}
        for provider, maintenance in (("codex", self.server.recovery), ("claude", self.server.claude)):
            maintenance.delete_backup.return_value = {"deleted": "fixture-backup"}
            body = json.dumps({"provider": provider, "backupId": "fixture-backup"})
            for extra in ({"Origin": "https://attacker.invalid"}, {"Origin": ""},
                          {"X-Chat-Sync-Token": ""}, {"Sec-Fetch-Site": "cross-site"}):
                with self.subTest(provider=provider, extra=extra):
                    self.assertEqual(self.request("/api/backups/delete", {**headers, **extra}, "POST", body)[0], 403)
            maintenance.delete_backup.assert_not_called()
            status, raw = self.request("/api/backups/delete", headers, "POST", body)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw)["deleted"], "fixture-backup")
            maintenance.delete_backup.assert_called_once_with("fixture-backup")
        self.store.save.assert_not_called()
        self.server.claude.save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
