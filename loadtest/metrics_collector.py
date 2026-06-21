import csv
import json
from urllib.error import URLError
from urllib.request import Request, urlopen

from config import METRICS_INTERVAL, METRICS_URL
from report import timestamp


FIELDNAMES = [
    "timestamp",
    "service",
    "name",
    "state",
    "cpu_percent",
    "memory_usage_bytes",
    "memory_limit_bytes",
    "memory_percent",
]


def fetch_metrics():
    request = Request(METRICS_URL, headers={"Accept": "application/json"})
    with urlopen(request, timeout=5) as response:
        payload = json.load(response)
    if payload.get("status") != "ok":
        raise RuntimeError(payload.get("error", "metrics API returned an error"))
    return payload.get("containers", [])


def collect_metrics(stop_event, output_path, samples, errors):
    with output_path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=FIELDNAMES)
        writer.writeheader()
        while not stop_event.is_set():
            collected_at = timestamp()
            try:
                for container in fetch_metrics():
                    row = {
                        field: container.get(field, "") for field in FIELDNAMES
                    }
                    row["timestamp"] = collected_at
                    writer.writerow(row)
                    samples.append(row)
                output.flush()
            except (
                OSError,
                URLError,
                ValueError,
                RuntimeError,
                json.JSONDecodeError,
            ) as error:
                errors.append(f"{collected_at} {error}")
            stop_event.wait(METRICS_INTERVAL)
