import { get } from "svelte/store";
import { selectedBackend } from "./state.js";

export async function api(path, params = {}) {
  const response = await fetch(apiPath(path, params), { cache: "no-store" });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("バックエンドから想定外のレスポンスが返されました。");
  }
  if (!response.ok) throw new Error(payload.error || "バックエンドでエラーが発生しました。");
  return payload;
}

export function apiPath(path, params = {}) {
  const normalizedPath = path.replace(/^\/api\/?/, "");
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value != null) query.set(key, value);
  });
  return `/api/${get(selectedBackend)}/${normalizedPath}${query.size ? `?${query}` : ""}`;
}

export function healthPath(key, suffix = "") {
  return `/health/${key}${suffix}`;
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
