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

export async function renderHealthDashboard() {
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
          </div>
          <div class="health-section-actions">
            <span>画面は本日分の最新100件のみ表示（CSVは本日分の全件）</span>
            <button class="button-secondary" type="button" data-access-log-download>本日分の全件をCSVダウンロード</button>
          </div>
        </div>
        <pre class="access-log" data-access-log>取得中…</pre>
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
      checkAccessLogs(),
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

async function checkAccessLogs() {
  try {
    const response = await fetchWithTimeout("/api/access-logs?tail=100", 8000);
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();
    return { ok: true, logs: payload.logs };
  } catch {
    return { ok: false, logs: [] };
  }
}

function updateAccessLogCard(result) {
  const box = document.querySelector("[data-access-log]");
  if (!box) return;
  if (!result.ok) {
    box.textContent = "ログを取得できませんでした。";
    return;
  }
  if (!result.logs.length) {
    box.textContent = "アクセスログはまだありません。";
    return;
  }
  box.textContent = result.logs.map(formatAccessLogEntry).join("\n");
  box.scrollTop = box.scrollHeight;
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

function formatAccessLogEntry(entry) {
  const time = formatJst(entry["@timestamp"]);
  return `${time}  ${entry.remote_addr}  ${entry.status}  ${entry.method} ${entry.uri}  (${entry.request_time}s)`;
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
    const response = await fetchWithTimeout("/api/access-logs?full=1", 20000);
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();

    const entries = payload.logs;
    if (!entries.length) {
      showNotice("ダウンロードできるアクセスログがありません。");
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
    link.download = `access-log-${csvFileTimestamp()}.csv`;
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

function csvFileTimestamp() {
  const parts = Object.fromEntries(JST_FORMATTER.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

export function stopHealthMonitoring() {
  window.clearInterval(healthRefreshTimer);
  healthRefreshTimer = undefined;
  healthRequestId += 1;
  healthUpdateRunning = false;
}
