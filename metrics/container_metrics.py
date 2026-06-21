import json
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from config import PROJECT_NAME
from docker_api import docker_get


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
    filters = _compose_filters()
    containers = docker_get(f"/containers/json?all=true&filters={filters}")
    running = [
        container for container in containers if container.get("State") == "running"
    ]
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(running)))) as executor:
        results = list(executor.map(container_metrics, running))
    return sorted(results, key=lambda item: item["service"])


def find_container(service):
    filters = _compose_filters(service)
    containers = docker_get(f"/containers/json?all=true&filters={filters}")
    return containers[0] if containers else None


def _compose_filters(service=None):
    labels = [f"com.docker.compose.project={PROJECT_NAME}"]
    if service:
        labels.append(f"com.docker.compose.service={service}")
    return quote(json.dumps({"label": labels}), safe="")
