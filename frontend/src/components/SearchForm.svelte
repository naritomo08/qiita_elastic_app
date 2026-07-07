<script>
  export let value = "";
  export let size = 10;
  export let navigate;

  let query = value;

  $: query = value;

  function submit() {
    const q = query.trim();
    if (!q) return;
    navigate(`/search?q=${encodeURIComponent(q)}&size=${size}`);
  }
</script>

<form class:compact={value} class="search-form" on:submit|preventDefault={submit}>
  <label class="sr-only" for="q">検索キーワード</label>
  <div class="search-box">
    <span class="search-icon" aria-hidden="true"></span>
    <input id="q" name="q" type="search" bind:value={query} placeholder="例: Elasticsearch, Python, Docker" required>
    <input type="hidden" name="size" value={size}>
    <button type="submit">検索</button>
  </div>
</form>
