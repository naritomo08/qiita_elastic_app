import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

const BACKENDS = {
  python: { label: "Python", port: 5020 },
  elixir: { label: "Elixir", port: 5021 },
  php: { label: "PHP", port: 5022 },
  java: { label: "Java", port: 5023 },
  go: { label: "Go", port: 5024 },
  ruby: { label: "Ruby", port: 5025 },
};
let selectedBackend = localStorage.getItem("qiita-search-backend");
if (!BACKENDS[selectedBackend]) selectedBackend = "python";

const app = document.querySelector("#app");
const apiLink = document.querySelector("#api-link");
const backendSelect = document.querySelector("#backend-select");
let healthRefreshTimer;
let healthRequestId = 0;
let healthUpdateRunning = false;
backendSelect.value = selectedBackend;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif',
  flowchart: { htmlLabels: false, useMaxWidth: true },
});

marked.setOptions({ gfm: true, breaks: true });

window.addEventListener("popstate", renderRoute);
backendSelect.addEventListener("change", async () => {
  selectedBackend = backendSelect.value;
  localStorage.setItem("qiita-search-backend", selectedBackend);
  app.innerHTML = `<div class="loading-state">${BACKENDS[selectedBackend].label}バックエンドへ切り替え中…</div>`;
  await renderRoute();
});

document.addEventListener("click", async (event) => {
  const healthRefreshButton = event.target.closest("[data-health-refresh]");
  if (healthRefreshButton) {
    await updateHealthDashboard();
    return;
  }

  const link = event.target.closest("a[data-route]");
  if (!link || link.origin !== location.origin) return;
  event.preventDefault();

  if (
    location.pathname === "/" &&
    link.pathname === "/" &&
    (link.dataset.tag !== undefined || link.dataset.clearTag !== undefined)
  ) {
    const tag = link.dataset.tag || "";
    history.pushState({}, "", tag ? `/?tag=${encodeURIComponent(tag)}` : "/");
    await updateHomeArticles(tag);
    return;
  }

  history.pushState({}, "", link.href);
  renderRoute();
});

document.addEventListener("submit", (event) => {
  if (!event.target.matches("[data-search-form]")) return;
  event.preventDefault();
  const query = new FormData(event.target).get("q")?.trim();
  if (!query) return;
  history.pushState({}, "", `/search?q=${encodeURIComponent(query)}`);
  renderRoute();
});

renderRoute();

async function renderRoute() {
  stopHealthMonitoring();
  window.scrollTo({ top: 0 });
  const path = location.pathname;
  try {
    if (path === "/health") {
      await renderHealthDashboard();
    } else if (path.startsWith("/articles/")) {
      await renderDetail(decodeURIComponent(path.slice("/articles/".length)));
    } else if (path === "/all") {
      await renderAllArticles();
    } else if (path === "/search") {
      await renderSearch();
    } else {
      await renderHome();
    }
  } catch (error) {
    renderError(error.message || "画面を表示できませんでした。");
  }
}

