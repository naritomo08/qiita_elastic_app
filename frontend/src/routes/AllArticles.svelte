<script>
  import { createEventDispatcher, onMount } from "svelte";
  import ArticleCard from "../components/ArticleCard.svelte";
  import Pagination from "../components/Pagination.svelte";
  import { api } from "../lib/api.js";
  import { positiveInt } from "../lib/utils.js";

  export let params;
  const dispatch = createEventDispatcher();
  let results = [];
  let total = 0;
  let loading = true;
  $: page = positiveInt(params.get("page"), 1);
  $: size = Math.min(positiveInt(params.get("size"), 20), 100);
  $: totalPages = Math.max(1, Math.ceil(total / size));

  onMount(load);

  async function load() {
    loading = true;
    document.title = "全記事一覧 | Qiita Article Search";
    try {
      const data = await api("/api/articles", { page, size });
      results = data.results || [];
      total = Number(data.total) || 0;
    } catch (error) {
      dispatch("error", error.message || "記事一覧を取得できませんでした。");
    } finally {
      loading = false;
    }
  }
</script>

<section class="all-articles-header">
  <p class="eyebrow">ALL ARTICLES</p>
  <div class="results-summary">
    <div>
      <h1>全記事一覧</h1>
      <p class="all-articles-copy">Elasticsearchに登録されている記事を作成日順で表示しています。</p>
    </div>
    <strong>{total.toLocaleString()}<small> 件</small></strong>
  </div>
</section>

<section class="section">
  {#if loading}
    <div class="loading-state">読み込み中…</div>
  {:else if results.length}
    <div class="article-grid">
      {#each results as article (article.id)}
        <ArticleCard {article} dateField="created" />
      {/each}
    </div>
    <Pagination base="/all" params={{ size }} {page} {totalPages} />
  {:else}
    <div class="empty-state"><h3>記事はまだありません</h3><p>Elasticsearchインデックスに記事を投入すると、ここに表示されます。</p></div>
  {/if}
</section>
