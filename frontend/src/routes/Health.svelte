<script>
  import { onDestroy, onMount } from "svelte";
  import { BACKENDS } from "../lib/config.js";
  import { checkBackendHealth } from "../lib/backend.js";
  import { checkAccessLogs, checkContainerMetrics, checkElasticsearchHealth, healthSummary } from "../lib/health.js";
  import { formatBytes, formatJst, todayJstDate } from "../lib/utils.js";

  let backendResults = {};
  let containerMetrics = new Map();
  let elasticsearch = { ok: false, unavailable: true };
  let accessLogDate = todayJstDate();
  let accessLogs = [];
  let accessLogStatus = "読込中…";
  let updatedAt = null;
  let updating = false;
  let requestId = 0;
  let timer;

  $: healthyKeys = Object.entries(backendResults).filter(([, result]) => result?.ok).map(([key]) => key);
  $: summary = healthSummary(healthyKeys.length, elasticsearch);
  $: frontendMetrics = containerMetrics.get("frontend");

  onMount(async () => {
    document.title = "稼働状況 | Qiita Article Search";
    await updateDashboard();
    timer = window.setInterval(updateDashboard, 5000);
  });

  onDestroy(() => {
    window.clearInterval(timer);
    requestId += 1;
  });

  async function updateDashboard() {
    if (updating) return;
    updating = true;
    const id = ++requestId;
    try {
      const [results, metrics, logs] = await Promise.all([
        Promise.all(Object.keys(BACKENDS).map(async (key) => [key, await checkBackendHealth(key)])),
        checkContainerMetrics(),
        loadAccessLogs(accessLogDate),
      ]);
      if (id !== requestId) return;
      backendResults = Object.fromEntries(results);
      containerMetrics = metrics;
      accessLogs = logs.logs;
      accessLogStatus = `${logs.date || accessLogDate} / ${logs.logs.length}件（直近200件まで）`;
      elasticsearch = await checkElasticsearchHealth(results.filter(([, result]) => result.ok).map(([key]) => key));
      updatedAt = new Date();
    } finally {
      if (id === requestId) updating = false;
    }
  }

  async function loadAccessLogs(date) {
    try {
      return await checkAccessLogs(date);
    } catch {
      accessLogStatus = "取得失敗";
      return { date, logs: [] };
    }
  }

  async function changeAccessLogDate(event) {
    accessLogDate = event.currentTarget.date.value || todayJstDate();
    accessLogStatus = "読込中…";
    const result = await loadAccessLogs(accessLogDate);
    accessLogs = result.logs;
    accessLogStatus = `${result.date || accessLogDate} / ${result.logs.length}件（直近200件まで）`;
  }

  async function downloadAccessLogCsv() {
    try {
      const payload = await checkAccessLogs(accessLogDate, true);
      if (!payload.logs.length) {
        accessLogStatus = `${accessLogDate} のアクセスログはありません。`;
        return;
      }
      const header = CSV_COLUMNS.map(([name]) => csvEscape(name)).join(",");
      const rows = payload.logs.map((entry) => CSV_COLUMNS.map(([, getValue]) => csvEscape(getValue(entry))).join(","));
      const csv = `﻿${[header, ...rows].join("\r\n")}\r\n`;
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `access-logs-${payload.date || todayJstDate()}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      accessLogStatus = "アクセスログの取得に失敗しました。";
    }
  }

  function cardState(ok, checking = false) {
    return checking ? "is-checking" : ok ? "is-healthy" : "is-unhealthy";
  }

  function container(service) {
    return containerMetrics.get(service);
  }

  function memoryText(metrics) {
    return metrics
      ? `${formatBytes(metrics.memory_usage_bytes)} / ${formatBytes(metrics.memory_limit_bytes)} (${Number(metrics.memory_percent).toFixed(1)} %)`
      : "取得不可";
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  const CSV_COLUMNS = [
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
</script>

<section class="health-page">
  <div class="health-page-header">
    <div>
      <p class="eyebrow">SYSTEM HEALTH</p>
      <h1>稼働状況</h1>
      <p>frontendのNginx経由で、各バックエンドとElasticsearchの状態を確認しています。</p>
    </div>
    <button class:is-refreshing={updating} class="health-refresh-button" type="button" disabled={updating} on:click={updateDashboard}>
      <span aria-hidden="true">↻</span> 今すぐ更新
    </button>
  </div>

  <div class="health-summary" aria-live="polite">
    <span class={`health-summary-dot ${updating && !updatedAt ? "is-checking" : summary.allHealthy ? "is-healthy" : "is-unhealthy"}`}></span>
    <strong>{updating && !updatedAt ? "確認中…" : summary.text}</strong>
    {#if updatedAt}<time datetime={updatedAt.toISOString()}>最終更新 {updatedAt.toLocaleTimeString("ja-JP")}</time>{/if}
  </div>

  <section class="health-section">
    <div class="health-section-heading">
      <div><p class="eyebrow">FRONTEND</p><h2>フロントエンドコンテナ</h2></div>
    </div>
    <div class="health-grid health-grid-elasticsearch">
      <article class={`health-card ${cardState(Boolean(frontendMetrics), updating && !updatedAt)}`}>
        <div class="health-card-top"><span class="health-service-icon" aria-hidden="true">F</span><span class="health-badge">{frontendMetrics ? "稼働中" : "取得不可"}</span></div>
        <h3>Frontend</h3>
        <p class="health-message">{frontendMetrics ? "この画面を配信しているフロントエンドコンテナです。" : containerMetrics.available ? "フロントエンドのコンテナ情報が見つかりません。" : "コンテナ統計APIへ接続できません。"}</p>
        <dl class="health-details">
          <div><dt>CPU</dt><dd>{frontendMetrics ? `${Number(frontendMetrics.cpu_percent).toFixed(2)} %` : "取得不可"}</dd></div>
          <div><dt>メモリ</dt><dd>{memoryText(frontendMetrics)}</dd></div>
        </dl>
      </article>
    </div>
  </section>

  <section class="health-section">
    <div class="health-section-heading">
      <div><p class="eyebrow">BACKENDS</p><h2>バックエンドコンテナ</h2></div>
      <span>5秒ごとに自動更新</span>
    </div>
    <div class="health-grid">
      {#each Object.entries(BACKENDS) as [key, backend]}
        {@const result = backendResults[key]}
        {@const metrics = container(`backend_${key}`)}
        <article class={`health-card ${cardState(result?.ok, !result)}`}>
          <div class="health-card-top"><span class="health-service-icon" aria-hidden="true">{backend.label.slice(0, 1)}</span><span class="health-badge">{!result ? "確認中" : result.ok ? "稼働中" : "停止"}</span></div>
          <h3>{backend.label}</h3>
          <p class="health-message">{result?.ok ? "Nginx経由で正常に応答しています。" : "応答がありません。コンテナの状態を確認してください。"}</p>
          <dl class="health-details">
            <div><dt>応答時間</dt><dd>{result?.ok ? `${result.latency} ms` : result ? "タイムアウト" : "—"}</dd></div>
            <div><dt>CPU</dt><dd>{metrics ? `${Number(metrics.cpu_percent).toFixed(2)} %` : "取得不可"}</dd></div>
            <div><dt>メモリ</dt><dd>{memoryText(metrics)}</dd></div>
          </dl>
        </article>
      {/each}
    </div>
  </section>

  <section class="health-section">
    <div class="health-section-heading">
      <div><p class="eyebrow">DATA STORE</p><h2>Elasticsearch</h2></div>
    </div>
    <div class="health-grid health-grid-elasticsearch">
      <article class={`health-card ${cardState(elasticsearch.ok, updating && !updatedAt)}`}>
        <div class="health-card-top"><span class="health-service-icon elasticsearch-icon" aria-hidden="true">E</span><span class="health-badge">{elasticsearch.ok ? "稼働中" : "接続不可"}</span></div>
        <h3>Elasticsearch</h3>
        <p class="health-message">{elasticsearch.ok ? `${elasticsearch.clusterName || "Elasticsearchクラスター"}へ正常に接続できています。` : elasticsearch.unavailable ? "確認に利用できるバックエンドがありません。" : "バックエンドからElasticsearchへ接続できません。"}</p>
        <dl class="health-details">
          <div><dt>接続経路</dt><dd>{elasticsearch.checkedBy ? BACKENDS[elasticsearch.checkedBy].label : "—"}</dd></div>
          <div><dt>応答時間</dt><dd>{elasticsearch.ok && Number.isFinite(Number(elasticsearch.latency)) ? `${elasticsearch.latency} ms` : "—"}</dd></div>
          <div><dt>バージョン</dt><dd>{elasticsearch.version || "—"}</dd></div>
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
      <form class="access-log-controls" on:submit|preventDefault={changeAccessLogDate}>
        <label>
          <span>対象日</span>
          <input type="date" name="date" value={accessLogDate} max={todayJstDate()}>
        </label>
        <button class="button-secondary" type="submit">表示</button>
        <button class="button-secondary" type="button" disabled={!accessLogs.length} on:click={downloadAccessLogCsv}>CSVダウンロード</button>
      </form>
    </div>
    <div class="access-log-summary">{accessLogStatus}</div>
    <div class="access-log-table-wrap">
      <table class="access-log-table">
        <thead>
          <tr><th>時刻</th><th>接続元</th><th>Method</th><th>URI</th><th>Status</th><th>応答時間</th></tr>
        </thead>
        <tbody>
          {#if accessLogs.length}
            {#each [...accessLogs].reverse() as entry}
              {@const status = Number(entry.status)}
              <tr>
                <td>{entry["@timestamp"] ? formatJst(entry["@timestamp"]).replace(" JST", "") : "—"}</td>
                <td>{entry.remote_addr || "—"}</td>
                <td>{entry.method || "—"}</td>
                <td class="access-log-uri" title={entry.uri || "—"}>{entry.uri || "—"}</td>
                <td class:is-error={status >= 400}>{entry.status ?? "—"}</td>
                <td>{entry.request_time ?? "—"} s</td>
              </tr>
            {/each}
          {:else}
            <tr><td colspan="6">{accessLogStatus === "取得失敗" ? "ログを取得できませんでした。" : `${accessLogDate} のアクセスログはありません。`}</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </section>
</section>
