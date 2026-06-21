import json
import socketserver
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from access_logs import (
    enrich_log_entry,
    parse_access_log_entry,
    parse_date_param,
    parse_tail,
    persistent_access_logs,
    timestamp_to_jst_date,
    today_jst_date,
)
from config import HOST_HOSTNAME, PROJECT_NAME
from container_metrics import (
    container_display_name,
    find_container,
    project_metrics,
)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        routes = {
            "/health": lambda: self.send_json(200, {"status": "ok"}),
            "/metrics": self.handle_metrics,
            "/logs": lambda: self.handle_logs(parse_qs(parsed.query)),
        }
        handler = routes.get(parsed.path)
        if handler is None:
            self.send_json(404, {"error": "not found"})
            return
        handler()

    def handle_metrics(self):
        try:
            self.send_json(
                200,
                {
                    "status": "ok",
                    "project": PROJECT_NAME,
                    "containers": project_metrics(),
                },
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
        tail = None if full else parse_tail((query.get("tail") or [None])[0])
        target_date = date_param or today_jst_date()
        try:
            self._send_access_logs(service, target_date, tail)
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            self.send_json(503, {"status": "error", "error": str(error)})

    def _send_access_logs(self, service, target_date, tail):
        if service != "frontend":
            self.send_json(
                400,
                {"error": "persistent access logs are only available for frontend"},
            )
            return

        container = find_container(service)
        if container is None:
            raise RuntimeError(f"container not found for service: {service}")

        container_name = container_display_name(container)
        logs = [
            enrich_log_entry(entry, service, HOST_HOSTNAME, container_name)
            for entry in map(
                parse_access_log_entry,
                persistent_access_logs(target_date, tail),
            )
            if entry is not None
            and timestamp_to_jst_date(entry.get("time", "")) == target_date
        ]
        self.send_json(
            200,
            {
                "status": "ok",
                "service": service,
                "host": HOST_HOSTNAME,
                "container": container_name,
                "date": target_date,
                "count": len(logs),
                "source": "persistent-volume",
                "logs": logs,
            },
        )

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
