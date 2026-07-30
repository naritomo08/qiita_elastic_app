<script>
  export let base = "/search";
  export let params = {};
  export let page = 1;
  export let totalPages = 1;
  export let navigate;

  function changePage(event) {
    const search = new URLSearchParams({ ...params, page: event.currentTarget.value });
    navigate(`${base}?${search}`);
  }
</script>

{#if totalPages > 1}
  <label class="page-selector">
    <span>ページ</span>
    <select aria-label="移動先のページ番号" value={page} on:change={changePage}>
      {#each Array.from({ length: totalPages }, (_, index) => index + 1) as pageNumber}
        <option value={pageNumber}>{pageNumber}</option>
      {/each}
    </select>
    <span>/ {totalPages}</span>
  </label>
{/if}
