import csv
import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


RESULTS_ROOT = Path(os.getenv("RESULTS_DIR", "/results"))
METRICS_URL = os.getenv("METRICS_URL", "http://metrics:8090/metrics")
METRICS_INTERVAL = max(0.5, float(os.getenv("METRICS_INTERVAL", "2")))
TEST_SCRIPT = os.getenv("K6_SCRIPT", "/opt/loadtest/test.js")


def timestamp():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def fetch_metrics():
    request = Request(METRICS_URL, headers={"Accept": "application/json"})
    with urlopen(request, timeout=5) as response:
        payload = json.load(response)
    if payload.get("status") != "ok":
        raise RuntimeError(payload.get("error", "metrics API returned an error"))
    return payload.get("containers", [])


def collect_metrics(stop_event, output_path, samples, errors):
    fieldnames = [
        "timestamp",
        "service",
        "name",
        "state",
        "cpu_percent",
        "memory_usage_bytes",
        "memory_limit_bytes",
        "memory_percent",
    ]
    with output_path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        while not stop_event.is_set():
            collected_at = timestamp()
            try:
                containers = fetch_metrics()
                for container in containers:
                    row = {field: container.get(field, "") for field in fieldnames}
                    row["timestamp"] = collected_at
                    writer.writerow(row)
                    samples.append(row)
                output.flush()
            except (OSError, URLError, ValueError, RuntimeError, json.JSONDecodeError) as error:
                errors.append(f"{collected_at} {error}")
            stop_event.wait(METRICS_INTERVAL)


def metric_value(summary, name, key, default=0):
    metric = summary.get("metrics", {}).get(name, {})
    if key in metric:
        return metric[key]
    return metric.get("values", {}).get(key, default)


def metric_rate(summary, name):
    metric = summary.get("metrics", {}).get(name, {})
    if "rate" in metric:
        return metric["rate"]
    if "value" in metric:
        return metric["value"]
    return metric.get("values", {}).get("rate", 0)


def human_bytes(value):
    value = float(value or 0)
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.2f} {unit}"
        value /= 1024


def aggregate_resources(samples):
    grouped = defaultdict(list)
    for sample in samples:
        service = sample.get("service") or sample.get("name") or "unknown"
        grouped[service].append(sample)

    aggregates = []
    for service, rows in sorted(grouped.items()):
        cpu = [float(row.get("cpu_percent") or 0) for row in rows]
        memory = [float(row.get("memory_usage_bytes") or 0) for row in rows]
        memory_percent = [float(row.get("memory_percent") or 0) for row in rows]
        aggregates.append(
            {
                "service": service,
                "samples": len(rows),
                "cpu_avg": sum(cpu) / len(cpu),
                "cpu_max": max(cpu),
                "memory_avg": sum(memory) / len(memory),
                "memory_max": max(memory),
                "memory_percent_max": max(memory_percent),
            }
        )
    return aggregates


def write_report(result_dir, started_at, finished_at, exit_code, samples, metric_errors):
    summary_path = result_dir / "k6-summary.json"
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        summary = {}

    lines = [
        "Qiita Article Search load test",
        "=" * 30,
        f"Target URL: {os.getenv('TARGET_URL', '')}",
        f"Scenario: {os.getenv('SCENARIO', 'mixed')}",
        f"Started: {started_at}",
        f"Finished: {finished_at}",
        f"k6 exit code: {exit_code}",
        f"VUs: {os.getenv('VUS', '20')}",
        f"Duration: {os.getenv('DURATION', '1m')}",
        f"Stages: {os.getenv('STAGES', '(not used)')}",
        "",
        "HTTP results",
        "------------",
        f"Requests: {metric_value(summary, 'http_reqs', 'count')}",
        f"Requests/sec: {metric_value(summary, 'http_reqs', 'rate'):.2f}",
        f"Failed request rate: {metric_rate(summary, 'http_req_failed') * 100:.2f}%",
        f"Checks passed rate: {metric_rate(summary, 'checks') * 100:.2f}%",
        f"Response average: {metric_value(summary, 'http_req_duration', 'avg'):.2f} ms",
        f"Response median: {metric_value(summary, 'http_req_duration', 'med'):.2f} ms",
        f"Response p90: {metric_value(summary, 'http_req_duration', 'p(90)'):.2f} ms",
        f"Response p95: {metric_value(summary, 'http_req_duration', 'p(95)'):.2f} ms",
        f"Response p99: {metric_value(summary, 'http_req_duration', 'p(99)'):.2f} ms",
        f"Response maximum: {metric_value(summary, 'http_req_duration', 'max'):.2f} ms",
        "",
        "Container resources",
        "-------------------",
    ]

    aggregates = aggregate_resources(samples)
    if not aggregates:
        lines.append("No container metrics were collected.")
    for item in aggregates:
        lines.extend(
            [
                f"[{item['service']}] samples={item['samples']}",
                f"  CPU average: {item['cpu_avg']:.2f}%",
                f"  CPU maximum: {item['cpu_max']:.2f}%",
                f"  Memory average: {human_bytes(item['memory_avg'])}",
                f"  Memory maximum: {human_bytes(item['memory_max'])}",
                f"  Memory usage maximum: {item['memory_percent_max']:.2f}%",
            ]
        )

    if metric_errors:
        lines.extend(["", "Metrics collection warnings", "---------------------------"])
        lines.extend(metric_errors)

    (result_dir / "summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    if not os.getenv("TARGET_URL"):
        print("ERROR: TARGET_URL is required.", file=sys.stderr)
        return 2

    run_id = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
    result_dir = RESULTS_ROOT / run_id
    result_dir.mkdir(parents=True, exist_ok=False)
    summary_path = result_dir / "k6-summary.json"
    k6_output_path = result_dir / "k6-output.txt"
    metrics_path = result_dir / "container-metrics.csv"

    samples = []
    metric_errors = []
    stop_event = threading.Event()
    collector = threading.Thread(
        target=collect_metrics,
        args=(stop_event, metrics_path, samples, metric_errors),
        daemon=True,
    )
    collector.start()

    command = [
        "k6",
        "run",
        "--summary-export",
        str(summary_path),
        TEST_SCRIPT,
    ]
    started_at = timestamp()
    print(f"Results: {result_dir}")
    print(f"Running: {' '.join(command)}")

    process = None

    def forward_signal(signum, _frame):
        if process and process.poll() is None:
            process.send_signal(signum)

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        with k6_output_path.open("w", encoding="utf-8") as output:
            for line in process.stdout:
                print(line, end="")
                output.write(line)
        exit_code = process.wait()
    except OSError as error:
        exit_code = 127
        k6_output_path.write_text(f"{error}\n", encoding="utf-8")
        print(f"ERROR: {error}", file=sys.stderr)
    finally:
        stop_event.set()
        collector.join(timeout=METRICS_INTERVAL + 6)

    finished_at = timestamp()
    write_report(
        result_dir,
        started_at,
        finished_at,
        exit_code,
        samples,
        metric_errors,
    )
    print(f"Summary: {result_dir / 'summary.txt'}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
