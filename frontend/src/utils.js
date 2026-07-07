let mermaidInitialized = false;
let mermaidPromise;
const qiitaArticleLinkCache = new Map();

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatJst(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const parts = Object.fromEntries(JST_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} JST`;
}

export function todayJstDate() {
  const parts = Object.fromEntries(JST_FORMATTER.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function stripMarkdown(value) {
  return String(value)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function positiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function downloadTextFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function enhanceArticleMarkdown(body, tree, api) {
  await convertExistingQiitaArticleLinks(body, api);
  renderArticleTree(body, tree);
  secureArticleLinks(body);
  await renderMermaid(body);
  enhanceCodeBlocks(body);
  await renderLinkPreviews(body, api);
}

async function renderMermaid(body) {
  const blocks = [...body.querySelectorAll("pre > code.language-mermaid")];
  if (!blocks.length) return;
  const mermaid = await loadMermaid();
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif',
      flowchart: { htmlLabels: false, useMaxWidth: true },
    });
    mermaidInitialized = true;
  }
  for (const [index, code] of blocks.entries()) {
    const source = code.textContent;
    const diagram = document.createElement("div");
    diagram.className = "mermaid-diagram";
    diagram.id = `mermaid-diagram-${Date.now()}-${index}`;
    diagram.textContent = source;
    code.parentElement.replaceWith(diagram);
    try {
      await mermaid.run({ nodes: [diagram] });
    } catch {
      diagram.outerHTML = `<p class="mermaid-error-message">Mermaid図を描画できないため、定義を表示しています。</p><pre class="mermaid-error"><code>${escapeHtml(source)}</code></pre>`;
    }
  }
}

async function loadMermaid() {
  mermaidPromise ||= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

function renderArticleTree(body, tree) {
  if (!tree) return;
  const headings = [...body.querySelectorAll("h1, h2, h3, h4")].filter((heading) => heading.textContent.trim());
  if (!headings.length) {
    tree.closest(".article-tree")?.remove();
    return;
  }
  const usedIds = new Set();
  const items = headings.map((heading, index) => {
    heading.id = uniqueHeadingId(`section-${index + 1}`, usedIds);
    return {
      id: heading.id,
      level: Number(heading.tagName.slice(1)),
      title: heading.textContent.trim(),
    };
  });
  tree.innerHTML = `
    <p class="article-tree-title">目次</p>
    <ol class="article-tree-list">
      ${items.map((item) => `
        <li style="--tree-level: ${item.level - 1}">
          <a href="#${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a>
        </li>
      `).join("")}
    </ol>
  `;
  keepArticleTreePositionOnClick(tree);
  observeArticleTree(headings, tree);
}

function enhanceCodeBlocks(body) {
  body.querySelectorAll("pre").forEach((pre) => {
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
    button.addEventListener("click", async () => copyCode(button, code.textContent));
  });
}

async function renderLinkPreviews(body, api) {
  const links = [...body.querySelectorAll("p > a[href]")].filter((link) =>
    link.parentElement.children.length === 1 &&
    link.parentElement.textContent.trim() === link.textContent.trim() &&
    link.href.startsWith("http") &&
    (link.origin !== location.origin || link.dataset.localArticlePreview === "true")
  );
  await Promise.all(links.map(async (link) => {
    const paragraph = link.parentElement;
    const card = document.createElement("a");
    const isLocalArticle = link.dataset.localArticlePreview === "true";
    card.className = `link-preview-card${isLocalArticle ? "" : " is-loading"}`;
    card.href = link.href;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.innerHTML = `<span class="link-preview-content"><strong class="link-preview-title">${escapeHtml(link.textContent)}</strong><small class="link-preview-site">${escapeHtml(new URL(link.href).hostname)}</small></span><span class="link-preview-arrow">↗</span>`;
    paragraph.replaceWith(card);
    if (isLocalArticle) {
      card.querySelector(".link-preview-title").textContent = link.dataset.previewTitle || link.textContent;
      card.querySelector(".link-preview-site").textContent = link.dataset.previewSite || "Qiita Article Search";
      appendPreviewDescription(card, link.dataset.previewDescription);
      return;
    }
    try {
      const preview = await api("/api/link-preview", { url: link.href });
      card.classList.remove("is-loading");
      card.querySelector(".link-preview-title").textContent = preview.title;
      card.querySelector(".link-preview-site").textContent = preview.site_name;
      appendPreviewDescription(card, preview.description);
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

async function convertExistingQiitaArticleLinks(body, api) {
  const links = [...body.querySelectorAll("a[href]")];
  await Promise.all(links.map(async (link) => {
    const articleId = qiitaArticleId(link.href);
    const article = articleId ? await localArticle(articleId, api) : null;
    if (!article) return;
    link.href = `/articles/${encodeURIComponent(articleId)}`;
    link.dataset.localArticlePreview = "true";
    link.dataset.previewTitle = article.title || "無題の記事";
    link.dataset.previewSite = "本サイト内の記事";
    link.dataset.previewDescription = stripMarkdown(article.body || "").slice(0, 160);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }));
}

function secureArticleLinks(body) {
  body.querySelectorAll("a[href]").forEach((link) => {
    if (link.href.startsWith("http") && link.origin !== location.origin) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  });
}

function uniqueHeadingId(value, usedIds) {
  const fallback = "section";
  const base = String(value || fallback)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u3040-\u30ff\u3400-\u9fff-]/g, "") || fallback;
  let id = base;
  let count = 2;
  while (usedIds.has(id) || document.getElementById(id)) {
    id = `${base}-${count}`;
    count += 1;
  }
  usedIds.add(id);
  return id;
}

function observeArticleTree(headings, tree) {
  if (!("IntersectionObserver" in window)) return;
  const links = new Map([...tree.querySelectorAll("a[href^='#']")].map((link) => [
    decodeURIComponent(link.hash.slice(1)),
    link,
  ]));
  const observer = new IntersectionObserver((entries) => {
    const active = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!active) return;
    links.forEach((link) => link.classList.remove("is-active"));
    links.get(active.target.id)?.classList.add("is-active");
  }, {
    rootMargin: "-18% 0px -72% 0px",
    threshold: 0,
  });
  headings.forEach((heading) => observer.observe(heading));
}

function keepArticleTreePositionOnClick(tree) {
  tree.querySelectorAll("a[href^='#']").forEach((link) => {
    link.addEventListener("click", (event) => {
      const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (!target) return;
      event.preventDefault();
      const currentTreeTop = tree.scrollTop;
      target.scrollIntoView({ block: "start" });
      history.replaceState(null, "", link.hash);
      tree.scrollTop = currentTreeTop;
    });
  });
}

async function copyCode(button, value) {
  window.clearTimeout(button.copyStatusTimer);
  try {
    await copyText(value);
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
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function appendPreviewDescription(card, description) {
  if (!description) return;
  const element = document.createElement("span");
  element.className = "link-preview-description";
  element.textContent = description;
  card.querySelector(".link-preview-content").append(element);
}

function qiitaArticleId(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (!["qiita.com", "www.qiita.com"].includes(url.hostname.toLowerCase())) return "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[1] !== "items") return "";
  try {
    return decodeURIComponent(parts[2]);
  } catch {
    return parts[2];
  }
}

async function localArticle(articleId, api) {
  if (!qiitaArticleLinkCache.has(articleId)) {
    qiitaArticleLinkCache.set(articleId, api(`/api/articles/${encodeURIComponent(articleId)}`).catch(() => null));
  }
  return qiitaArticleLinkCache.get(articleId);
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
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
