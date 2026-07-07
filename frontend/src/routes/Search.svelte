<script>
  import { createEventDispatcher, onMount } from "svelte";
  import Pagination from "../components/Pagination.svelte";
  import SearchForm from "../components/SearchForm.svelte";
  import Tags from "../components/Tags.svelte";
  import { api } from "../lib/api.js";
  import { formatDate, positiveInt, safeUrl, sanitizeHighlight, stripMarkdown } from "../lib/utils.js";

  export let params;
  export let navigate;

  const dispatch = createEventDispatcher();
  let results = [];
  let total = 0;
  let loading = true;
  $: q = params.get("q")?.trim() || "";
  $: page = positiveInt(params.get("page"), 1);
  $: size = Math.min(positiveInt(params.get("size"), 10), 100);
  $: totalPages = Math.max(1, Math.ceil(total / size));

  onMount(load);

  async function load() {
    if (!q) {
      navigate("/");
      return;
    }
    loading = true;
    document.title = `「${q}」の検索結果 | Qiita Article Search`;
    try {
      const data = await api("/api/search", { q, page, size });
      results = data.results || [];
      total = Number(data.total) || 0;
    } catch (error) {
      dispatch("error", error.message || "検索結果を取得できませんでした。");
    } finally {
      loading = false;
    }
  }
</script>

<section class="search-header"><SearchForm value={q} {size} {navigate} /></section>
<section class="section search-results">
  <div class="results-summary">
    <div>
      <p class="eyebrow">SEARCH RESULTS</p>
      <h1>「{q}」の検索結果</h1>
    </div>
    <strong>{total.toLocaleString()}<small> 件</small></strong>
  </div>

  {#if loading}
    <div class="loading-state">読み込み中…</div>
  {:else if results.length}
    <div class="result-list">
      {#each results as article (article.id)}
        <article class="result-card">
          <div class="card-meta">
            <time>更新 {formatDate(article.updated_at)}</time>
            {#if article._score != null}<span>score {Number(article._score).toFixed(2)}</span>{/if}
          </div>
          <h2><a href={`/articles/${encodeURIComponent(article.id)}`} data-route>{@html sanitizeHighlight(article.highlight?.title?.[0]) || (article.title || "無題の記事")}</a></h2>
          <Tags values={article.tags} />
          <div class="highlights">
            {#if article.highlight?.body?.length}
              {#each article.highlight.body as item}
                <p>{@html sanitizeHighlight(item)}…</p>
              {/each}
            {:else}
              <p>{stripMarkdown(article.body || "").slice(0, 240)}</p>
            {/if}
          </div>
          <div class="card-actions">
            <a class="card-link" href={`/articles/${encodeURIComponent(article.id)}`} data-route>詳細を見る <span>→</span></a>
            {#if article.url}
              <a class="card-link external" href={safeUrl(article.url)} target="_blank" rel="noopener noreferrer">Qiitaで読む <span>↗</span></a>
            {/if}
          </div>
        </article>
      {/each}
    </div>
    <Pagination base="/search" params={{ q, size }} {page} {totalPages} />
  {:else}
    <div class="empty-state"><h3>一致する記事がありませんでした</h3><p>キーワードを短くするか、別の表記で検索してみてください。</p></div>
  {/if}
</section>
