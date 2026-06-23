import { BACKENDS } from "../config.js";
import { app } from "../state.js";
import { escapeHtml, showNotice } from "../common.js";
import { checkBackendHealth } from "../backend.js";
import {
  checkElasticsearchHealth,
  fetchWithTimeout,
  updateBackendHealthCard,
  updateContainerUsage,
  updateElasticsearchHealthCard,
  updateFrontendHealthCard,
  updateHealthSummary,
} from "../components/health-status.js";

let healthRefreshTimer;
let healthRequestId = 0;
let healthUpdateRunning = false;
let accessLogDate = "";

export async function renderHealthDashboard() {
  accessLogDate = todayJstDate();
  document.title = "稼働状況 | Qiita Article Search";
  app.innerHTML = `
    <section class="health-page">
      <div class="health-page-header">
        <div>
          <p class="eyebrow">SYSTEM HEALTH</p>
          <h1>稼働状況</h1>
          <p>frontendのNginx経由で、各バックエンドとElasticsearchの状態を確認しています。</p>
        </div>
        <button class="health-refresh-button" type="button" data-health-refresh>
          <span aria-hidden="true">↻</span> 今すぐ更新
        </button>
      </div>
      <div class="health-summary" aria-live="polite">
        <span class="health-summary-dot is-checking"></span>
        <strong data-health-summary>確認中…</strong>
        <time data-health-updated></time>
      </div>
      <section class="health-section">
        <div class="health-section-heading">
          <div>
            <p class="eyebrow">FRONTEND</p>
            <h2>フロントエンドコンテナ</h2>
          </div>
        </div>
        <div class="health-grid health-grid-elasticsearch">
          ${containerHealthCard("frontend", "Frontend", "F")}
        </div>
      </section>
      <section class="health-section">
        <div class="health-section-heading">
          <div>
            <p class="eyebrow">BACKENDS</p>
            <h2>バックエンドコンテナ</h2>
          </div>
          <span>5秒ごとに自動更新</span>
        </div>
        <div class="health-grid">
          ${Object.entries(BACKENDS).map(([key, backend]) => healthCard(key, backend)).join("")}
        </div>
      </section>
      <section class="health-section">
        <div class="health-section-heading">
          <div>
            <p class="eyebrow">DATA STORE</p>
            <h2>Elasticsearch</h2>
          </div>
        </div>
        <div class="health-grid health-grid-elasticsearch">
          <article class="health-card is-checking" data-elasticsearch-health>
            <div class="health-card-top">
              <span class="health-service-icon elasticsearch-icon" aria-hidden="true">E</span>
              <span class="health-badge">確認中</span>
            </div>
            <h3>Elasticsearch</h3>
            <p class="health-message">接続状態を確認しています。</p>
            <dl class="health-details">
              <div><dt>接続経路</dt><dd data-health-via>—</dd></div>
              <div><dt>応答時間</dt><dd data-health-latency>—</dd></div>
              <div><dt>バージョン</dt><dd data-health-version>—</dd></div>
            </dl>
          </article>
        </div>
      </section>
      <section class="health-section">
        <div class="health-section-heading">
          <div>
            <p class="eyebrow">OBSERVABILITY</p>
            <h2>アクセスログ</h2>
            <p class="health-section-description">監視リクエストと静的ファイルを除いた、実際のブラウザ操作を表示します。</p>
          </div>
          <form class="access-log-controls" data-access-log-form>
            <label>
              <span>対象日</span>
              <input type="date" name="date" value="${accessLogDate}" max="${todayJstDate()}">
            </label>
            <button class="button-secondary" type="submit">表示</button>
            <button class="button-secondary" type="button" data-access-log-download disabled>CSVダウンロード</button>
          </form>
        </div>
        <div class="access-log-summary" data-access-log-count>読込中…</div>
        <div class="access-log-table-wrap">
          <table class="access-log-table">
            <thead>
              <tr>
                <th>時刻</th>
                <th>接続元</th>
                <th>Method</th>
                <th>URI</th>
                <th>Status</th>
                <th>応答時間</th>
              </tr>
            </thead>
            <tbody data-access-log-body>
              <tr><td colspan="6">アクセスログを読み込んでいます…</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  `;

  await updateHealthDashboard();
  healthRefreshTimer = window.setInterval(updateHealthDashboard, 5000);
}

