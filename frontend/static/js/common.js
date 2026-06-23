import { app, state } from "./state.js";

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
  return `/api/${state.selectedBackend}/${normalizedPath}${query.size ? `?${query}` : ""}`;
}

export function healthPath(key, suffix = "") {
  return `/health/${key}${suffix}`;
}

export function renderError(message) {
  app.innerHTML = `<section class="error-page"><p class="error-code">APPLICATION ERROR</p><h1>画面を表示できませんでした</h1><p>${escapeHtml(message)}</p><a class="button-secondary" href="/" data-route>トップページへ戻る</a></section>`;
  app.dataset.ready = "true";
}

export function renderBackendUnavailable() {
  document.title = "Backend停止中 | Qiita Article Search";
  app.innerHTML = `
    <section class="error-page">
      <p class="error-code">BACKEND UNAVAILABLE</p>
      <h1>利用できるBackendがありません</h1>
      <p>${state.backendAvailabilityKnown ? "稼働状態を15秒ごとに確認しています。Backendが復旧すると自動的に表示を戻します。" : "Backendの稼働状態を確認しています。"}</p>
    </section>`;
  app.dataset.ready = "true";
}

export function showPendingBackendNotice() {
  const message = sessionStorage.getItem("qiita-backend-notice");
  if (!message) return;
  sessionStorage.removeItem("qiita-backend-notice");
  showNotice(message);
}

export function showNotice(message) {
  app.insertAdjacentHTML("afterbegin", `<div class="alert alert-warning">${escapeHtml(message)}</div>`);
}

export function emptyState(title, description) {
  return `<div class="empty-state"><h3>${title}</h3><p>${description}</p></div>`;
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export function sanitizeHighlight(value) {
  if (!value) return "";
  const escaped = escapeHtml(value);
  return escaped.replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
}

export function removeDangerousBlocks(value) {
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}

export function stripMarkdown(value) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? escapeHtml(url.href) : "#";
  } catch {
    return "#";
  }
}

export function positiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}
