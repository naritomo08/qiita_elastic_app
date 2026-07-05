import json
import os
from collections import defaultdict
from datetime import datetime

from config import JST


def timestamp():
    return datetime.now(JST).isoformat(timespec="seconds")


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


def write_report(
    result_dir,
    started_at,
    finished_at,
    exit_code,
    samples,
    metric_errors,
):
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
        f"Started (JST): {started_at}",
        f"Finished (JST): {finished_at}",
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
        lines.extend(
            ["", "Metrics collection warnings", "---------------------------"]
        )
        lines.extend(metric_errors)

    (result_dir / "summary.txt").write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
    )
