import http.client
import json
import os
import re
import socket
import socketserver
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, urlparse


DOCKER_SOCKET = os.getenv("DOCKER_SOCKET", "/var/run/docker.sock")
PROJECT_NAME = os.getenv("PROJECT_NAME", "qiita_elastic_app")
PORT = int(os.getenv("PORT", "8090"))
HOST_HOSTNAME_FILE = os.getenv("HOST_HOSTNAME_FILE", "/host/etc-hostname")
ACCESS_LOG_DIR = os.getenv("ACCESS_LOG_DIR", "/var/log/qiita-access")
JST = timezone(timedelta(hours=9))
LOG_TAIL_DEFAULT = 200
LOG_TAIL_MAX = 1000
DATE_PARAM_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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


def docker_get_raw(path):
    connection = UnixHTTPConnection("localhost", timeout=4)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, response.read()
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


def container_display_name(container):
    names = container.get("Names") or []
    return names[0].lstrip("/") if names else container["Id"][:12]


def container_metrics(container):
    container_id = container["Id"]
    stats = docker_get(f"/containers/{quote(container_id)}/stats?stream=false")
    usage, limit, memory_percent = memory_values(stats)
    labels = container.get("Labels") or {}
    return {
        "id": container_id[:12],
        "name": container_display_name(container),
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


def find_container(service):
    filters = quote(
        json.dumps({
            "label": [
                f"com.docker.compose.project={PROJECT_NAME}",
                f"com.docker.compose.service={service}",
            ]
        }),
        safe="",
    )
    containers = docker_get(f"/containers/json?all=true&filters={filters}")
    return containers[0] if containers else None


def demux_docker_log_stream(data):
    """Split a Docker logs API response into lines, stripping the 8-byte frame header
    Docker prepends to each chunk when the container has no TTY attached."""
    lines = []
    offset = 0
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset + 4:offset + 8], "big")
        chunk_start = offset + 8
        chunk_end = chunk_start + size
        lines.extend(data[chunk_start:chunk_end].decode("utf-8", errors="replace").splitlines())
        offset = chunk_end
    return lines


def today_jst_date():
    """Date partition key (YYYY-MM-DD) for the current day in JST."""
    return datetime.now(JST).date().isoformat()


def parse_date_param(value):
    """Validate a `date=YYYY-MM-DD` query param. Returns None when absent/empty
    (caller should then default to today), or raises ValueError when malformed."""
    if value is None or value == "":
        return None
    if not DATE_PARAM_RE.match(value):
        raise ValueError(f"invalid date: {value}")
    datetime.strptime(value, "%Y-%m-%d")  # rejects calendar-invalid dates (e.g. 13th month)
    return value


def day_bounds_jst(date_str):
    """Unix timestamp range [since, until) covering one JST calendar date
    (today when date_str is None), used to pass to Docker's logs `since`/`until`
    so only that day's lines are read instead of scanning the full log."""
    if date_str is None:
        start_jst = datetime.now(JST).replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        start_jst = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=JST)
    end_jst = start_jst + timedelta(days=1)
    return int(start_jst.timestamp()), int(end_jst.timestamp())


def parse_tail(value):
    if value is None or not value.isdigit():
        return LOG_TAIL_DEFAULT
    return min(int(value), LOG_TAIL_MAX)


def access_log_path(date_str, log_dir=ACCESS_LOG_DIR):
    return os.path.join(log_dir, f"access-{date_str}.jsonl")


def persistent_access_logs(date_str, tail=None, log_dir=ACCESS_LOG_DIR):
    path = access_log_path(date_str, log_dir)
    try:
        with open(path, encoding="utf-8") as handle:
            if tail is None:
                return [line.rstrip("\n") for line in handle]
            return list(deque((line.rstrip("\n") for line in handle), maxlen=tail))
    except FileNotFoundError:
        return []


def parse_access_log_entry(line):
    """Decode a JSON access log line, accepting the old Docker timestamp prefix too."""
    json_part = line
    if not line.lstrip().startswith("{"):
        separator = line.find(" ")
        json_part = line[separator + 1:] if separator != -1 else line
    try:
        return json.loads(json_part)
    except ValueError:
        return None


def timestamp_to_jst_date(timestamp):
    """Convert an ISO8601 `time` value (nginx logs it in UTC) to its JST calendar
    date, so `dt` lines up with the JST day boundaries used by day_bounds_jst."""
    try:
        return datetime.fromisoformat(timestamp).astimezone(JST).date().isoformat()
    except ValueError:
        return timestamp[:10]


def enrich_log_entry(entry, service, host, container):
    """Reshape a raw access_json entry into a self-contained document suitable for
    direct Elasticsearch/Iceberg ingestion: `time` becomes `@timestamp`, and a `dt`
    date-partition key plus service/host/container metadata are attached."""
    timestamp = entry.get("time")
    enriched = {
        "@timestamp": timestamp,
        "dt": timestamp_to_jst_date(timestamp) if timestamp else None,
        "service": service,
        "host": host,
        "container": container,
    }
    enriched.update((key, value) for key, value in entry.items() if key != "time")
    return enriched


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
        tail = None if full else parse_tail((query.get("tail") or [None])[0])
        target_date = date_param or today_jst_date()
        try:
            if service != "frontend":
                self.send_json(400, {"error": "persistent access logs are only available for frontend"})
                return
            container = find_container(service)
            if container is None:
                raise RuntimeError(f"container not found for service: {service}")
            lines = persistent_access_logs(target_date, tail)
            container_name = container_display_name(container)
            logs = [
                enrich_log_entry(entry, service, HOST_HOSTNAME, container_name)
                for entry in map(parse_access_log_entry, lines)
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
