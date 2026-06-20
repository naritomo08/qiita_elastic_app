import json
from datetime import datetime, timedelta
from urllib.parse import quote

from config import DATE_PARAM_RE, JST, LOG_TAIL_DEFAULT, LOG_TAIL_MAX
from docker_client import docker_get_raw
from metrics import find_container


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


def container_logs(service, tail, since, until):
    container = find_container(service)
    if container is None:
        raise RuntimeError(f"container not found for service: {service}")
    status, body = docker_get_raw(
        f"/containers/{quote(container['Id'])}/logs"
        f"?stdout=1&stderr=1&timestamps=1&tail={tail}&since={since}&until={until}"
    )
    if status != 200:
        raise RuntimeError(f"Docker API returned {status}")
    return container, demux_docker_log_stream(body)


def parse_tail(value):
    if value is None or not value.isdigit():
        return LOG_TAIL_DEFAULT
    return min(int(value), LOG_TAIL_MAX)


def parse_access_log_entry(line):
    """Strip the Docker `timestamps=1` prefix and decode the JSON access_log entry."""
    separator = line.find(" ")
    json_part = line[separator + 1:] if separator != -1 else line
    try:
        return json.loads(json_part)
    except ValueError:
        return None


def enrich_log_entry(entry, service, host, container):
    """Reshape a raw access_json entry into a self-contained document suitable for
    direct Elasticsearch/Iceberg ingestion: `time` becomes `@timestamp`, and a `dt`
    date-partition key plus service/host/container metadata are attached."""
    timestamp = entry.get("time")
    enriched = {
        "@timestamp": timestamp,
        "dt": timestamp[:10] if timestamp else None,
        "service": service,
        "host": host,
        "container": container,
    }
    enriched.update((key, value) for key, value in entry.items() if key != "time")
    return enriched
