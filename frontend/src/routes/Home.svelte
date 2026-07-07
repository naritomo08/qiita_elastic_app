<script>
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import ArticleCard from "../components/ArticleCard.svelte";
  import SearchForm from "../components/SearchForm.svelte";
  import { HOME_REFRESH_INTERVAL } from "../lib/config.js";
  import { api } from "../lib/api.js";

  export let params;
  export let navigate;

  const dispatch = createEventDispatcher();
  let articles = [];
  let total = 0;
  let updatedAt = new Date();
  let updating = false;
  let timer;
  $: tag = params.get("tag")?.trim() || "";

  onMount(async () => {
    document.title = "Qiita Article Search";
    await load();
    timer = window.setInterval(load, HOME_REFRESH_INTERVAL);
  });

  onDestroy(() => window.clearInterval(timer));

  async function load() {
    if (updating) return;
    updating = true;
    try {
      const [recent, articleList] = await Promise.all([
        api("/api/recent", { size: tag ? 50 : 10, tag }),
        api("/api/articles", { page: 1, size: 1 }),
      ]);
      articles = recent.results || [];
      total = Number(articleList.total) || 0;
      updatedAt = new Date();
    } catch (error) {
      dispatch("error", error.message || "記事を取得できませんでした。");
    } finally {
      updating = false;
    }
  }
</script>

<section class="hero">
  <p class="eyebrow">TECH ARTICLE DISCOVERY</p>
  <h1>知りたい技術を、<br>すばやく見つける。</h1>
  <p class="hero-copy">Elasticsearch に登録された Qiita 記事を、タイトル・本文・タグから横断検索できます。</p>
  <div class="article-total" aria-label="現在の記事総数">
    <span>現在の記事総数</span>
    <strong>{total.toLocaleString("ja-JP")}<small> 件</small></strong>
  </div>
  <SearchForm value="" {navigate} />
</section>

<section class:is-updating={updating} class="section" id="home-articles" aria-busy={updating}>
  <div class="section-heading">
    <div>
      <p class="eyebrow">{tag ? "TAG FILTER" : "RECENTLY UPDATED"}</p>
      <h2>{tag ? `「${tag}」の記事` : "最近更新された記事"}</h2>
    </div>
    <div class="article-list-controls">
      <span class="article-count">{articles.length.toLocaleString()} 件</span>
      <time datetime={updatedAt.toISOString()}>{updatedAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 更新</time>
      <button type="button" aria-label="記事一覧を更新" disabled={updating} on:click={load}>
        <span aria-hidden="true">↻</span> 更新
      </button>
    </div>
  </div>

  {#if tag}
    <div class="active-filter">
      <span>タグで絞り込み中</span>
      <strong>{tag}</strong>
      <span class="filter-result-count">表示件数 <strong>{articles.length.toLocaleString()} 件</strong></span>
      <a href="/" data-route data-clear-tag>絞り込みを解除 ×</a>
    </div>
  {/if}

  {#if articles.length}
    <div class="article-grid">
      {#each articles as article (article.id)}
        <ArticleCard {article} dateField={tag ? "created" : "updated"} />
      {/each}
    </div>
  {:else if tag}
    <div class="empty-state"><h3>「{tag}」の記事は見つかりませんでした</h3><p><a href="/" data-route>絞り込みを解除して記事一覧へ戻る</a></p></div>
  {:else}
    <div class="empty-state"><h3>記事はまだありません</h3><p>Elasticsearch インデックスに記事を投入すると、ここに表示されます。</p></div>
  {/if}
</section>
