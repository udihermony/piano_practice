#!/usr/bin/env python3
"""
Dev server for piano_practice.
- Serves static files on GET (like http.server)
- Accepts POST /save  { filename, data } → writes JSON to ./sessions/
"""
import http.server, json, os, sys
from datetime import datetime
from pathlib import Path

PORT = 8000
SESSIONS_DIR = Path(__file__).parent / "sessions"
SESSIONS_DIR.mkdir(exist_ok=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/save":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                payload = json.loads(body)
                filename = payload.get("filename") or \
                    "session-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"
                # Strip any path components for safety
                filename = Path(filename).name
                out_path = SESSIONS_DIR / filename
                out_path.write_text(json.dumps(payload.get("data", payload), indent=2))
                print(f"  → saved {out_path}")
                self._respond(200, {"ok": True, "path": str(out_path)})
            except Exception as e:
                self._respond(500, {"ok": False, "error": str(e)})
        else:
            self._respond(404, {"ok": False, "error": "not found"})

    def _respond(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Suppress per-request noise for GET, keep POST logs
        if args and str(args[1]) == "200" and "GET" in str(args[0]):
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    os.chdir(Path(__file__).parent)
    print(f"Serving on http://localhost:{PORT}")
    print(f"Sessions saved to: {SESSIONS_DIR}/")
    http.server.test(HandlerClass=Handler, port=PORT, bind="0.0.0.0")
