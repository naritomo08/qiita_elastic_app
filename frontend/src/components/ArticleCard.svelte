<script>
  import Tags from "./Tags.svelte";
  import { formatDate, safeUrl, stripMarkdown } from "../lib/utils.js";

  export let article;
  export let dateField = "updated";

  $: dateLabel = dateField === "created" ? "作成" : "更新";
  $: dateValue = dateField === "created" ? article.created_at : article.updated_at;
  $: excerpt = stripMarkdown(article.body || "").slice(0, 180);
</script>

<article class="article-card">
  <div class="card-meta"><time>{dateLabel} {formatDate(dateValue)}</time></div>
  <h3><a href={`/articles/${encodeURIComponent(article.id)}`} data-route>{article.title || "無題の記事"}</a></h3>
  <Tags values={article.tags} />
  <p class="excerpt">{excerpt}{(article.body || "").length > 180 ? "…" : ""}</p>
  <div class="card-actions">
    <a class="card-link" href={`/articles/${encodeURIComponent(article.id)}`} data-route>記事を読む <span>→</span></a>
    {#if article.url}
      <a class="card-link external" href={safeUrl(article.url)} target="_blank" rel="noopener noreferrer">Qiitaで読む <span>↗</span></a>
    {/if}
  </div>
</article>
