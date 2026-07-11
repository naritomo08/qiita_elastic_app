import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DOMPurify from "dompurify";
import { marked } from "marked";
import "../static/style.css";
import {
  BACKEND_CHECK_INTERVAL,
  BACKENDS,
  HOME_REFRESH_INTERVAL,
} from "./settings.js";
import {
  apiRequest,
  checkBackendAvailability,
  checkBackendHealth,
  checkElasticsearchHealth,
  fetchWithTimeout,
} from "./services.js";
import {
  downloadTextFile,
  enhanceArticleMarkdown,
  formatBytes,
  formatDate,
  formatJst,
  positiveInt,
  safeExternalUrl,
  stripMarkdown,
  todayJstDate,
} from "./utils.js";

marked.setOptions({ gfm: true, breaks: true });

function App() {
  const [locationState, setLocationState] = useState(currentLocation);
  const [selectedBackend, setSelectedBackend] = useState(initialBackend);
  const [availableBackends, setAvailableBackends] = useState(() => new Set(Object.keys(BACKENDS)));
  const [availabilityKnown, setAvailabilityKnown] = useState(false);
  const [notice, setNotice] = useState("");
  const appReady = useRef(false);

  const navigate = useCallback((to, { replace = false } = {}) => {
    const url = new URL(to, window.location.origin);
    if (replace) {
      window.history.replaceState({}, "", url);
    } else {
      window.history.pushState({}, "", url);
    }
    setLocationState(currentLocation());
  }, []);

  const selectBackend = useCallback((key) => {
    if (!BACKENDS[key]) return;
    window.localStorage.setItem("qiita-search-backend", key);
    setSelectedBackend(key);
    setNotice(`${BACKENDS[key].label}バックエンドへ切り替えました。`);
  }, []);

  const refreshBackends = useCallback(async () => {
    const results = await Promise.all(
      Object.keys(BACKENDS).map(async (key) => [key, await checkBackendAvailability(key)])
    );
    const healthyKeys = results.filter(([, result]) => result.ok).map(([key]) => key);
    setAvailableBackends(new Set(healthyKeys));
    setAvailabilityKnown(true);
    setSelectedBackend((current) => {
      if (healthyKeys.includes(current) || !healthyKeys.length) return current;
      const next = healthyKeys[0];
      window.localStorage.setItem("qiita-search-backend", next);
      setNotice(`${BACKENDS[current]?.label || current} Backendが利用できないため、${BACKENDS[next].label}へ切り替えました。`);
      return next;
    });
  }, []);

  useEffect(() => {
    const handlePopState = () => setLocationState(currentLocation());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    refreshBackends();
    const timer = window.setInterval(refreshBackends, BACKEND_CHECK_INTERVAL);
    return () => window.clearInterval(timer);
  }, [refreshBackends]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [locationState.key]);

  const api = useCallback((path, params) => apiRequest(selectedBackend, path, params), [selectedBackend]);
  const healthyBackendKeys = useMemo(() => [...availableBackends], [availableBackends]);
  const backendUnavailable = !healthyBackendKeys.length && locationState.pathname !== "/health";

  return (
    <>
      <Header
        availableBackends={healthyBackendKeys}
        navigate={navigate}
        selectedBackend={selectedBackend}
        selectBackend={selectBackend}
      />
      <main id="app" className="container" aria-live="polite" data-ready={appReady.current ? "true" : "false"}>
        <Notice message={notice} onDismiss={() => setNotice("")} />
        {backendUnavailable ? (
          <BackendUnavailable availabilityKnown={availabilityKnown} />
        ) : (
          <Route
            api={api}
            availableBackends={healthyBackendKeys}
            locationState={locationState}
            navigate={navigate}
            onReady={() => {
              appReady.current = true;
            }}
            selectedBackend={selectedBackend}
            showNotice={setNotice}
          />
        )}
      </main>
      <footer className="site-footer">
        <div className="container">Qiita articles × Elasticsearch</div>
      </footer>
    </>
  );
}

