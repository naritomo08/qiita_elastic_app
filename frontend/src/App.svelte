<script>
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { BACKEND_CHECK_INTERVAL, BACKENDS } from "./lib/config.js";
  import { availableBackendKeys, backendAvailabilityKnown, notice, selectBackend, selectedBackend } from "./lib/state.js";
  import { refreshBackendAvailability } from "./lib/backend.js";
  import Home from "./routes/Home.svelte";
  import Search from "./routes/Search.svelte";
  import AllArticles from "./routes/AllArticles.svelte";
  import ArticleDetail from "./routes/ArticleDetail.svelte";
  import Health from "./routes/Health.svelte";

  let route = currentRoute();
  let loading = true;
  let error = "";
  let refreshTimer;

  $: availableKeys = [...$availableBackendKeys];
  $: backendOptions = availableKeys.length ? availableKeys : Object.keys(BACKENDS);
  $: backendUnavailable = !$availableBackendKeys.size && route.path !== "/health";

  function currentRoute() {
    return {
      path: location.pathname,
      params: new URLSearchParams(location.search),
    };
  }

  function navigate(href) {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) return;
    history.pushState({}, "", url);
    route = currentRoute();
    error = "";
    window.scrollTo({ top: 0 });
  }

  function onNav(event) {
    const link = event.target.closest("a[data-route]");
    if (!link || link.origin !== location.origin) return;
    event.preventDefault();
    navigate(link.href);
  }

  async function refreshBackends() {
    await refreshBackendAvailability();
  }

  onMount(() => {
    const onPopState = () => {
      route = currentRoute();
      error = "";
      window.scrollTo({ top: 0 });
    };

    const navigation = performance.getEntriesByType("navigation")[0];
    const isReload = navigation ? navigation.type === "reload" : performance.navigation?.type === 1;
    if (isReload && (location.pathname !== "/" || location.search || location.hash)) {
      history.replaceState({}, "", "/");
      route = currentRoute();
    }

    addEventListener("popstate", onPopState);

    refreshBackends().finally(() => {
      loading = false;
    });
    refreshTimer = window.setInterval(refreshBackends, BACKEND_CHECK_INTERVAL);
    return () => {
      removeEventListener("popstate", onPopState);
      window.clearInterval(refreshTimer);
    };
  });

  function changeBackend(event) {
    selectBackend(event.currentTarget.value);
    route = currentRoute();
  }

  function routeProps() {
    if (route.path.startsWith("/articles/")) {
      return { articleId: decodeURIComponent(route.path.slice("/articles/".length)) };
    }
    return {};
  }
</script>

<svelte:window on:click={onNav} />

<header class="site-header">
  <div class="container header-inner">
    <a class="brand" href="/" data-route on:click={onNav}>
      <span class="brand-mark">Q</span>
      <span>
        <strong>Qiita Article Search SvelteVite</strong>
        <small>Powered by Elasticsearch</small>
      </span>
    </a>
    <nav class="header-nav">
      <label class="backend-selector">
        <span>Backend</span>
        <select aria-label="利用するバックエンド" value={$selectedBackend} disabled={!availableKeys.length} on:change={changeBackend}>
          {#if availableKeys.length}
            {#each backendOptions as key}
              <option value={key}>{BACKENDS[key].label}</option>
            {/each}
          {:else}
            <option value="">利用可能なBackendなし</option>
          {/if}
        </select>
      </label>
      <a class="all-articles-link" href="/all" data-route on:click={onNav}>全記事一覧</a>
      <a class="health-link" href="/health" data-route on:click={onNav}>稼働状況</a>
    </nav>
  </div>
</header>

<main class="container" aria-live="polite">
  {#if $notice}
    <div class="alert alert-warning">{$notice}</div>
  {/if}

  {#key `${route.path}?${route.params.toString()}`}
    {#if loading}
      <div class="loading-state">読み込み中…</div>
    {:else if backendUnavailable}
      <section class="error-page">
        <p class="error-code">BACKEND UNAVAILABLE</p>
        <h1>利用できるBackendがありません</h1>
        <p>{$backendAvailabilityKnown ? "稼働状態を15秒ごとに確認しています。Backendが復旧すると自動的に表示を戻します。" : "Backendの稼働状態を確認しています。"}</p>
      </section>
    {:else if error}
      <section class="error-page">
        <p class="error-code">APPLICATION ERROR</p>
        <h1>画面を表示できませんでした</h1>
        <p>{error}</p>
        <a class="button-secondary" href="/" data-route>トップページへ戻る</a>
      </section>
    {:else if route.path === "/health"}
      <Health />
    {:else if route.path.startsWith("/articles/")}
      <ArticleDetail {...routeProps()} on:error={(event) => (error = event.detail)} />
    {:else if route.path === "/all"}
      <AllArticles params={route.params} on:error={(event) => (error = event.detail)} />
    {:else if route.path === "/search"}
      <Search params={route.params} navigate={navigate} on:error={(event) => (error = event.detail)} />
    {:else}
      <Home params={route.params} navigate={navigate} on:error={(event) => (error = event.detail)} />
    {/if}
  {/key}
</main>

<footer class="site-footer">
  <div class="container">Qiita articles × Elasticsearch</div>
</footer>