function healthCard(key, backend) {
  return `
    <article class="health-card is-checking" data-backend-health="${key}">
      <div class="health-card-top">
        <span class="health-service-icon" aria-hidden="true">${escapeHtml(backend.label.slice(0, 1))}</span>
        <span class="health-badge">確認中</span>
      </div>
      <h3>${escapeHtml(backend.label)}</h3>
      <p class="health-message">接続状態を確認しています。</p>
      <dl class="health-details">
        <div><dt>応答時間</dt><dd data-health-latency>—</dd></div>
        <div><dt>CPU</dt><dd data-health-cpu>—</dd></div>
        <div><dt>メモリ</dt><dd data-health-memory>—</dd></div>
      </dl>
    </article>
  `;
}

function containerHealthCard(service, label, icon) {
  return `
    <article class="health-card is-checking" data-container-health="${service}">
      <div class="health-card-top">
        <span class="health-service-icon" aria-hidden="true">${icon}</span>
        <span class="health-badge">確認中</span>
      </div>
      <h3>${escapeHtml(label)}</h3>
      <p class="health-message">コンテナの稼働状態を確認しています。</p>
      <dl class="health-details">
        <div><dt>CPU</dt><dd data-health-cpu>—</dd></div>
        <div><dt>メモリ</dt><dd data-health-memory>—</dd></div>
      </dl>
    </article>
  `;
}

export async function updateHealthDashboard() {
  if (location.pathname !== "/health" || healthUpdateRunning) return;
  healthUpdateRunning = true;
  const requestId = ++healthRequestId;
  const refreshButton = document.querySelector("[data-health-refresh]");
  refreshButton?.classList.add("is-refreshing");
  refreshButton?.setAttribute("disabled", "");

  try {
    const [results, containerMetrics, accessLogs] = await Promise.all([
      Promise.all(Object.keys(BACKENDS).map(async (key) => [key, await checkBackendHealth(key)])),
      checkContainerMetrics(),
      checkAccessLogs(accessLogDate),
    ]);
    if (requestId !== healthRequestId || location.pathname !== "/health") return;

    results.forEach(([key, result]) => {
      updateBackendHealthCard(key, result);
      updateContainerUsage(
        document.querySelector(`[data-backend-health="${key}"]`),
        containerMetrics.get(`backend_${key}`)
      );
    });
    updateFrontendHealthCard(containerMetrics.get("frontend"), containerMetrics.available);
    updateAccessLogCard(accessLogs);
    const healthyKeys = results.filter(([, result]) => result.ok).map(([key]) => key);
    const elasticsearch = await checkElasticsearchHealth(healthyKeys);
    if (requestId !== healthRequestId || location.pathname !== "/health") return;

    updateElasticsearchHealthCard(elasticsearch);
    updateHealthSummary(healthyKeys.length, elasticsearch);
  } finally {
    if (requestId === healthRequestId) {
      healthUpdateRunning = false;
      refreshButton?.classList.remove("is-refreshing");
      refreshButton?.removeAttribute("disabled");
    }
  }
}