function Header({ availableBackends, navigate, selectedBackend, selectBackend }) {
  const options = availableBackends.length ? availableBackends : [""];
  return (
    <header className="site-header">
      <div className="container header-inner">
        <a className="brand" href="/" onClick={routeClick(navigate)}>
          <span className="brand-mark">Q</span>
          <span>
            <strong>Qiita Article Search ReactVite</strong>
            <small>Powered by Elasticsearch</small>
          </span>
        </a>
        <nav className="header-nav">
          <label className="backend-selector">
            <span>Backend</span>
            <select
              aria-label="利用するバックエンド"
              disabled={!availableBackends.length}
              onChange={(event) => selectBackend(event.target.value)}
              value={availableBackends.length ? selectedBackend : ""}
            >
              {options.map((key) => (
                <option key={key || "empty"} value={key}>
                  {key ? BACKENDS[key].label : "利用可能なBackendなし"}
                </option>
              ))}
            </select>
          </label>
          <a className="all-articles-link" href="/all" onClick={routeClick(navigate)}>全記事一覧</a>
          <a className="health-link" href="/health" onClick={routeClick(navigate)}>稼働状況</a>
        </nav>
      </div>
    </header>
  );
}

function Route(props) {
  const { locationState } = props;
  if (locationState.pathname === "/health") return <HealthPage {...props} />;
  if (locationState.pathname.startsWith("/articles/")) {
    return <ArticleDetail {...props} articleId={decodeURIComponent(locationState.pathname.slice("/articles/".length))} />;
  }
  if (locationState.pathname === "/all") return <AllArticles {...props} />;
  if (locationState.pathname === "/search") return <SearchPage {...props} />;
  return <HomePage {...props} />;
}