async function renderHealthDashboard() {
  document.title = "稼働状況 | Qiita Article Search";
  apiLink.href = `${apiBase()}/health/elasticsearch`;
  app.innerHTML = `
    <section class="health-page">
      <div class="health-page-header">
        <div>
          <p class="eyebrow">SYSTEM HEALTH</p>
          <h1>稼働状況</h1>
          <p>ブラウザから各バックエンドとElasticsearchへの接続状態を確認しています。</p>
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
        <div><dt>ポート</dt><dd>${backend.port}</dd></div>
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

async function updateHealthDashboard() {
  if (location.pathname !== "/health" || healthUpdateRunning) return;
  healthUpdateRunning = true;
  const requestId = ++healthRequestId;
  const refreshButton = document.querySelector("[data-health-refresh]");
  refreshButton?.classList.add("is-refreshing");
  refreshButton?.setAttribute("disabled", "");

  try {
    const [results, containerMetrics] = await Promise.all([
      Promise.all(Object.keys(BACKENDS).map(async (key) => [key, await checkBackendHealth(key)])),
      checkContainerMetrics(),
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

async function checkBackendHealth(key) {
  const startedAt = performance.now();
  try {
    const response = await fetchWithTimeout(`${backendBase(key)}/health`, 3500);
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();
    return { ok: true, latency: Math.round(performance.now() - startedAt) };
  } catch {
    return { ok: false, latency: Math.round(performance.now() - startedAt) };
  }
}

async function checkElasticsearchHealth(healthyKeys) {
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

async function requestElasticsearchHealth(key) {
  try {
    const response = await fetchWithTimeout(`${backendBase(key)}/health/elasticsearch`, 3500);
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

async function fetchWithTimeout(url, timeout) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal, cache: "no-store" });
  } finally {
    window.clearTimeout(timer);
  }
}

function updateBackendHealthCard(key, result) {
  const card = document.querySelector(`[data-backend-health="${key}"]`);
  if (!card) return;
  setHealthCardState(card, result.ok);
  card.querySelector(".health-badge").textContent = result.ok ? "稼働中" : "停止";
  card.querySelector(".health-message").textContent = result.ok
    ? "フロントエンドから正常に応答しています。"
    : "応答がありません。コンテナまたはポートを確認してください。";
  card.querySelector("[data-health-latency]").textContent = result.ok ? `${result.latency} ms` : "タイムアウト";
}

function updateFrontendHealthCard(metrics, metricsAvailable) {
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

function updateContainerUsage(card, metrics) {
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

function updateElasticsearchHealthCard(result) {
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
    ? `${BACKENDS[result.checkedBy].label} :${BACKENDS[result.checkedBy].port}`
    : "—";
  card.querySelector("[data-health-latency]").textContent =
    result.ok && Number.isFinite(Number(result.latency)) ? `${result.latency} ms` : "—";
  card.querySelector("[data-health-version]").textContent = result.version || "—";
}

function setHealthCardState(card, isHealthy) {
  card.classList.remove("is-checking", "is-healthy", "is-unhealthy");
  card.classList.add(isHealthy ? "is-healthy" : "is-unhealthy");
}

function updateHealthSummary(healthyCount, elasticsearch) {
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

function stopHealthMonitoring() {
  window.clearInterval(healthRefreshTimer);
  healthRefreshTimer = undefined;
  healthRequestId += 1;
  healthUpdateRunning = false;
}

async function renderAllArticles() {
  const params = new URLSearchParams(location.search);
  const page = positiveInt(params.get("page"), 1);
  const size = Math.min(positiveInt(params.get("size"), 20), 100);
  const data = await api("/api/articles", { page, size });
  const totalPages = Math.max(1, Math.ceil(data.total / size));
  document.title = "全記事一覧 | Qiita Article Search";
  apiLink.href = `${apiBase()}/api/articles?${new URLSearchParams({ page, size })}`;

  app.innerHTML = `
    <section class="all-articles-header">
      <p class="eyebrow">ALL ARTICLES</p>
      <div class="results-summary">
        <div>
          <h1>全記事一覧</h1>
          <p class="all-articles-copy">Elasticsearchに登録されている記事を作成日順で表示しています。</p>
        </div>
        <strong>${Number(data.total).toLocaleString()}<small> 件</small></strong>
      </div>
    </section>
    <section class="section">
      ${data.results.length ? `
        <div class="article-grid">${data.results.map((article) => articleCard(article, "created")).join("")}</div>
        ${allArticlesPagination(page, size, totalPages)}
      ` : emptyState("記事はまだありません", "Elasticsearchインデックスに記事を投入すると、ここに表示されます。")}
    </section>
  `;
}

async function renderHome() {
  const params = new URLSearchParams(location.search);
  const tag = params.get("tag")?.trim() || "";
  const data = await api("/api/recent", { size: tag ? 50 : 10, tag });
  document.title = "Qiita Article Search";
  apiLink.href = `${apiBase()}/api/search?q=Elasticsearch`;

  app.innerHTML = `
    <section class="hero">
      <p class="eyebrow">TECH ARTICLE DISCOVERY</p>
      <h1>知りたい技術を、<br>すばやく見つける。</h1>
      <p class="hero-copy">Elasticsearch に登録された Qiita 記事を、タイトル・本文・タグから横断検索できます。</p>
      ${searchForm("")}
    </section>
    ${homeArticleSection(data.results, tag)}
  `;
}

async function updateHomeArticles(tag) {
  const section = document.querySelector("#home-articles");
  if (!section) {
    await renderHome();
    return;
  }

  section.classList.add("is-updating");
  section.setAttribute("aria-busy", "true");
  try {
    const data = await api("/api/recent", { size: tag ? 50 : 10, tag });
    section.outerHTML = homeArticleSection(data.results, tag);
  } catch (error) {
    section.classList.remove("is-updating");
    section.removeAttribute("aria-busy");
    showNotice(error.message || "記事を取得できませんでした。");
  }
}

function homeArticleSection(articles, tag) {
  return `
    <section class="section" id="home-articles">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${tag ? "TAG FILTER" : "RECENTLY UPDATED"}</p>
          <h2>${tag ? `「${escapeHtml(tag)}」の記事` : "最近更新された記事"}</h2>
        </div>
        <span class="article-count">${articles.length.toLocaleString()} 件</span>
      </div>
      ${tag ? `
        <div class="active-filter">
          <span>タグで絞り込み中</span>
          <strong>${escapeHtml(tag)}</strong>
          <span class="filter-result-count">表示件数 <strong>${articles.length.toLocaleString()} 件</strong></span>
          <a href="/" data-route data-clear-tag>絞り込みを解除 ×</a>
        </div>` : ""}
      ${articleGrid(articles, tag)}
    </section>
  `;
}

async function renderSearch() {
  const params = new URLSearchParams(location.search);
  const q = params.get("q")?.trim() || "";
  const page = positiveInt(params.get("page"), 1);
  const size = Math.min(positiveInt(params.get("size"), 10), 100);
  if (!q) {
    history.replaceState({}, "", "/");
    await renderHome();
    showNotice("検索キーワードを入力してください。");
    return;
  }

  const data = await api("/api/search", { q, page, size });
  const totalPages = Math.max(1, Math.ceil(data.total / size));
  document.title = `「${q}」の検索結果 | Qiita Article Search`;
  apiLink.href = `${apiBase()}/api/search?${new URLSearchParams({ q, page, size })}`;

  app.innerHTML = `
    <section class="search-header">${searchForm(q, size)}</section>
    <section class="section search-results">
      <div class="results-summary">
        <div>
          <p class="eyebrow">SEARCH RESULTS</p>
          <h1>「${escapeHtml(q)}」の検索結果</h1>
        </div>
        <strong>${Number(data.total).toLocaleString()}<small> 件</small></strong>
      </div>
      ${data.results.length ? `
        <div class="result-list">${data.results.map(resultCard).join("")}</div>
        ${pagination(q, page, size, totalPages)}
      ` : emptyState("一致する記事がありませんでした", "キーワードを短くするか、別の表記で検索してみてください。")}
    </section>
  `;
}

async function renderDetail(articleId) {
  const article = await api(`/api/articles/${encodeURIComponent(articleId)}`);
  document.title = `${article.title || "無題の記事"} | Qiita Article Search`;
  apiLink.href = `${apiBase()}/api/articles/${encodeURIComponent(articleId)}`;

  const source = removeDangerousBlocks(article.body || "本文がありません。");
  const markdownHtml = DOMPurify.sanitize(marked.parse(source), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel", "class"],
  });

  app.innerHTML = `
    <article class="article-detail">
      <a class="back-link" href="/" data-route>← 記事一覧へ戻る</a>
      <header class="detail-header">
        <p class="eyebrow">QIITA ARTICLE</p>
        <h1>${escapeHtml(article.title || "無題の記事")}</h1>
        ${tags(article.tags, true)}
        <dl class="article-dates">
          <div><dt>作成</dt><dd>${formatDate(article.created_at)}</dd></div>
          <div><dt>更新</dt><dd>${formatDate(article.updated_at)}</dd></div>
        </dl>
        ${article.url ? `<a class="original-link" href="${safeUrl(article.url)}" target="_blank" rel="noopener noreferrer">Qiita で元記事を読む ↗</a>` : ""}
      </header>
      <div class="article-body markdown-body">${markdownHtml}</div>
    </article>
  `;

  secureArticleLinks();
  await renderMermaid();
  enhanceCodeBlocks();
  await renderLinkPreviews();
}

function articleGrid(articles, selectedTag) {
  if (!articles.length) {
    return selectedTag
      ? emptyState(`「${escapeHtml(selectedTag)}」の記事は見つかりませんでした`, '<a href="/" data-route>絞り込みを解除して記事一覧へ戻る</a>')
      : emptyState("記事はまだありません", "Elasticsearch インデックスに記事を投入すると、ここに表示されます。");
  }
  const dateField = selectedTag ? "created" : "updated";
  return `<div class="article-grid">${articles.map((article) => articleCard(article, dateField)).join("")}</div>`;
}

function articleCard(article, dateField = "updated") {
  const dateLabel = dateField === "created" ? "作成" : "更新";
  const dateValue = dateField === "created" ? article.created_at : article.updated_at;
  return `
    <article class="article-card">
      <div class="card-meta"><time>${dateLabel} ${formatDate(dateValue)}</time></div>
      <h3><a href="/articles/${encodeURIComponent(article.id)}" data-route>${escapeHtml(article.title || "無題の記事")}</a></h3>
      ${tags(article.tags)}
      <p class="excerpt">${escapeHtml(stripMarkdown(article.body || "").slice(0, 180))}${(article.body || "").length > 180 ? "…" : ""}</p>
      <div class="card-actions">
        <a class="card-link" href="/articles/${encodeURIComponent(article.id)}" data-route>記事を読む <span>→</span></a>
        ${article.url ? `<a class="card-link external" href="${safeUrl(article.url)}" target="_blank" rel="noopener noreferrer">Qiitaで読む <span>↗</span></a>` : ""}
      </div>
    </article>
  `;
}

function resultCard(article) {
  const highlightedTitle = sanitizeHighlight(article.highlight?.title?.[0]) || escapeHtml(article.title || "無題の記事");
  const fragments = article.highlight?.body?.length
    ? article.highlight.body.map((item) => `<p>${sanitizeHighlight(item)}…</p>`).join("")
    : `<p>${escapeHtml(stripMarkdown(article.body || "").slice(0, 240))}</p>`;
  return `
    <article class="result-card">
      <div class="card-meta">
        <time>更新 ${formatDate(article.updated_at)}</time>
        ${article._score != null ? `<span>score ${Number(article._score).toFixed(2)}</span>` : ""}
      </div>
      <h2><a href="/articles/${encodeURIComponent(article.id)}" data-route>${highlightedTitle}</a></h2>
      ${tags(article.tags)}
      <div class="highlights">${fragments}</div>
      <div class="card-actions">
        <a class="card-link" href="/articles/${encodeURIComponent(article.id)}" data-route>詳細を見る <span>→</span></a>
        ${article.url ? `<a class="card-link external" href="${safeUrl(article.url)}" target="_blank" rel="noopener noreferrer">Qiitaで読む <span>↗</span></a>` : ""}
      </div>
    </article>
  `;
}

function tags(values, large = false) {
  if (!Array.isArray(values) || !values.length) return "";
  return `<div class="tags${large ? " large" : ""}">${values.map((tag) =>
    `<a class="tag" href="/?tag=${encodeURIComponent(tag)}" data-route data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</a>`
  ).join("")}</div>`;
}

function searchForm(value, size = 10) {
  return `
    <form class="search-form${value ? " compact" : ""}" data-search-form>
      <label class="sr-only" for="q">検索キーワード</label>
      <div class="search-box">
        <span class="search-icon" aria-hidden="true"></span>
        <input id="q" name="q" type="search" value="${escapeHtml(value)}" placeholder="例: Elasticsearch, Python, Docker" required>
        <input type="hidden" name="size" value="${size}">
        <button type="submit">検索</button>
      </div>
    </form>`;
}

function pagination(q, page, size, totalPages) {
  if (totalPages <= 1) return "";
  const link = (target, label) => `<a href="/search?${new URLSearchParams({ q, page: target, size })}" data-route>${label}</a>`;
  return `
    <nav class="pagination">
      ${page > 1 ? link(page - 1, "← 前へ") : '<span class="disabled">← 前へ</span>'}
      <span>${page} / ${totalPages}</span>
      ${page < totalPages ? link(page + 1, "次へ →") : '<span class="disabled">次へ →</span>'}
    </nav>`;
}

function allArticlesPagination(page, size, totalPages) {
  if (totalPages <= 1) return "";
  const link = (target, label) =>
    `<a href="/all?${new URLSearchParams({ page: target, size })}" data-route>${label}</a>`;
  return `
    <nav class="pagination">
      ${page > 1 ? link(page - 1, "← 前へ") : '<span class="disabled">← 前へ</span>'}
      <span>${page} / ${totalPages}</span>
      ${page < totalPages ? link(page + 1, "次へ →") : '<span class="disabled">次へ →</span>'}
    </nav>`;
}

async function renderMermaid() {
  const blocks = [...document.querySelectorAll(".markdown-body pre > code.language-mermaid")];
  for (const [index, code] of blocks.entries()) {
    const source = code.textContent;
    const diagram = document.createElement("div");
    diagram.className = "mermaid-diagram";
    diagram.id = `mermaid-diagram-${index}`;
    diagram.textContent = source;
    code.parentElement.replaceWith(diagram);
    try {
      await mermaid.run({ nodes: [diagram] });
    } catch {
      diagram.outerHTML = `<p class="mermaid-error-message">Mermaid図を描画できないため、定義を表示しています。</p><pre class="mermaid-error"><code>${escapeHtml(source)}</code></pre>`;
    }
  }
}

function enhanceCodeBlocks() {
  document.querySelectorAll(".markdown-body pre").forEach((pre) => {
    if (pre.parentElement?.classList.contains("code-block")) return;

    const code = pre.querySelector(":scope > code");
    if (!code) return;

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    pre.before(wrapper);
    wrapper.append(pre);

    const button = document.createElement("button");
    button.className = "code-copy-button";
    button.type = "button";
    button.setAttribute("aria-label", "コードをコピー");
    button.title = "コードをコピー";
    button.innerHTML = `
      <svg class="copy-icon" aria-hidden="true" viewBox="0 0 24 24">
        <path d="M8 8V5.8A1.8 1.8 0 0 1 9.8 4h8.4A1.8 1.8 0 0 1 20 5.8v8.4a1.8 1.8 0 0 1-1.8 1.8H16"></path>
        <rect x="4" y="8" width="12" height="12" rx="2"></rect>
      </svg>
      <svg class="check-icon" aria-hidden="true" viewBox="0 0 24 24">
        <path d="m5 12 4 4L19 6"></path>
      </svg>
      <span class="sr-only code-copy-status" aria-live="polite"></span>
    `;
    wrapper.append(button);

    button.addEventListener("click", async () => {
      window.clearTimeout(button.copyStatusTimer);
      try {
        await copyText(code.textContent);
        button.classList.remove("is-copy-error");
        button.classList.add("is-copied");
        button.setAttribute("aria-label", "コピーしました");
        button.title = "コピーしました";
        button.querySelector(".code-copy-status").textContent = "コピーしました";
      } catch {
        button.classList.remove("is-copied");
        button.classList.add("is-copy-error");
        button.setAttribute("aria-label", "コピーできませんでした");
        button.title = "コピーできませんでした";
        button.querySelector(".code-copy-status").textContent = "コピーできませんでした";
      }
      button.copyStatusTimer = window.setTimeout(() => {
        button.classList.remove("is-copied", "is-copy-error");
        button.setAttribute("aria-label", "コードをコピー");
        button.title = "コードをコピー";
        button.querySelector(".code-copy-status").textContent = "";
      }, 1800);
    });
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // 権限やブラウザ制限で失敗した場合は、従来方式を試す。
    }
  }

  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  try {
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
}

async function renderLinkPreviews() {
  const links = [...document.querySelectorAll(".markdown-body p > a[href]")].filter((link) =>
    link.parentElement.children.length === 1 &&
    link.parentElement.textContent.trim() === link.textContent.trim() &&
    link.href.startsWith("http")
  );
  await Promise.all(links.map(async (link) => {
    const paragraph = link.parentElement;
    const card = document.createElement("a");
    card.className = "link-preview-card is-loading";
    card.href = link.href;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.innerHTML = `<span class="link-preview-content"><strong class="link-preview-title">${escapeHtml(link.textContent)}</strong><small class="link-preview-site">${escapeHtml(new URL(link.href).hostname)}</small></span><span class="link-preview-arrow">↗</span>`;
    paragraph.replaceWith(card);
    try {
      const preview = await api("/api/link-preview", { url: link.href });
      card.classList.remove("is-loading");
      card.querySelector(".link-preview-title").textContent = preview.title;
      card.querySelector(".link-preview-site").textContent = preview.site_name;
      if (preview.description) {
        const description = document.createElement("span");
        description.className = "link-preview-description";
        description.textContent = preview.description;
        card.querySelector(".link-preview-content").append(description);
      }
      if (preview.image) {
        const image = document.createElement("img");
        image.className = "link-preview-image";
        image.src = preview.image;
        image.alt = "";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        card.prepend(image);
      }
    } catch {
      card.classList.remove("is-loading");
    }
  }));
}

function secureArticleLinks() {
  document.querySelectorAll(".markdown-body a[href]").forEach((link) => {
    if (link.href.startsWith("http")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  });
}

async function api(path, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value != null) query.set(key, value);
  });
  const response = await fetch(`${apiBase()}${path}${query.size ? `?${query}` : ""}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("バックエンドから想定外のレスポンスが返されました。");
  }
  if (!response.ok) throw new Error(payload.error || "バックエンドでエラーが発生しました。");
  return payload;
}

function apiBase() {
  return backendBase(selectedBackend);
}

function backendBase(key) {
  return `${location.protocol}//${location.hostname}:${BACKENDS[key].port}`;
}

function renderError(message) {
  app.innerHTML = `<section class="error-page"><p class="error-code">APPLICATION ERROR</p><h1>画面を表示できませんでした</h1><p>${escapeHtml(message)}</p><a class="button-secondary" href="/" data-route>トップページへ戻る</a></section>`;
}

function showNotice(message) {
  app.insertAdjacentHTML("afterbegin", `<div class="alert alert-warning">${escapeHtml(message)}</div>`);
}

function emptyState(title, description) {
  return `<div class="empty-state"><h3>${title}</h3><p>${description}</p></div>`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function sanitizeHighlight(value) {
  if (!value) return "";
  const escaped = escapeHtml(value);
  return escaped.replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
}

function removeDangerousBlocks(value) {
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}

function stripMarkdown(value) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? escapeHtml(url.href) : "#";
  } catch {
    return "#";
  }
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}