async function checkContainerMetrics() {
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

async function checkAccessLogs(date = accessLogDate) {
  try {
    const params = new URLSearchParams({ date, tail: "200" });
    const response = await fetchWithTimeout(`/api/access-logs?${params}`, 8000);
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();
    return { ok: true, requestedDate: date, date: payload.date, logs: payload.logs || [] };
  } catch {
    return { ok: false, requestedDate: date, date: "", logs: [] };
  }
}

function updateAccessLogCard(result) {
  const body = document.querySelector("[data-access-log-body]");
  const count = document.querySelector("[data-access-log-count]");
  const downloadButton = document.querySelector("[data-access-log-download]");
  if (!body) return;
  if (result.requestedDate !== accessLogDate) return;
  if (!result.ok) {
    body.innerHTML = `<tr><td colspan="6">ログを取得できませんでした。</td></tr>`;
    if (count) count.textContent = "取得失敗";
    if (downloadButton) downloadButton.disabled = true;
    return;
  }
  if (count) count.textContent = `${result.date || accessLogDate} / ${result.logs.length}件（直近200件まで）`;
  if (downloadButton) downloadButton.disabled = false;
  if (!result.logs.length) {
    body.innerHTML = `<tr><td colspan="6">${escapeHtml(result.date || accessLogDate)} のアクセスログはありません。</td></tr>`;
    return;
  }
  body.innerHTML = [...result.logs].reverse().map(accessLogRow).join("");
}

export async function updateAccessLogs(date = accessLogDate) {
  if (location.pathname !== "/health") return;
  accessLogDate = String(date || todayJstDate());
  const body = document.querySelector("[data-access-log-body]");
  const count = document.querySelector("[data-access-log-count]");
  const downloadButton = document.querySelector("[data-access-log-download]");
  if (body) body.innerHTML = `<tr><td colspan="6">アクセスログを読み込んでいます…</td></tr>`;
  if (count) count.textContent = "読込中…";
  if (downloadButton) downloadButton.disabled = true;
  updateAccessLogCard(await checkAccessLogs(accessLogDate));
}

const JST_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatJst(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const parts = Object.fromEntries(JST_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} JST`;
}

function accessLogRow(entry) {
  const status = Number(entry.status);
  const time = entry["@timestamp"] ? formatJst(entry["@timestamp"]).replace(" JST", "") : "—";
  const uri = entry.uri || "—";
  return `
    <tr>
      <td>${escapeHtml(time)}</td>
      <td>${escapeHtml(entry.remote_addr || "—")}</td>
      <td>${escapeHtml(entry.method || "—")}</td>
      <td class="access-log-uri" title="${escapeHtml(uri)}">${escapeHtml(uri)}</td>
      <td class="${status >= 400 ? "is-error" : ""}">${escapeHtml(entry.status ?? "—")}</td>
      <td>${escapeHtml(entry.request_time ?? "—")} s</td>
    </tr>
  `;
}

const ACCESS_LOG_CSV_COLUMNS = [
  ["時刻", (entry) => formatJst(entry["@timestamp"])],
  ["アクセス元IP", (entry) => entry.remote_addr ?? ""],
  ["メソッド", (entry) => entry.method ?? ""],
  ["URI", (entry) => entry.uri ?? ""],
  ["ステータス", (entry) => entry.status ?? ""],
  ["送信バイト数", (entry) => entry.body_bytes_sent ?? ""],
  ["応答時間(秒)", (entry) => entry.request_time ?? ""],
  ["振り先", (entry) => entry.upstream_addr ?? ""],
  ["User-Agent", (entry) => entry.user_agent ?? ""],
];

export async function downloadAccessLogCsv(button) {
  button?.setAttribute("disabled", "");
  try {
    const response = await fetchWithTimeout(
      `/api/access-logs?date=${encodeURIComponent(accessLogDate)}&full=1`,
      20000
    );
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();

    const entries = payload.logs;
    if (!entries.length) {
      showNotice(`${accessLogDate} のアクセスログはありません。`);
      return;
    }
    const header = ACCESS_LOG_CSV_COLUMNS.map(([name]) => csvEscape(name)).join(",");
    const rows = entries.map((entry) =>
      ACCESS_LOG_CSV_COLUMNS.map(([, getValue]) => csvEscape(getValue(entry))).join(",")
    );
    const csv = `﻿${[header, ...rows].join("\r\n")}\r\n`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `access-logs-${payload.date || csvFileDate()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    showNotice("アクセスログの取得に失敗しました。");
  } finally {
    button?.removeAttribute("disabled");
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvFileDate() {
  const parts = Object.fromEntries(JST_FORMATTER.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function todayJstDate() {
  return csvFileDate();
}

export function stopHealthMonitoring() {
  window.clearInterval(healthRefreshTimer);
  healthRefreshTimer = undefined;
  healthRequestId += 1;
  healthUpdateRunning = false;
  accessLogDate = "";
}
