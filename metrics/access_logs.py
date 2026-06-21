import json
import os
import re
from collections import deque
from datetime import datetime, timedelta

from config import ACCESS_LOG_DIR, JST, LOG_TAIL_DEFAULT, LOG_TAIL_MAX


DATE_PARAM_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def today_jst_date():
    return datetime.now(JST).date().isoformat()


def parse_date_param(value):
    if value is None or value == "":
        return None
    if not DATE_PARAM_RE.match(value):
        raise ValueError(f"invalid date: {value}")
    datetime.strptime(value, "%Y-%m-%d")
    return value


def day_bounds_jst(date_str):
    if date_str is None:
        start_jst = datetime.now(JST).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
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
    json_part = line
    if not line.lstrip().startswith("{"):
        separator = line.find(" ")
        json_part = line[separator + 1:] if separator != -1 else line
    try:
        return json.loads(json_part)
    except ValueError:
        return None


def timestamp_to_jst_date(timestamp):
    try:
        return datetime.fromisoformat(timestamp).astimezone(JST).date().isoformat()
    except ValueError:
        return timestamp[:10]


def enrich_log_entry(entry, service, host, container):
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
