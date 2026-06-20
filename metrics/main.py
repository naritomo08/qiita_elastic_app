import json
import socket
import socketserver
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from config import HOST_HOSTNAME_FILE, LOG_FULL_DAY_MAX, PORT, PROJECT_NAME
from logs import (
    container_logs,
    day_bounds_jst,
    enrich_log_entry,
    parse_date_param,
    parse_tail,
    today_jst_date,
)
from metrics import container_display_name, project_metrics


def read_host_hostname():
    """Resolve the Docker *host* machine's hostname (not the container's own),
    by reading the host's /etc/hostname bind-mounted read-only into the container.
    Falls back to the container hostname when the file isn't mounted (e.g. local dev)."""
    try:
        with open(HOST_HOSTNAME_FILE, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return socket.gethostname()


HOST_HOSTNAME = read_host_hostname()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"status": "ok"})
            return
        if parsed.path == "/metrics":
            self.handle_metrics()
            return
        if parsed.path == "/logs":
            self.handle_logs(parse_qs(parsed.query))
            return
        self.send_json(404, {"error": "not found"})

    def handle_metrics(self):
        try:
            self.send_json(
                200,
                {"status": "ok", "project": PROJECT_NAME, "containers": project_metrics()},
            )
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            self.send_json(503, {"status": "error", "error": str(error)})

    def handle_logs(self, query):
        service = (query.get("service") or [""])[0].strip()
        if not service:
            self.send_json(400, {"error": "service is required"})
            return
        try:
            date_param = parse_date_param((query.get("date") or [None])[0])
        except ValueError:
            self.send_json(400, {"error": "invalid date, expected YYYY-MM-DD"})
            return
        full = (query.get("full") or [""])[0] == "1"
        tail = LOG_FULL_DAY_MAX if full else parse_tail((query.get("tail") or [None])[0])
        since, until = day_bounds_jst(date_param)
        try:
            container, lines = container_logs(service, tail, since, until)
            container_name = container_display_name(container)
            logs = [
                enrich_log_entry(entry, service, HOST_HOSTNAME, container_name)
                for entry in map(parse_access_log_entry, lines)
                if entry is not None
            ]
            self.send_json(
                200,
                {
                    "status": "ok",
                    "service": service,
                    "host": HOST_HOSTNAME,
                    "container": container_name,
                    "date": date_param or today_jst_date(),
                    "count": len(logs),
                    "logs": logs,
                },
            )
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            self.send_json(503, {"status": "error", "error": str(error)})

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_, *args):
        print(f"{self.address_string()} - {format_ % args}", flush=True)


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as server:
        server.serve_forever()
