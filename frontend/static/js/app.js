import { BACKENDS, BACKEND_CHECK_INTERVAL } from "./config.js";
import { app, backendSelect, selectBackend, state } from "./state.js";
import { refreshBackendAvailability } from "./backend.js";
import {
  renderBackendUnavailable,
  renderError,
  showPendingBackendNotice,
} from "./common.js";
import {
  downloadAccessLogCsv,
  renderHealthDashboard,
  stopHealthMonitoring,
  updateAccessLogs,
  updateHealthDashboard,
} from "./pages/health.js";
import {
  renderAllArticles,
  renderDetail,
  renderHome,
  renderSearch,
  stopHomeMonitoring,
  updateHomeArticles,
} from "./pages/articles.js";

let backendRefreshTimer;

marked.setOptions({ gfm: true, breaks: true });

redirectReloadToHome();

window.addEventListener("popstate", renderRoute);
backendSelect.addEventListener("change", async () => {
  if (!BACKENDS[backendSelect.value]) return;
  selectBackend(backendSelect.value);
  app.innerHTML = `<div class="loading-state">${BACKENDS[state.selectedBackend].label}バックエンドへ切り替え中…</div>`;
  await renderRoute();
});

document.addEventListener("click", async (event) => {
  const healthRefreshButton = event.target.closest("[data-health-refresh]");
  if (healthRefreshButton) {
    await updateHealthDashboard();
    return;
  }

  const homeRefreshButton = event.target.closest("[data-home-refresh]");
  if (homeRefreshButton) {
    const tag = new URLSearchParams(location.search).get("tag")?.trim() || "";
    await updateHomeArticles(tag);
    return;
  }

  const accessLogDownloadButton = event.target.closest("[data-access-log-download]");
  if (accessLogDownloadButton) {
    await downloadAccessLogCsv(accessLogDownloadButton);
    return;
  }

  const link = event.target.closest("a[data-route]");
  if (!link || link.origin !== location.origin) return;
  event.preventDefault();

  if (
    location.pathname === "/" &&
    link.pathname === "/" &&
    (link.dataset.tag !== undefined || link.dataset.clearTag !== undefined)
  ) {
    const tag = link.dataset.tag || "";
    history.pushState({}, "", tag ? `/?tag=${encodeURIComponent(tag)}` : "/");
    await updateHomeArticles(tag);
    return;
  }

  history.pushState({}, "", link.href);
  renderRoute();
});

document.addEventListener("submit", async (event) => {
  if (event.target.matches("[data-access-log-form]")) {
    event.preventDefault();
    const date = new FormData(event.target).get("date");
    await updateAccessLogs(date);
    return;
  }
  if (!event.target.matches("[data-search-form]")) return;
  event.preventDefault();
  const query = new FormData(event.target).get("q")?.trim();
  if (!query) return;
  history.pushState({}, "", `/search?q=${encodeURIComponent(query)}`);
  renderRoute();
});

bootstrap();

function redirectReloadToHome() {
  const navigation = performance.getEntriesByType("navigation")[0];
  const isReload = navigation
    ? navigation.type === "reload"
    : performance.navigation?.type === 1;

  if (isReload && (location.pathname !== "/" || location.search || location.hash)) {
    history.replaceState({}, "", "/");
  }
}

async function bootstrap() {
  await refreshBackends();
  await renderRoute();
  backendRefreshTimer = window.setInterval(refreshBackends, BACKEND_CHECK_INTERVAL);
}

async function renderRoute() {
  stopHealthMonitoring();
  stopHomeMonitoring();
  window.scrollTo({ top: 0 });
  const path = location.pathname;
  if (!state.availableBackendKeys.size && path !== "/health") {
    renderBackendUnavailable();
    return;
  }
  try {
    if (path === "/health") {
      await renderHealthDashboard();
    } else if (path.startsWith("/articles/")) {
      await renderDetail(decodeURIComponent(path.slice("/articles/".length)));
    } else if (path === "/all") {
      await renderAllArticles();
    } else if (path === "/search") {
      await renderSearch();
    } else {
      await renderHome();
    }
  } catch (error) {
    renderError(error.message || "画面を表示できませんでした。");
  } finally {
    app.dataset.ready = "true";
    showPendingBackendNotice();
  }
}

function refreshBackends() {
  return refreshBackendAvailability({ renderRoute, renderBackendUnavailable });
}
