<script>
  import { createEventDispatcher, onMount, tick } from "svelte";
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import Tags from "../components/Tags.svelte";
  import { api } from "../lib/api.js";
  import { enhanceArticleMarkdown } from "../lib/markdown.js";
  import { formatDate, removeDangerousBlocks, safeUrl } from "../lib/utils.js";

  export let articleId;

  const dispatch = createEventDispatcher();
  let article = null;
  let markdownHtml = "";
  let loading = true;

  onMount(load);

  async function load() {
    loading = true;
    try {
      article = await api(`/api/articles/${encodeURIComponent(articleId)}`);
      document.title = `${article.title || "無題の記事"} | Qiita Article Search`;
      marked.setOptions({ gfm: true, breaks: true });
      const source = removeDangerousBlocks(article.body || "本文がありません。");
      markdownHtml = DOMPurify.sanitize(marked.parse(source), {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["target", "rel", "class"],
      });
      loading = false;
      await tick();
      await enhanceArticleMarkdown();
    } catch (error) {
      dispatch("error", error.message || "記事を取得できませんでした。");
    } finally {
      loading = false;
    }
  }

  function downloadMarkdown() {
    const markdown = String(article?.body ?? "");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${markdownFileName(article?.title, article?.id)}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function markdownFileName(title, id) {
    const fallback = `article-${String(id ?? "download")}`;
    const fileName = String(title || fallback)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();
    return (fileName || fallback).slice(0, 100);
  }
</script>

{#if loading}
  <div class="loading-state">読み込み中…</div>
{:else if article}
  <article class="article-detail">
    <a class="back-link" href="/" data-route>← 記事一覧へ戻る</a>
    <div class="article-detail-layout">
      <main class="article-detail-main">
        <header class="detail-header">
          <p class="eyebrow">QIITA ARTICLE</p>
          <h1>{article.title || "無題の記事"}</h1>
          <Tags values={article.tags} large />
          <dl class="article-dates">
            <div><dt>作成</dt><dd>{formatDate(article.created_at)}</dd></div>
            <div><dt>更新</dt><dd>{formatDate(article.updated_at)}</dd></div>
          </dl>
          <div class="detail-actions">
            <button class="markdown-download-button" type="button" on:click={downloadMarkdown}>Markdownをダウンロード ↓</button>
            {#if article.url}
              <a class="original-link" href={safeUrl(article.url)} target="_blank" rel="noopener noreferrer">Qiita で元記事を読む ↗</a>
            {/if}
          </div>
        </header>
        <div class="article-body markdown-body">{@html markdownHtml}</div>
      </main>
      <aside class="article-tree" aria-label="記事の目次">
        <nav data-article-tree></nav>
      </aside>
    </div>
  </article>
{/if}
