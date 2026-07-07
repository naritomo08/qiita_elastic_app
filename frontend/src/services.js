import { BACKENDS } from "./settings.js";

export async function apiRequest(selectedBackend, path, params = {}) {
  const response = await fetch(apiPath(selectedBackend, path, params), { cache: "no-store" });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("バックエンドから想定外のレスポンスが返されました。");
  }
  if (!response.ok) throw new Error(payload.error || "バックエンドでエラーが発生しました。");
  return payload;
}

export async function checkBackendAvailability(key) {
  try {
    const response = await fetchWithTimeout(healthPath(key, "/elasticsearch"), 3500);
    const payload = await response.json();
    return { ok: response.ok && payload.status === "ok" };
  } catch {
    return { ok: false };
  }
}

export async function checkBackendHealth(key) {
  const startedAt = performance.now();
  try {
    const response = await fetchWithTimeout(healthPath(key), 3500);
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();
    return { ok: true, latency: Math.round(performance.now() - startedAt) };
  } catch {
    return { ok: false, latency: Math.round(performance.now() - startedAt) };
  }
}

export async function checkElasticsearchHealth(healthyKeys, selectedBackend) {
  if (!healthyKeys.length) return { ok: false, unavailable: true };
  const candidates = [
    ...(healthyKeys.includes(selectedBackend) ? [selectedBackend] : []),
    ...healthyKeys.filter((key) => key !== selectedBackend),
  ];
  const primary = await requestElasticsearchHealth(candidates[0]);
  if (primary.ok || candidates.length === 1) return primary;
  const fallbacks = await Promise.all(candidates.slice(1).map(requestElasticsearchHealth));
  return fallbacks.find((result) => result.ok) || primary;
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

function apiPath(selectedBackend, path, params = {}) {
  const normalizedPath = path.replace(/^\/api\/?/, "");
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value != null) query.set(key, value);
  });
  return `/api/${selectedBackend}/${normalizedPath}${query.size ? `?${query}` : ""}`;
}

function healthPath(key, suffix = "") {
  return `/health/${key}${suffix}`;
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

export function backendLabel(key) {
  return BACKENDS[key]?.label || key;
}
