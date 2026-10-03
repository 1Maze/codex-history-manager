"""Loopback-only web server for the local ChatStore."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sqlite3
from urllib.parse import parse_qs, urlparse

from store import ChatStore, StoreError, encode
from recovery import RecoveryService


STATIC = Path(__file__).parent / "static"
ASSETS = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8",
          "style.css": "text/css; charset=utf-8", "lucide.min.js": "text/javascript",
          "LUCIDE-LICENSE": "text/plain; charset=utf-8", "marked.umd.js": "text/javascript",
          "transcript.js": "text/javascript; charset=utf-8", "MARKED-LICENSE": "text/plain"}


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store):
        super().__init__(address, Handler)
        self.store = store
        self.recovery = RecoveryService(store)
        self.token = secrets.token_urlsafe(32)
        self.origin = f"http://127.0.0.1:{self.server_port}"


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

    def security(self, authenticated=True):
        expected = urlparse(self.server.origin).netloc
        if self.headers.get("Host") != expected:
            raise StoreError("Host 不匹配，仅允许 127.0.0.1。", 403)
        origin = self.headers.get("Origin")
        if origin and origin != self.server.origin:
            raise StoreError("不允许跨站请求。", 403)
        if self.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site"):
            raise StoreError("仅允许本机同源页面。", 403)
        if authenticated and not secrets.compare_digest(
                self.headers.get("X-Chat-Sync-Token", ""), self.server.token):
            raise StoreError("缺少本地访问令牌，请刷新页面。", 403)

    def do_GET(self):
        try:
            self.security(False)
            parsed = urlparse(self.path)
            if parsed.path == "/api/bootstrap":
                return self.respond(200, {
                    "token": self.server.token, "home": str(self.server.store.home),
                    "databases": [str(self.server.store.state_db), str(self.server.store.history_db)],
                })
            if parsed.path.startswith("/api/"):
                self.security()
                args = {k: values[-1] for k, values in parse_qs(parsed.query).items()}
                thread_id = args.get("id", "")
                offset = max(0, int(args.get("offset", 0)))
                limit = min(100, max(1, int(args.get("limit", 30))))
                if parsed.path == "/api/threads":
                    result = self.server.store.threads(args.get("q", ""), offset, limit)
                elif parsed.path == "/api/sidebar":
                    result = self.server.store.sidebar(args.get("q", ""), project_key=args.get("project"))
                elif parsed.path == "/api/sidebar/group":
                    result = self.server.store.sidebar(args.get("q", ""), args.get("key", ""),
                                                       offset, min(limit, 5))
                elif parsed.path == "/api/open":
                    result = self.server.store.open(thread_id)
                elif parsed.path == "/api/info":
                    result = self.server.store.inspect(thread_id)
                elif parsed.path == "/api/table":
                    result = self.server.store.table(thread_id, args.get("table", ""),
                                                     offset, limit)
                elif parsed.path == "/api/backups":
                    result = self.server.recovery.backups(thread_id or None)
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
            if route not in ("/api/save", "/api/backup", "/api/restore", "/api/recovery/preview", "/api/recovery/create"):
                raise StoreError("接口不存在。", 404)
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise StoreError("需要 application/json 请求。", 415)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 256 * 1024 * 1024:
                raise StoreError("请求大小超出限制。", 413)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise StoreError("请求必须为 JSON 对象。")
            if route == "/api/save":
                result = self.server.store.save(body.get("id"), body.get("version"),
                                               body.get("source"), body.get("mirror", True))
            elif route == "/api/backup":
                result = self.server.recovery.backup(body.get("id"))
            elif route == "/api/restore":
                result = self.server.recovery.restore(body.get("id"), body.get("version"), body.get("backupId"))
            elif route == "/api/recovery/preview":
                result = self.server.recovery.preview(body.get("id"), body.get("version"), body.get("keep", 1))
            else:
                result = self.server.recovery.create_copy(body.get("id"), body.get("version"), body.get("keep", 1),
                                                         body.get("handoff"), mode=body.get("mode", "conversation"))
            self.respond(200, result)
        except (StoreError, ValueError, sqlite3.Error, OSError) as error:
            self.respond(error.status if isinstance(error, StoreError) else 400,
                         {"error": str(error)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", default=None)
    parser.add_argument("--port", type=int, default=5189)
    args = parser.parse_args()
    server = LocalServer(("127.0.0.1", args.port), ChatStore(args.home))
    print(server.origin, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