function HomePage({ api, locationState, navigate, onReady, showNotice }) {
  const tag = locationState.searchParams.get("tag")?.trim() || "";
  const [state, setState] = useState({ loading: true, error: "", recent: [], total: 0, updatedAt: null });
  const requestId = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    const id = ++requestId.current;
    if (!quiet) setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [recent, articleList] = await Promise.all([
        api("/api/recent", { size: tag ? 50 : 10, tag }),
        api("/api/articles", { page: 1, size: 1 }),
      ]);
      if (id === requestId.current) {
        setState({
          loading: false,
          error: "",
          recent: recent.results || [],
          total: Number(articleList.total) || 0,
          updatedAt: new Date(),
        });
      }
    } catch (error) {
      if (id === requestId.current) {
        setState((current) => ({ ...current, loading: false, error: error.message || "記事を取得できませんでした。" }));
        showNotice(error.message || "記事を取得できませんでした。");
      }
    }
  }, [api, showNotice, tag]);

  useEffect(() => {
    document.title = "Qiita Article Search";
    load();
    const timer = window.setInterval(() => load({ quiet: true }), HOME_REFRESH_INTERVAL);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(onReady, [onReady]);

  if (state.loading) return <LoadingState />;
  if (state.error && !state.recent.length) return <ErrorPage message={state.error} navigate={navigate} />;

  return (
    <>
      <section className="hero">
        <p className="eyebrow">TECH ARTICLE DISCOVERY</p>
        <h1>知りたい技術を、<br />すばやく見つける。</h1>
        <p className="hero-copy">Elasticsearch に登録された Qiita 記事を、タイトル・本文・タグから横断検索できます。</p>
        <div className="article-total" aria-label="現在の記事総数">
          <span>現在の記事総数</span>
          <strong>{state.total.toLocaleString("ja-JP")}<small> 件</small></strong>
        </div>
        <SearchForm navigate={navigate} />
      </section>
      <section className="section" id="home-articles" aria-busy={state.loading ? "true" : "false"}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">{tag ? "TAG FILTER" : "RECENTLY UPDATED"}</p>
            <h2>{tag ? `「${tag}」の記事` : "最近更新された記事"}</h2>
          </div>
          <div className="article-list-controls">
            <span className="article-count">{state.recent.length.toLocaleString()} 件</span>
            {state.updatedAt && <time dateTime={state.updatedAt.toISOString()}>{state.updatedAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 更新</time>}
            <button type="button" onClick={() => load({ quiet: true })} aria-label="記事一覧を更新">
              <span aria-hidden="true">↻</span> 更新
            </button>
          </div>
        </div>
        {tag && (
          <div className="active-filter">
            <span>タグで絞り込み中</span>
            <strong>{tag}</strong>
            <span className="filter-result-count">表示件数 <strong>{state.recent.length.toLocaleString()} 件</strong></span>
            <a href="/" onClick={routeClick(navigate)}>絞り込みを解除 ×</a>
          </div>
        )}
        <ArticleGrid articles={state.recent} navigate={navigate} selectedTag={tag} />
      </section>
    </>
  );
}

function SearchPage({ api, locationState, navigate, onReady, showNotice }) {
  const q = locationState.searchParams.get("q")?.trim() || "";
  const page = positiveInt(locationState.searchParams.get("page"), 1);
  const size = Math.min(positiveInt(locationState.searchParams.get("size"), 10), 100);
  const [state, setState] = useState({ loading: true, error: "", data: null });

  useEffect(() => {
    if (!q) {
      navigate("/", { replace: true });
      showNotice("検索キーワードを入力してください。");
      return;
    }
    document.title = `「${q}」の検索結果 | Qiita Article Search`;
    setState({ loading: true, error: "", data: null });
    api("/api/search", { q, page, size })
      .then((data) => setState({ loading: false, error: "", data }))
      .catch((error) => setState({ loading: false, error: error.message, data: null }));
  }, [api, navigate, page, q, showNotice, size]);

  useEffect(onReady, [onReady]);

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorPage message={state.error} navigate={navigate} />;

  const totalPages = Math.max(1, Math.ceil(Number(state.data.total || 0) / size));
  return (
    <>
      <section className="search-header"><SearchForm navigate={navigate} size={size} value={q} /></section>
      <section className="section search-results">
        <div className="results-summary">
          <div>
            <p className="eyebrow">SEARCH RESULTS</p>
            <h1>{`「${q}」の検索結果`}</h1>
          </div>
          <strong>{Number(state.data.total).toLocaleString()}<small> 件</small></strong>
        </div>
        {state.data.results?.length ? (
          <>
            <div className="result-list">
              {state.data.results.map((article) => <ResultCard article={article} key={article.id} navigate={navigate} />)}
            </div>
            <SearchPagination navigate={navigate} page={page} q={q} size={size} totalPages={totalPages} />
          </>
        ) : <EmptyState title="一致する記事がありませんでした" description="キーワードを短くするか、別の表記で検索してみてください。" />}
      </section>
    </>
  );
}

function AllArticles({ api, locationState, navigate, onReady }) {
  const page = positiveInt(locationState.searchParams.get("page"), 1);
  const size = Math.min(positiveInt(locationState.searchParams.get("size"), 20), 100);
  const [state, setState] = useState({ loading: true, error: "", data: null });

  useEffect(() => {
    document.title = "全記事一覧 | Qiita Article Search";
    setState({ loading: true, error: "", data: null });
    api("/api/articles", { page, size })
      .then((data) => setState({ loading: false, error: "", data }))
      .catch((error) => setState({ loading: false, error: error.message, data: null }));
  }, [api, page, size]);

  useEffect(onReady, [onReady]);

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorPage message={state.error} navigate={navigate} />;

  const totalPages = Math.max(1, Math.ceil(Number(state.data.total || 0) / size));
  return (
    <>
      <section className="all-articles-header">
        <p className="eyebrow">ALL ARTICLES</p>
        <div className="results-summary">
          <div>
            <h1>全記事一覧</h1>
            <p className="all-articles-copy">Elasticsearchに登録されている記事を作成日順で表示しています。</p>
          </div>
          <strong>{Number(state.data.total).toLocaleString()}<small> 件</small></strong>
        </div>
      </section>
      <section className="section">
        {state.data.results?.length ? (
          <>
            <div className="article-grid">
              {state.data.results.map((article) => <ArticleCard article={article} dateField="created" key={article.id} navigate={navigate} />)}
            </div>
            <AllArticlesPagination navigate={navigate} page={page} size={size} totalPages={totalPages} />
          </>
        ) : <EmptyState title="記事はまだありません" description="Elasticsearchインデックスに記事を投入すると、ここに表示されます。" />}
      </section>
    </>
  );
}

function ArticleDetail({ api, articleId, navigate, onReady, showNotice }) {
  const [state, setState] = useState({ loading: true, error: "", article: null });
  const bodyRef = useRef(null);
  const treeRef = useRef(null);

  useEffect(() => {
    document.title = "記事を読み込み中 | Qiita Article Search";
    setState({ loading: true, error: "", article: null });
    api(`/api/articles/${encodeURIComponent(articleId)}`)
      .then((article) => {
        document.title = `${article.title || "無題の記事"} | Qiita Article Search`;
        setState({ loading: false, error: "", article });
      })
      .catch((error) => setState({ loading: false, error: error.message, article: null }));
  }, [api, articleId]);

  useEffect(onReady, [onReady]);

  useEffect(() => {
    if (!state.article || !bodyRef.current) return;
    enhanceArticleMarkdown(bodyRef.current, treeRef.current, api).catch(() => {
      showNotice("記事内の追加表示を一部読み込めませんでした。");
    });
  }, [api, showNotice, state.article]);

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorPage message={state.error} navigate={navigate} />;

  const article = state.article;
  const markdownHtml = DOMPurify.sanitize(marked.parse(removeDangerousBlocks(article.body || "本文がありません。")), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel", "class"],
  });

  return (
    <article className="article-detail">
      <a className="back-link" href="/" onClick={routeClick(navigate)}>← 記事一覧へ戻る</a>
      <div className="article-detail-layout">
        <main className="article-detail-main">
          <header className="detail-header">
            <p className="eyebrow">QIITA ARTICLE</p>
            <h1>{article.title || "無題の記事"}</h1>
            <Tags navigate={navigate} tags={article.tags} large />
            <dl className="article-dates">
              <div><dt>作成</dt><dd>{formatDate(article.created_at)}</dd></div>
              <div><dt>更新</dt><dd>{formatDate(article.updated_at)}</dd></div>
            </dl>
            <div className="detail-actions">
              <button className="markdown-download-button" type="button" onClick={() => downloadMarkdown(article)}>Markdownをダウンロード ↓</button>
              {article.url && <a className="original-link" href={safeExternalUrl(article.url)} target="_blank" rel="noopener noreferrer">Qiita で元記事を読む ↗</a>}
            </div>
          </header>
          <div className="article-body markdown-body" dangerouslySetInnerHTML={{ __html: markdownHtml }} ref={bodyRef} />
        </main>
        <aside className="article-tree" aria-label="記事の目次">
          <nav ref={treeRef}></nav>
        </aside>
      </div>
    </article>
  );
}

function HealthPage({ availableBackends, onReady, selectedBackend }) {
  const [state, setState] = useState(() => ({
    accessDate: todayJstDate(),
    accessLogs: { ok: false, logs: [], loading: true },
    backends: Object.fromEntries(Object.keys(BACKENDS).map((key) => [key, { checking: true }])),
    containers: new Map(),
    elasticsearch: { checking: true },
    metricsAvailable: false,
    updatedAt: null,
    updating: false,
  }));

  const update = useCallback(async (date = state.accessDate) => {
    setState((current) => ({ ...current, updating: true }));
    const [backendResults, containerMetrics, accessLogs] = await Promise.all([
      Promise.all(Object.keys(BACKENDS).map(async (key) => [key, await checkBackendHealth(key)])),
      checkContainerMetrics(),
      checkAccessLogs(date),
    ]);
    const healthyKeys = backendResults.filter(([, result]) => result.ok).map(([key]) => key);
    const elasticsearch = await checkElasticsearchHealth(healthyKeys, selectedBackend || availableBackends[0]);
    setState((current) => ({
      ...current,
      accessDate: date,
      accessLogs,
      backends: Object.fromEntries(backendResults),
      containers: containerMetrics.metrics,
      elasticsearch,
      metricsAvailable: containerMetrics.available,
      updatedAt: new Date(),
      updating: false,
    }));
  }, [availableBackends, selectedBackend, state.accessDate]);

  useEffect(() => {
    document.title = "稼働状況 | Qiita Article Search";
    update();
    const timer = window.setInterval(() => update(), 5000);
    return () => window.clearInterval(timer);
  }, [update]);

  useEffect(onReady, [onReady]);

  const healthyCount = Object.values(state.backends).filter((result) => result.ok).length;
  const allHealthy = healthyCount === Object.keys(BACKENDS).length && state.elasticsearch.ok;

  return (
    <section className="health-page">
      <div className="health-page-header">
        <div>
          <p className="eyebrow">SYSTEM HEALTH</p>
          <h1>稼働状況</h1>
          <p>frontendのNginx経由で、各バックエンドとElasticsearchの状態を確認しています。</p>
        </div>
        <button className={`health-refresh-button${state.updating ? " is-refreshing" : ""}`} type="button" onClick={() => update()} disabled={state.updating}>
          <span aria-hidden="true">↻</span> 今すぐ更新
        </button>
      </div>
      <div className="health-summary" aria-live="polite">
        <span className={`health-summary-dot ${state.updatedAt ? (allHealthy ? "is-healthy" : "is-unhealthy") : "is-checking"}`}></span>
        <strong>{allHealthy ? "すべてのサービスが正常です" : `バックエンド ${healthyCount}/${Object.keys(BACKENDS).length} 稼働・Elasticsearch ${state.elasticsearch.ok ? "正常" : "接続不可"}`}</strong>
        {state.updatedAt && <time dateTime={state.updatedAt.toISOString()}>最終更新 {state.updatedAt.toLocaleTimeString("ja-JP")}</time>}
      </div>
      <HealthSection eyebrow="FRONTEND" title="フロントエンドコンテナ">
        <div className="health-grid health-grid-elasticsearch">
          <ContainerHealthCard icon="F" label="Frontend" metrics={state.containers.get("frontend")} metricsAvailable={state.metricsAvailable} />
        </div>
      </HealthSection>
      <HealthSection eyebrow="BACKENDS" title="バックエンドコンテナ" note="5秒ごとに自動更新">
        <div className="health-grid">
          {Object.entries(BACKENDS).map(([key, backend]) => (
            <BackendHealthCard key={key} backend={backend} metrics={state.containers.get(`backend_${key}`)} result={state.backends[key]} />
          ))}
        </div>
      </HealthSection>
      <HealthSection eyebrow="DATA STORE" title="Elasticsearch">
        <div className="health-grid health-grid-elasticsearch">
          <ElasticsearchHealthCard result={state.elasticsearch} />
        </div>
      </HealthSection>
      <AccessLogSection
        accessDate={state.accessDate}
        logs={state.accessLogs}
        onDateChange={(date) => update(date)}
      />
    </section>
  );
}

function ArticleGrid({ articles, navigate, selectedTag }) {
  if (!articles.length) {
    return selectedTag
      ? <EmptyState title={`「${selectedTag}」の記事は見つかりませんでした`} description={<a href="/" onClick={routeClick(navigate)}>絞り込みを解除して記事一覧へ戻る</a>} />
      : <EmptyState title="記事はまだありません" description="Elasticsearch インデックスに記事を投入すると、ここに表示されます。" />;
  }
  return (
    <div className="article-grid">
      {articles.map((article) => <ArticleCard article={article} dateField={selectedTag ? "created" : "updated"} key={article.id} navigate={navigate} />)}
    </div>
  );
}

function ArticleCard({ article, dateField = "updated", navigate }) {
  const dateLabel = dateField === "created" ? "作成" : "更新";
  const dateValue = dateField === "created" ? article.created_at : article.updated_at;
  return (
    <article className="article-card">
      <div className="card-meta"><time>{dateLabel} {formatDate(dateValue)}</time></div>
      <h3><a href={`/articles/${encodeURIComponent(article.id)}`} target="_blank" rel="noopener noreferrer">{article.title || "無題の記事"}</a></h3>
      <Tags navigate={navigate} tags={article.tags} />
      <p className="excerpt">{stripMarkdown(article.body || "").slice(0, 180)}{(article.body || "").length > 180 ? "…" : ""}</p>
      <div className="card-actions">
        <a className="card-link" href={`/articles/${encodeURIComponent(article.id)}`} target="_blank" rel="noopener noreferrer">記事を読む <span>→</span></a>
        {article.url && <a className="card-link external" href={safeExternalUrl(article.url)} target="_blank" rel="noopener noreferrer">Qiitaで読む <span>↗</span></a>}
      </div>
    </article>
  );
}

function ResultCard({ article, navigate }) {
  const highlightedTitle = article.highlight?.title?.[0] || article.title || "無題の記事";
  const fragments = article.highlight?.body?.length ? article.highlight.body : [stripMarkdown(article.body || "").slice(0, 240)];
  return (
    <article className="result-card">
      <div className="card-meta">
        <time>更新 {formatDate(article.updated_at)}</time>
        {article._score != null && <span>score {Number(article._score).toFixed(2)}</span>}
      </div>
      <h2><a href={`/articles/${encodeURIComponent(article.id)}`} target="_blank" rel="noopener noreferrer" dangerouslySetInnerHTML={{ __html: sanitizeHighlight(highlightedTitle) }} /></h2>
      <Tags navigate={navigate} tags={article.tags} />
      <div className="highlights">
        {fragments.map((item, index) => <p dangerouslySetInnerHTML={{ __html: `${sanitizeHighlight(item)}${article.highlight?.body?.length ? "…" : ""}` }} key={index} />)}
      </div>
      <div className="card-actions">
        <a className="card-link" href={`/articles/${encodeURIComponent(article.id)}`} target="_blank" rel="noopener noreferrer">詳細を見る <span>→</span></a>
        {article.url && <a className="card-link external" href={safeExternalUrl(article.url)} target="_blank" rel="noopener noreferrer">Qiitaで読む <span>↗</span></a>}
      </div>
    </article>
  );
}

function Tags({ large = false, navigate, tags }) {
  if (!Array.isArray(tags) || !tags.length) return null;
  return (
    <div className={`tags${large ? " large" : ""}`}>
      {tags.map((tag) => (
        <a className="tag" href={`/?tag=${encodeURIComponent(tag)}`} key={tag} onClick={routeClick(navigate)}>{tag}</a>
      ))}
    </div>
  );
}

function SearchForm({ navigate, size = 10, value = "" }) {
  const [query, setQuery] = useState(value);
  useEffect(() => setQuery(value), [value]);
  return (
    <form className={`search-form${value ? " compact" : ""}`} onSubmit={(event) => {
      event.preventDefault();
      const q = query.trim();
      if (!q) return;
      navigate(`/search?${new URLSearchParams({ q, size })}`);
    }}>
      <label className="sr-only" htmlFor="q">検索キーワード</label>
      <div className="search-box">
        <span className="search-icon" aria-hidden="true"></span>
        <input id="q" name="q" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例: Elasticsearch, Python, Docker" required />
        <input type="hidden" name="size" value={size} />
        <button type="submit">検索</button>
      </div>
    </form>
  );
}

function SearchPagination({ navigate, page, q, size, totalPages }) {
  if (totalPages <= 1) return null;
  const href = (target) => `/search?${new URLSearchParams({ q, page: target, size })}`;
  return <Pagination href={href} navigate={navigate} page={page} totalPages={totalPages} />;
}

function AllArticlesPagination({ navigate, page, size, totalPages }) {
  if (totalPages <= 1) return null;
  const href = (target) => `/all?${new URLSearchParams({ page: target, size })}`;
  return <Pagination href={href} navigate={navigate} page={page} totalPages={totalPages} />;
}

function Pagination({ href, navigate, page, totalPages }) {
  return (
    <nav className="pagination">
      {page > 1 ? <a href={href(page - 1)} onClick={routeClick(navigate)}>← 前へ</a> : <span className="disabled">← 前へ</span>}
      <span>{page} / {totalPages}</span>
      {page < totalPages ? <a href={href(page + 1)} onClick={routeClick(navigate)}>次へ →</a> : <span className="disabled">次へ →</span>}
    </nav>
  );
}

function HealthSection({ children, eyebrow, note, title }) {
  return (
    <section className="health-section">
      <div className="health-section-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        {note && <span>{note}</span>}
      </div>
      {children}
    </section>
  );
}

function BackendHealthCard({ backend, metrics, result = {} }) {
  const healthy = result.ok;
  return (
    <article className={`health-card ${result.checking ? "is-checking" : healthy ? "is-healthy" : "is-unhealthy"}`}>
      <div className="health-card-top">
        <span className="health-service-icon" aria-hidden="true">{backend.label.slice(0, 1)}</span>
        <span className="health-badge">{result.checking ? "確認中" : healthy ? "稼働中" : "停止"}</span>
      </div>
      <h3>{backend.label}</h3>
      <p className="health-message">{healthy ? "Nginx経由で正常に応答しています。" : "応答がありません。コンテナの状態を確認してください。"}</p>
      <dl className="health-details">
        <div><dt>応答時間</dt><dd>{healthy ? `${result.latency} ms` : "タイムアウト"}</dd></div>
        <ContainerUsage metrics={metrics} />
      </dl>
    </article>
  );
}

function ContainerHealthCard({ icon, label, metrics, metricsAvailable }) {
  const healthy = Boolean(metrics);
  return (
    <article className={`health-card ${healthy ? "is-healthy" : "is-unhealthy"}`}>
      <div className="health-card-top">
        <span className="health-service-icon" aria-hidden="true">{icon}</span>
        <span className="health-badge">{healthy ? "稼働中" : "取得不可"}</span>
      </div>
      <h3>{label}</h3>
      <p className="health-message">{healthy ? "この画面を配信しているフロントエンドコンテナです。" : metricsAvailable ? "フロントエンドのコンテナ情報が見つかりません。" : "コンテナ統計APIへ接続できません。"}</p>
      <dl className="health-details"><ContainerUsage metrics={metrics} /></dl>
    </article>
  );
}

function ContainerUsage({ metrics }) {
  return (
    <>
      <div><dt>CPU</dt><dd>{metrics ? `${Number(metrics.cpu_percent).toFixed(2)} %` : "取得不可"}</dd></div>
      <div><dt>メモリ</dt><dd>{metrics ? `${formatBytes(metrics.memory_usage_bytes)} / ${formatBytes(metrics.memory_limit_bytes)} (${Number(metrics.memory_percent).toFixed(1)} %)` : "取得不可"}</dd></div>
    </>
  );
}

function ElasticsearchHealthCard({ result }) {
  return (
    <article className={`health-card ${result.checking ? "is-checking" : result.ok ? "is-healthy" : "is-unhealthy"}`}>
      <div className="health-card-top">
        <span className="health-service-icon elasticsearch-icon" aria-hidden="true">E</span>
        <span className="health-badge">{result.checking ? "確認中" : result.ok ? "稼働中" : "接続不可"}</span>
      </div>
      <h3>Elasticsearch</h3>
      <p className="health-message">{result.ok ? `${result.clusterName || "Elasticsearchクラスター"}へ正常に接続できています。` : result.unavailable ? "確認に利用できるバックエンドがありません。" : "バックエンドからElasticsearchへ接続できません。"}</p>
      <dl className="health-details">
        <div><dt>接続経路</dt><dd>{result.checkedBy ? BACKENDS[result.checkedBy].label : "—"}</dd></div>
        <div><dt>応答時間</dt><dd>{result.ok && Number.isFinite(Number(result.latency)) ? `${result.latency} ms` : "—"}</dd></div>
        <div><dt>バージョン</dt><dd>{result.version || "—"}</dd></div>
      </dl>
    </article>
  );
}

function AccessLogSection({ accessDate, logs, onDateChange }) {
  const [inputDate, setInputDate] = useState(accessDate);
  useEffect(() => setInputDate(accessDate), [accessDate]);
  const entries = logs.logs || [];
  return (
    <section className="health-section">
      <div className="health-section-heading">
        <div>
          <p className="eyebrow">OBSERVABILITY</p>
          <h2>アクセスログ</h2>
          <p className="health-section-description">監視リクエストと静的ファイルを除いた、実際のブラウザ操作を表示します。</p>
        </div>
        <form className="access-log-controls" onSubmit={(event) => {
          event.preventDefault();
          onDateChange(inputDate);
        }}>
          <label>
            <span>対象日</span>
            <input type="date" name="date" value={inputDate} max={todayJstDate()} onChange={(event) => setInputDate(event.target.value)} />
          </label>
          <button className="button-secondary" type="submit">表示</button>
          <button className="button-secondary" type="button" disabled={!entries.length} onClick={() => downloadAccessLogCsv(accessDate)}>CSVダウンロード</button>
        </form>
      </div>
      <div className="access-log-summary">{logs.loading ? "読込中…" : logs.ok ? `${logs.date || accessDate} / ${entries.length}件（直近200件まで）` : "取得失敗"}</div>
      <div className="access-log-table-wrap">
        <table className="access-log-table">
          <thead>
            <tr><th>時刻</th><th>接続元</th><th>Method</th><th>URI</th><th>Status</th><th>応答時間</th></tr>
          </thead>
          <tbody>
            {!logs.ok ? (
              <tr><td colSpan="6">ログを取得できませんでした。</td></tr>
            ) : entries.length ? [...entries].reverse().map((entry, index) => <AccessLogRow entry={entry} key={`${entry["@timestamp"]}-${index}`} />) : (
              <tr><td colSpan="6">{logs.date || accessDate} のアクセスログはありません。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AccessLogRow({ entry }) {
  const status = Number(entry.status);
  const time = entry["@timestamp"] ? formatJst(entry["@timestamp"]).replace(" JST", "") : "—";
  const uri = entry.uri || "—";
  return (
    <tr>
      <td>{time}</td>
      <td>{entry.remote_addr || "—"}</td>
      <td>{entry.method || "—"}</td>
      <td className="access-log-uri" title={uri}>{uri}</td>
      <td className={status >= 400 ? "is-error" : ""}>{entry.status ?? "—"}</td>
      <td>{entry.request_time ?? "—"} s</td>
    </tr>
  );
}

function BackendUnavailable({ availabilityKnown }) {
  document.title = "Backend停止中 | Qiita Article Search";
  return (
    <section className="error-page">
      <p className="error-code">BACKEND UNAVAILABLE</p>
      <h1>利用できるBackendがありません</h1>
      <p>{availabilityKnown ? "稼働状態を15秒ごとに確認しています。Backendが復旧すると自動的に表示を戻します。" : "Backendの稼働状態を確認しています。"}</p>
    </section>
  );
}

function ErrorPage({ message, navigate }) {
  return (
    <section className="error-page">
      <p className="error-code">APPLICATION ERROR</p>
      <h1>画面を表示できませんでした</h1>
      <p>{message}</p>
      <a className="button-secondary" href="/" onClick={routeClick(navigate)}>トップページへ戻る</a>
    </section>
  );
}

function EmptyState({ description, title }) {
  return <div className="empty-state"><h3>{title}</h3><p>{description}</p></div>;
}

function LoadingState() {
  return <div className="loading-state">読み込み中…</div>;
}

function Notice({ message, onDismiss }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(onDismiss, 4500);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);
  return message ? <div className="alert alert-warning">{message}</div> : null;
}

function routeClick(navigate) {
  return (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const href = event.currentTarget.getAttribute("href");
    if (!href || href.startsWith("http")) return;
    event.preventDefault();
    navigate(href);
  };
}

async function checkContainerMetrics() {
  try {
    const response = await fetchWithTimeout("/api/container-metrics", 8000);
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();
    return {
      available: true,
      metrics: new Map(payload.containers.map((container) => [container.service, container])),
    };
  } catch {
    return { available: false, metrics: new Map() };
  }
}

async function checkAccessLogs(date) {
  try {
    const params = new URLSearchParams({ date, tail: "200" });
    const response = await fetchWithTimeout(`/api/access-logs?${params}`, 8000);
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();
    return { ok: true, requestedDate: date, date: payload.date, logs: payload.logs || [] };
  } catch {
    return { ok: false, requestedDate: date, date: "", logs: [] };
  }
}

async function downloadAccessLogCsv(accessDate) {
  const response = await fetchWithTimeout(`/api/access-logs?date=${encodeURIComponent(accessDate)}&full=1`, 20000);
  const payload = await response.json();
  if (!response.ok || payload.status !== "ok" || !payload.logs.length) return;
  const columns = [
    ["時刻", (entry) => formatJst(entry["@timestamp"])],
    ["アクセス元IP", (entry) => entry.remote_addr ?? ""],
    ["メソッド", (entry) => entry.method ?? ""],
    ["URI", (entry) => entry.uri ?? ""],
    ["ステータス", (entry) => entry.status ?? ""],
    ["送信バイト数", (entry) => entry.body_bytes_sent ?? ""],
    ["応答時間(秒)", (entry) => entry.request_time ?? ""],
    ["振り先", (entry) => entry.upstream_addr ?? ""],
    ["User-Agent", (entry) => entry.user_agent ?? ""],
  ];
  const header = columns.map(([name]) => csvEscape(name)).join(",");
  const rows = payload.logs.map((entry) => columns.map(([, getValue]) => csvEscape(getValue(entry))).join(","));
  downloadTextFile(`access-logs-${payload.date || todayJstDate()}.csv`, `\uFEFF${[header, ...rows].join("\r\n")}\r\n`, "text/csv;charset=utf-8;");
}

function downloadMarkdown(article) {
  const fallback = `article-${String(article.id ?? "download")}`;
  const filename = String(article.title || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100) || fallback;
  downloadTextFile(`${filename}.md`, String(article.body ?? ""), "text/markdown;charset=utf-8");
}

function currentLocation() {
  return {
    key: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    pathname: window.location.pathname,
    searchParams: new URLSearchParams(window.location.search),
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function initialBackend() {
  const key = window.localStorage.getItem("qiita-search-backend");
  return BACKENDS[key] ? key : "python";
}

function removeDangerousBlocks(value) {
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}

function sanitizeHighlight(value) {
  const escaped = DOMPurify.sanitize(String(value || ""));
  return escaped.replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
}

createRoot(document.getElementById("root")).render(<App />);
