<template>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" data-route>
        <span class="brand-mark">Q</span>
        <span>
          <strong>Qiita Article Search VueVite</strong>
          <small>Powered by Elasticsearch</small>
        </span>
      </a>
      <nav class="header-nav">
        <label class="backend-selector">
          <span>Backend</span>
          <select id="backend-select" aria-label="利用するバックエンド">
            <option value="python">Python</option>
            <option value="elixir">Elixir</option>
            <option value="php">PHP</option>
            <option value="java">Java</option>
            <option value="go">Go</option>
            <option value="ruby">Ruby</option>
          </select>
        </label>
        <a class="all-articles-link" href="/all" data-route>全記事一覧</a>
        <a class="health-link" href="/health" data-route>稼働状況</a>
      </nav>
    </div>
  </header>

  <main id="legacy-app" class="container" aria-live="polite">
    <div class="loading-state">読み込み中...</div>
  </main>

  <footer class="site-footer">
    <div class="container">Qiita articles x Elasticsearch</div>
  </footer>
</template>

<script setup>
import { onMounted } from "vue";

onMounted(async () => {
  await import("./legacy/app.js");
});
</script>
