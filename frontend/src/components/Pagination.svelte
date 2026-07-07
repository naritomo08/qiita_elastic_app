<script>
  export let base = "/search";
  export let params = {};
  export let page = 1;
  export let totalPages = 1;

  function href(target) {
    return `${base}?${new URLSearchParams({ ...params, page: target })}`;
  }
</script>

{#if totalPages > 1}
  <nav class="pagination">
    {#if page > 1}
      <a href={href(page - 1)} data-route>← 前へ</a>
    {:else}
      <span class="disabled">← 前へ</span>
    {/if}
    <span>{page} / {totalPages}</span>
    {#if page < totalPages}
      <a href={href(page + 1)} data-route>次へ →</a>
    {:else}
      <span class="disabled">次へ →</span>
    {/if}
  </nav>
{/if}
