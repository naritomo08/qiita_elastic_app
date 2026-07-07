import { get } from "svelte/store";
import { BACKENDS } from "./config.js";
import { selectedBackend } from "./state.js";
import { fetchWithTimeout, healthPath } from "./api.js";

export async function checkElasticsearchHealth(healthyKeys) {
  if (!healthyKeys.length) return { ok: false, unavailable: true };
  const current = get(selectedBackend);
  const candidates = [
    ...(healthyKeys.includes(current) ? [current] : []),
    ...healthyKeys.filter((key) => key !== current),
  ];

  const primary = await requestElasticsearchHealth(candidates[0]);
  if (primary.ok || candidates.length === 1) return primary;
  const fallbacks = await Promise.all(candidates.slice(1).map(requestElasticsearchHealth));
  return fallbacks.find((result) => result.ok) || primary;
}

async function requestElasticsearchHealth(key) {
  try {
    const response = await fetchWithTimeout(healthPath(key, "/elasticsearch"), 3500);
    const payload = await response.json();
    return {
      ok: response.ok && payload.status === "ok",
      checkedBy: key,
      latency: payload.latency_ms,
      version: payload.version || "",
      clusterName: payload.cluster_name || "",
    };
  } catch {
    return { ok: false, checkedBy: key };
  }
}

export async function checkContainerMetrics() {
  try {
    const response = await fetchWithTimeout("/api/container-metrics", 8000);
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();
    const metrics = new Map(payload.containers.map((container) => [container.service, container]));
    metrics.available = true;
    return metrics;
  } catch {
    const metrics = new Map();
    metrics.available = false;
    return metrics;
  }
}

export async function checkAccessLogs(date, full = false) {
  const params = new URLSearchParams({ date });
  if (full) params.set("full", "1");
  else params.set("tail", "200");

  const response = await fetchWithTimeout(`/api/access-logs?${params}`, full ? 20000 : 8000);
  const payload = await response.json();
  if (!response.ok || payload.status !== "ok") throw new Error("アクセスログの取得に失敗しました。");
  return { date: payload.date, logs: payload.logs || [] };
}

export function healthSummary(healthyCount, elasticsearch) {
  const allHealthy = healthyCount === Object.keys(BACKENDS).length && elasticsearch.ok;
  return {
    allHealthy,
    text: allHealthy
      ? "すべてのサービスが正常です"
      : `バックエンド ${healthyCount}/${Object.keys(BACKENDS).length} 稼働・Elasticsearch ${elasticsearch.ok ? "正常" : "接続不可"}`,
  };
}
