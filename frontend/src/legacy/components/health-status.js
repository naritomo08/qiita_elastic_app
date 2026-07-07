import { BACKENDS } from "../config.js";
import { state } from "../state.js";
import { healthPath } from "../common.js";

export async function checkElasticsearchHealth(healthyKeys) {
  if (!healthyKeys.length) return { ok: false, unavailable: true };
  const candidates = [
    ...(healthyKeys.includes(state.selectedBackend) ? [state.selectedBackend] : []),
    ...healthyKeys.filter((key) => key !== state.selectedBackend),
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

export async function fetchWithTimeout(url, timeout) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal, cache: "no-store" });
  } finally {
    window.clearTimeout(timer);
  }
}

export function updateBackendHealthCard(key, result) {
  const card = document.querySelector(`[data-backend-health="${key}"]`);
  if (!card) return;
  setHealthCardState(card, result.ok);
  card.querySelector(".health-badge").textContent = result.ok ? "稼働中" : "停止";
  card.querySelector(".health-message").textContent = result.ok
    ? "Nginx経由で正常に応答しています。"
    : "応答がありません。コンテナの状態を確認してください。";
  card.querySelector("[data-health-latency]").textContent = result.ok ? `${result.latency} ms` : "タイムアウト";
}

export function updateFrontendHealthCard(metrics, metricsAvailable) {
  const card = document.querySelector('[data-container-health="frontend"]');
  if (!card) return;
  const isHealthy = Boolean(metrics);
  setHealthCardState(card, isHealthy);
  card.querySelector(".health-badge").textContent = isHealthy ? "稼働中" : "取得不可";
  card.querySelector(".health-message").textContent = isHealthy
    ? "この画面を配信しているフロントエンドコンテナです。"
    : metricsAvailable
      ? "フロントエンドのコンテナ情報が見つかりません。"
      : "コンテナ統計APIへ接続できません。";
  updateContainerUsage(card, metrics);
}

export function updateContainerUsage(card, metrics) {
  if (!card) return;
  card.querySelector("[data-health-cpu]").textContent = metrics
    ? `${Number(metrics.cpu_percent).toFixed(2)} %`
    : "取得不可";
  card.querySelector("[data-health-memory]").textContent = metrics
    ? `${formatBytes(metrics.memory_usage_bytes)} / ${formatBytes(metrics.memory_limit_bytes)} (${Number(metrics.memory_percent).toFixed(1)} %)`
    : "取得不可";
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function updateElasticsearchHealthCard(result) {
  const card = document.querySelector("[data-elasticsearch-health]");
  if (!card) return;
  setHealthCardState(card, result.ok);
  card.querySelector(".health-badge").textContent = result.ok ? "稼働中" : "接続不可";
  card.querySelector(".health-message").textContent = result.ok
    ? `${result.clusterName || "Elasticsearchクラスター"}へ正常に接続できています。`
    : result.unavailable
      ? "確認に利用できるバックエンドがありません。"
      : "バックエンドからElasticsearchへ接続できません。";
  card.querySelector("[data-health-via]").textContent = result.checkedBy
    ? BACKENDS[result.checkedBy].label
    : "—";
  card.querySelector("[data-health-latency]").textContent =
    result.ok && Number.isFinite(Number(result.latency)) ? `${result.latency} ms` : "—";
  card.querySelector("[data-health-version]").textContent = result.version || "—";
}

function setHealthCardState(card, isHealthy) {
  card.classList.remove("is-checking", "is-healthy", "is-unhealthy");
  card.classList.add(isHealthy ? "is-healthy" : "is-unhealthy");
}

export function updateHealthSummary(healthyCount, elasticsearch) {
  const allHealthy = healthyCount === Object.keys(BACKENDS).length && elasticsearch.ok;
  const summary = document.querySelector("[data-health-summary]");
  const dot = document.querySelector(".health-summary-dot");
  const updated = document.querySelector("[data-health-updated]");
  if (summary) {
    summary.textContent = allHealthy
      ? "すべてのサービスが正常です"
      : `バックエンド ${healthyCount}/${Object.keys(BACKENDS).length} 稼働・Elasticsearch ${elasticsearch.ok ? "正常" : "接続不可"}`;
  }
  dot?.classList.remove("is-checking", "is-healthy", "is-unhealthy");
  dot?.classList.add(allHealthy ? "is-healthy" : "is-unhealthy");
  if (updated) {
    const now = new Date();
    updated.dateTime = now.toISOString();
    updated.textContent = `最終更新 ${now.toLocaleTimeString("ja-JP")}`;
  }
}
