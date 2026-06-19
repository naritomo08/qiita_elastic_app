import http.client
import json
import os
import socket
import socketserver
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler
from urllib.parse import quote


DOCKER_SOCKET = os.getenv("DOCKER_SOCKET", "/var/run/docker.sock")
PROJECT_NAME = os.getenv("PROJECT_NAME", "qiita_elastic_app")
PORT = int(os.getenv("PORT", "8090"))


class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(DOCKER_SOCKET)


def docker_get(path):
    connection = UnixHTTPConnection("localhost", timeout=4)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        if response.status != 200:
            raise RuntimeError(f"Docker API returned {response.status}")
        return json.loads(body)
    finally:
        connection.close()


def cpu_percent(stats):
    cpu = stats.get("cpu_stats", {})
    previous = stats.get("precpu_stats", {})
    cpu_delta = cpu.get("cpu_usage", {}).get("total_usage", 0) - previous.get(
        "cpu_usage", {}
    ).get("total_usage", 0)
    system_delta = cpu.get("system_cpu_usage", 0) - previous.get(
        "system_cpu_usage", 0
    )
    online_cpus = cpu.get("online_cpus") or len(
        cpu.get("cpu_usage", {}).get("percpu_usage", [])
    )
    if cpu_delta <= 0 or system_delta <= 0 or online_cpus <= 0:
        return 0.0
    return cpu_delta / system_delta * online_cpus * 100.0


def memory_values(stats):
    memory = stats.get("memory_stats", {})
    raw_usage = memory.get("usage", 0)
    details = memory.get("stats", {})
    cache = details.get("total_inactive_file", details.get("cache", 0))
    usage = max(0, raw_usage - cache)
    limit = memory.get("limit", 0)
    percent = usage / limit * 100.0 if limit else 0.0
    return usage, limit, percent


def container_metrics(container):
    container_id = container["Id"]
    stats = docker_get(f"/containers/{quote(container_id)}/stats?stream=false")
    usage, limit, memory_percent = memory_values(stats)
    labels = container.get("Labels") or {}
    names = container.get("Names") or []
    return {
        "id": container_id[:12],
        "name": names[0].lstrip("/") if names else container_id[:12],
        "service": labels.get("com.docker.compose.service", ""),
        "state": container.get("State", ""),
        "status": container.get("Status", ""),
        "cpu_percent": round(cpu_percent(stats), 2),
        "memory_usage_bytes": usage,
        "memory_limit_bytes": limit,
        "memory_percent": round(memory_percent, 2),
    }


def project_metrics():
    filters = quote(
        json.dumps({"label": [f"com.docker.compose.project={PROJECT_NAME}"]}),
        safe="",
    )
    containers = docker_get(f"/containers/json?all=true&filters={filters}")
    running = [container for container in containers if container.get("State") == "running"]
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(running)))) as executor:
        results = list(executor.map(container_metrics, running))
    return sorted(results, key=lambda item: item["service"])


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok"})
            return
        if self.path != "/metrics":
            self.send_json(404, {"error": "not found"})
            return
        try:
            self.send_json(
                200,
                {"status": "ok", "project": PROJECT_NAME, "containers": project_metrics()},
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
