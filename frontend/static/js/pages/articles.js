import { HOME_REFRESH_INTERVAL } from "../config.js";
import { app } from "../state.js";
import {
  api,
  emptyState,
  escapeHtml,
  formatDate,
  positiveInt,
  removeDangerousBlocks,
  safeUrl,
  sanitizeHighlight,
  showNotice,
  stripMarkdown,
} from "../common.js";

let homeRefreshTimer;
let homeUpdateRunning = false;
let markdownLibraryPromise;
let markdownComponentsPromise;
const scriptPromises = new Map();
const MARKED_URL = "https://cdn.jsdelivr.net/npm/marked@15/marked.min.js";
const DOMPURIFY_URL = "https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js";

function loadScript(src) {
  if (scriptPromises.has(src)) return scriptPromises.get(src);

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(script);
  });
  scriptPromises.set(src, promise);
  return promise;
}

async function loadMarkdownLibraries() {
  markdownLibraryPromise ||= Promise.all([
    loadScript(MARKED_URL),
    loadScript(DOMPURIFY_URL),
  ]).then(() => {
    const { marked, DOMPurify } = window;
    if (!marked || !DOMPurify) throw new Error("Markdown libraries are unavailable.");
    marked.setOptions({ gfm: true, breaks: true });
    return { marked, DOMPurify };
  });
  return markdownLibraryPromise;
}

function loadMarkdownComponents() {
  markdownComponentsPromise ||= import("../components/markdown.js");
  return markdownComponentsPromise;
}

export async function renderAllArticles() {
  const params = new URLSearchParams(location.search);
  const page = positiveInt(params.get("page"), 1);
  const size = Math.min(positiveInt(params.get("size"), 20), 100);
  const data = await api("/api/articles", { page, size });
  const totalPages = Math.max(1, Math.ceil(data.total / size));
  document.title = "全記事一覧 | Qiita Article Search";

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
        <div class="article-grid row g-3">${data.results.map((article) => articleCard(article, "created")).join("")}</div>
        ${allArticlesPagination(page, size, totalPages)}
      ` : emptyState("記事はまだありません", "Elasticsearchインデックスに記事を投入すると、ここに表示されます。")}
    </section>
  `;
}

export async function renderHome() {
  const params = new URLSearchParams(location.search);
  const tag = params.get("tag")?.trim() || "";
  const { recent, total } = await fetchHomeData(tag);
  document.title = "Qiita Article Search";

  app.innerHTML = `
    <section class="hero">
      <p class="eyebrow">TECH ARTICLE DISCOVERY</p>
      <h1>知りたい技術を、<br>すばやく見つける。</h1>
      <p class="hero-copy">Elasticsearch に登録された Qiita 記事を、タイトル・本文・タグから横断検索できます。</p>
      <div class="article-total" aria-label="現在の記事総数">
        <span>現在の記事総数</span>
        <strong data-home-total>${total.toLocaleString("ja-JP")}<small> 件</small></strong>
      </div>
      ${searchForm("")}
    </section>
    ${homeArticleSection(recent.results, tag)}
  `;
  startHomeMonitoring(tag);
}

export async function updateHomeArticles(tag) {
  if (homeUpdateRunning || location.pathname !== "/") return;
  const section = document.querySelector("#home-articles");
  if (!section) {
    await renderHome();
    return;
  }

  homeUpdateRunning = true;
  section.classList.add("is-updating");
  section.setAttribute("aria-busy", "true");
  section.querySelector("[data-home-refresh]")?.setAttribute("disabled", "");
  try {
    const { recent, total } = await fetchHomeData(tag);
    const currentTag = new URLSearchParams(location.search).get("tag")?.trim() || "";
    if (location.pathname !== "/" || currentTag !== tag) return;
    const totalElement = document.querySelector("[data-home-total]");
    if (totalElement) {
      totalElement.innerHTML = `${total.toLocaleString("ja-JP")}<small> 件</small>`;
    }
    section.outerHTML = homeArticleSection(recent.results, tag);
  } catch (error) {
    section.classList.remove("is-updating");
    section.removeAttribute("aria-busy");
    section.querySelector("[data-home-refresh]")?.removeAttribute("disabled");
    showNotice(error.message || "記事を取得できませんでした。");
  } finally {
    homeUpdateRunning = false;
  }
}

async function fetchHomeData(tag) {
  const [recent, articleList] = await Promise.all([
    api("/api/recent", { size: tag ? 50 : 10, tag }),
    api("/api/articles", { page: 1, size: 1 }),
  ]);
  return {
    recent,
    total: Number(articleList.total) || 0,
  };
}

