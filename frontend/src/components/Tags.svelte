<script>
  export let values = [];
  export let large = false;
</script>

{#if Array.isArray(values) && values.length}
  <div class:large class="tags">
    {#each values as tag}
      <a class="tag" href={`/?tag=${encodeURIComponent(tag)}`} data-route data-tag={tag}>{tag}</a>
    {/each}
  </div>
{/if}
