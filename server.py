"""Loopback-only web server for the local ChatStore."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import sqlite3
from urllib.parse import parse_qs, urlparse

from store import ChatStore, StoreError, encode
from recovery import RecoveryService
from claude_store import ClaudeStore


STATIC = Path(__file__).parent / "static"
ASSETS = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8",
          "style.css": "text/css; charset=utf-8", "lucide.min.js": "text/javascript",
          "LUCIDE-LICENSE": "text/plain; charset=utf-8", "marked.umd.js": "text/javascript",
          "transcript.js": "text/javascript; charset=utf-8", "MARKED-LICENSE": "text/plain"}


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store, claude_store=None):
        super().__init__(address, Handler)
        self.store = store
        self.recovery = RecoveryService(store) if store is not None else None
        self.claude = claude_store or ClaudeStore()
        self.token = secrets.token_urlsafe(32)
        self.origin = f"http://127.0.0.1:{self.server_port}"

    def provider(self, name):
        if name == "claude":
            return self.claude, self.claude
        if name != "codex":
            raise StoreError("未知的聊天来源。")
        if self.store is None:
            raise StoreError("未检测到 Codex 本地数据库。", 404)
        return self.store, self.recovery


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if not self.path.startswith("/api/thread"):
            super().log_message(format, *args)

    def respond(self, code, content, mime="application/json; charset=utf-8"):
        raw = encode(content).encode("utf-8") if isinstance(content, (dict, list)) else content
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'")
        self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()
        self.wfile.write(raw)

    def security(self, authenticated=True, allow_navigation=False):
        expected = urlparse(self.server.origin).netloc
        if self.headers.get("Host") != expected:
            raise StoreError("Host 不匹配，仅允许 127.0.0.1。", 403)
        origin = self.headers.get("Origin")
        if origin and origin != self.server.origin:
            raise StoreError("不允许跨站请求。", 403)
        # An external link may navigate to the shell, but never to data or write APIs.
        navigation = (allow_navigation and self.command == "GET"
                      and self.headers.get("Sec-Fetch-Mode") == "navigate"
                      and self.headers.get("Sec-Fetch-Dest") == "document")
        if self.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site") and not navigation:
            raise StoreError("仅允许本机同源页面。", 403)
        if authenticated and not secrets.compare_digest(
                self.headers.get("X-Chat-Sync-Token", ""), self.server.token):
            raise StoreError("缺少本地访问令牌，请刷新页面。", 403)

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            self.security(False, allow_navigation=parsed.path in ("/", "/index.html"))
            if parsed.path == "/api/bootstrap":
                return self.respond(200, {
                    "token": self.server.token,
                    "home": str(self.server.store.home if self.server.store else self.server.claude.home),
                    "databases": [str(self.server.store.state_db), str(self.server.store.history_db)] if self.server.store else [],
                    "defaultProvider": "codex" if self.server.store else "claude",
                    "providers": [
                        {"id": "codex", "label": "Codex", "available": self.server.store is not None},
                        {"id": "claude", "label": "Claude Code", "available": self.server.claude.projects.is_dir(),
                         "home": str(self.server.claude.home)},
                    ],
                })
            if parsed.path.startswith("/api/"):
                self.security()
                args = {k: values[-1] for k, values in parse_qs(parsed.query).items()}
                thread_id = args.get("id", "")
                provider = args.get("provider", "codex")
                store, maintenance = self.server.provider(provider)
                offset = max(0, int(args.get("offset", 0)))
                limit = min(100, max(1, int(args.get("limit", 30))))
                if parsed.path == "/api/threads":
                    if provider == "claude":
                        sidebar = store.sidebar(args.get("q", ""), limit=1000000)
                        rows = [r for g in sidebar["groups"] for r in g["threads"]]
                        result = {"rows": rows[offset:offset + limit], "total": len(rows)}
                    else:
                        result = store.threads(args.get("q", ""), offset, limit)
                elif parsed.path == "/api/sidebar":
                    result = store.sidebar(args.get("q", ""), project_key=args.get("project"))
                elif parsed.path == "/api/sidebar/group":
                    result = store.sidebar(args.get("q", ""), args.get("key", ""),
                                                       offset, min(limit, 5))
                elif parsed.path == "/api/open":
                    result = store.open(thread_id)
                elif parsed.path == "/api/info":
                    result = store.inspect(thread_id)
                elif parsed.path == "/api/table":
                    if provider == "claude":
                        raise StoreError("Claude Code 使用 JSONL，不提供 Codex SQLite 视图。")
                    result = store.table(thread_id, args.get("table", ""),
                                                     offset, limit)
                elif parsed.path == "/api/backups":
                    result = maintenance.backups(thread_id or None)
                else:
                    raise StoreError("接口不存在。", 404)
                return self.respond(200, result)
            asset = "index.html" if parsed.path == "/" else parsed.path[1:]
            if asset not in ASSETS:
                raise StoreError("文件不存在。", 404)
            self.respond(200, (STATIC / asset).read_bytes(), ASSETS[asset])
        except (StoreError, ValueError, sqlite3.Error, OSError) as error:
            self.respond(error.status if isinstance(error, StoreError) else 400,
                         {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        try:
            self.security()
            if self.headers.get("Origin") != self.server.origin:
                raise StoreError("写入请求必须来自本机同源页面。", 403)
            route = urlparse(self.path).path
            if route not in ("/api/save", "/api/copy", "/api/backup", "/api/backups/delete", "/api/restore", "/api/recovery/preview", "/api/recovery/create"):
                raise StoreError("接口不存在。", 404)
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise StoreError("需要 application/json 请求。", 415)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 256 * 1024 * 1024:
                raise StoreError("请求大小超出限制。", 413)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise StoreError("请求必须为 JSON 对象。")
            provider = body.get("provider", "codex")
            store, maintenance = self.server.provider(provider)
            if provider == "claude" and route.startswith("/api/recovery/"):
                raise StoreError("Claude Code 当前提供编辑、删除、备份和恢复，不提供 Codex 对话截选。")
            if route == "/api/save":
                result = store.save(body.get("id"), body.get("version"),
                                               body.get("source"), body.get("mirror", True))
            elif route == "/api/copy":
                result = maintenance.create_edited_copy(body.get("id"), body.get("version"),
                    body.get("source"), body.get("baselineSource"), body.get("mirror", True))
            elif route == "/api/backup":
                result = maintenance.backup(body.get("id"))
            elif route == "/api/backups/delete":
                result = maintenance.delete_backup(body.get("backupId"))
            elif route == "/api/restore":
                result = maintenance.restore(body.get("id"), body.get("version"), body.get("backupId"))
            elif route == "/api/recovery/preview":
                result = maintenance.preview(body.get("id"), body.get("version"), body.get("keep", 1))
            else:
                result = maintenance.create_copy(body.get("id"), body.get("version"), body.get("keep", 1),
                                                         body.get("handoff"), mode=body.get("mode", "conversation"))
            self.respond(200, result)
        except (StoreError, ValueError, sqlite3.Error, OSError) as error:
            self.respond(error.status if isinstance(error, StoreError) else 400,
                         {"error": str(error), **({"code": error.code} if isinstance(error, StoreError) and error.code else {})})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", default=None)
    parser.add_argument("--port", type=int, default=5189)
    parser.add_argument("--claude-home", default=None)
    args = parser.parse_args()
    home = Path(args.home or os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
    codex = ChatStore(home) if (home / "state_5.sqlite").is_file() and (home / "thread_history_1.sqlite").is_file() else None
    server = LocalServer(("127.0.0.1", args.port), codex, ClaudeStore(args.claude_home))
    print(server.origin, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