function homeArticleSection(articles, tag) {
  const updatedAt = new Date();
  return `
    <section class="section" id="home-articles">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${tag ? "TAG FILTER" : "RECENTLY UPDATED"}</p>
          <h2>${tag ? `「${escapeHtml(tag)}」の記事` : "最近更新された記事"}</h2>
        </div>
        <div class="article-list-controls">
          <span class="article-count">${articles.length.toLocaleString()} 件</span>
          <time datetime="${updatedAt.toISOString()}">${updatedAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 更新</time>
          <button class="btn btn-outline-success btn-sm" type="button" data-home-refresh aria-label="記事一覧を更新">
            <span aria-hidden="true">↻</span> 更新
          </button>
        </div>
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

function startHomeMonitoring(tag) {
  homeRefreshTimer = window.setInterval(() => updateHomeArticles(tag), HOME_REFRESH_INTERVAL);
}

export function stopHomeMonitoring() {
  window.clearInterval(homeRefreshTimer);
  homeRefreshTimer = undefined;
  homeUpdateRunning = false;
}

export async function renderSearch() {
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
        <div class="result-list d-grid gap-3">${data.results.map(resultCard).join("")}</div>
        ${pagination(q, page, size, totalPages)}
      ` : emptyState("一致する記事がありませんでした", "キーワードを短くするか、別の表記で検索してみてください。")}
    </section>
  `;
}

export async function renderDetail(articleId) {
  const articlePromise = api(`/api/articles/${encodeURIComponent(articleId)}`);
  const markdownSetupPromise = Promise.all([
    loadMarkdownLibraries(),
    loadMarkdownComponents(),
  ]);
  const [article, [{ marked, DOMPurify }, markdown]] = await Promise.all([
    articlePromise,
    markdownSetupPromise,
  ]);
  document.title = `${article.title || "無題の記事"} | Qiita Article Search`;

  const source = removeDangerousBlocks(article.body || "本文がありません。");
  const markdownHtml = DOMPurify.sanitize(marked.parse(source), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel", "class"],
  });

  app.innerHTML = `
    <article class="article-detail">
      <a class="back-link" href="/" data-route>← 記事一覧へ戻る</a>
      <div class="article-detail-layout">
        <main class="article-detail-main">
          <header class="detail-header">
            <p class="eyebrow">QIITA ARTICLE</p>
            <h1>${escapeHtml(article.title || "無題の記事")}</h1>
            ${tags(article.tags, true)}
            <dl class="article-dates">
              <div><dt>作成</dt><dd>${formatDate(article.created_at)}</dd></div>
              <div><dt>更新</dt><dd>${formatDate(article.updated_at)}</dd></div>
            </dl>
            <div class="detail-actions">
              <button class="markdown-download-button btn btn-outline-success" type="button" data-markdown-download>Markdownをダウンロード ↓</button>
              ${article.url ? `<a class="original-link btn btn-success" href="${safeUrl(article.url)}" target="_blank" rel="noopener noreferrer">Qiita で元記事を読む ↗</a>` : ""}
            </div>
          </header>
          <div class="article-body markdown-body">${markdownHtml}</div>
        </main>
        <aside class="article-tree" aria-label="記事の目次">
          <nav data-article-tree></nav>
        </aside>
      </div>
    </article>
  `;

  document.querySelector("[data-markdown-download]")?.addEventListener("click", () => {
    downloadMarkdown(article);
  });
  await markdown.convertExistingQiitaArticleLinks();
  markdown.renderArticleTree();
  markdown.secureArticleLinks();
  await markdown.renderMermaid();
  markdown.enhanceCodeBlocks();
  await markdown.renderLinkPreviews();
}

function downloadMarkdown(article) {
  const markdown = String(article.body ?? "");
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${markdownFileName(article.title, article.id)}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function markdownFileName(title, articleId) {
  const fallback = `article-${String(articleId ?? "download")}`;
  const fileName = String(title || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (fileName || fallback).slice(0, 100);
}

function articleGrid(articles, selectedTag) {
  if (!articles.length) {
    return selectedTag
      ? emptyState(`「${escapeHtml(selectedTag)}」の記事は見つかりませんでした`, '<a href="/" data-route>絞り込みを解除して記事一覧へ戻る</a>')
      : emptyState("記事はまだありません", "Elasticsearch インデックスに記事を投入すると、ここに表示されます。");
  }
  const dateField = selectedTag ? "created" : "updated";
  return `<div class="article-grid row g-3">${articles.map((article) => articleCard(article, dateField)).join("")}</div>`;
}

function articleCard(article, dateField = "updated") {
  const dateLabel = dateField === "created" ? "作成" : "更新";
  const dateValue = dateField === "created" ? article.created_at : article.updated_at;
  return `
    <article class="article-card card h-100">
      <div class="card-meta"><time>${dateLabel} ${formatDate(dateValue)}</time></div>
      <h3><a href="/articles/${encodeURIComponent(article.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title || "無題の記事")}</a></h3>
      ${tags(article.tags)}
      <p class="excerpt">${escapeHtml(stripMarkdown(article.body || "").slice(0, 180))}${(article.body || "").length > 180 ? "…" : ""}</p>
      <div class="card-actions">
        <a class="card-link" href="/articles/${encodeURIComponent(article.id)}" target="_blank" rel="noopener noreferrer">記事を読む <span>↗</span></a>
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
    <article class="result-card card">
      <div class="card-meta">
        <time>更新 ${formatDate(article.updated_at)}</time>
        ${article._score != null ? `<span>score ${Number(article._score).toFixed(2)}</span>` : ""}
      </div>
      <h2><a href="/articles/${encodeURIComponent(article.id)}" target="_blank" rel="noopener noreferrer">${highlightedTitle}</a></h2>
      ${tags(article.tags)}
      <div class="highlights">${fragments}</div>
      <div class="card-actions">
        <a class="card-link" href="/articles/${encodeURIComponent(article.id)}" target="_blank" rel="noopener noreferrer">詳細を見る <span>↗</span></a>
        ${article.url ? `<a class="card-link external" href="${safeUrl(article.url)}" target="_blank" rel="noopener noreferrer">Qiitaで読む <span>↗</span></a>` : ""}
      </div>
    </article>
  `;
}

function tags(values, large = false) {
  if (!Array.isArray(values) || !values.length) return "";
  return `<div class="tags${large ? " large" : ""}">${values.map((tag) =>
    `<a class="tag badge rounded-pill text-bg-success-subtle" href="/?tag=${encodeURIComponent(tag)}" data-route data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</a>`
  ).join("")}</div>`;
}

function searchForm(value, size = 10) {
  return `
    <form class="search-form${value ? " compact" : ""}" data-search-form>
      <label class="sr-only" for="q">検索キーワード</label>
      <div class="search-box input-group">
        <span class="search-icon" aria-hidden="true"></span>
        <input id="q" class="form-control" name="q" type="search" value="${escapeHtml(value)}" placeholder="例: Elasticsearch, Python, Docker" required>
        <input type="hidden" name="size" value="${size}">
        <button class="btn btn-success" type="submit">検索</button>
      </div>
    </form>`;
}

function pagination(q, page, size, totalPages) {
  if (totalPages <= 1) return "";
  const link = (target, label) => `<li class="page-item"><a class="page-link" href="/search?${new URLSearchParams({ q, page: target, size })}" data-route>${label}</a></li>`;
  return `
    <nav class="pagination-wrap" aria-label="検索結果のページ送り">
      <ul class="pagination justify-content-center">
        ${page > 1 ? link(page - 1, "← 前へ") : '<li class="page-item disabled"><span class="page-link">← 前へ</span></li>'}
        <li class="page-item disabled"><span class="page-link">${page} / ${totalPages}</span></li>
        ${page < totalPages ? link(page + 1, "次へ →") : '<li class="page-item disabled"><span class="page-link">次へ →</span></li>'}
      </ul>
    </nav>`;
}

function allArticlesPagination(page, size, totalPages) {
  if (totalPages <= 1) return "";
  const link = (target, label) =>
    `<li class="page-item"><a class="page-link" href="/all?${new URLSearchParams({ page: target, size })}" data-route>${label}</a></li>`;
  return `
    <nav class="pagination-wrap" aria-label="全記事一覧のページ送り">
      <ul class="pagination justify-content-center">
        ${page > 1 ? link(page - 1, "← 前へ") : '<li class="page-item disabled"><span class="page-link">← 前へ</span></li>'}
        <li class="page-item disabled"><span class="page-link">${page} / ${totalPages}</span></li>
        ${page < totalPages ? link(page + 1, "次へ →") : '<li class="page-item disabled"><span class="page-link">次へ →</span></li>'}
      </ul>
    </nav>`;
}
