import { BACKENDS } from "./config.js";
import { app, backendSelect, selectBackend, state } from "./state.js";
import { escapeHtml, healthPath } from "./common.js";
import { fetchWithTimeout } from "./components/health-status.js";

export async function checkBackendHealth(key) {
  const startedAt = performance.now();
  try {
    const response = await fetchWithTimeout(healthPath(key), 3500);
    const payload = await response.json();
    if (!response.ok || payload.status !== "ok") throw new Error();
    return { ok: true, latency: Math.round(performance.now() - startedAt) };
  } catch {
    return { ok: false, latency: Math.round(performance.now() - startedAt) };
  }
}

export async function refreshBackendAvailability({ renderRoute, renderBackendUnavailable } = {}) {
  const hadAvailableBackends = state.availableBackendKeys.size > 0;
  const results = await Promise.all(
    Object.keys(BACKENDS).map(async (key) => [key, await checkBackendAvailability(key)])
  );
  const healthyKeys = results.filter(([, result]) => result.ok).map(([key]) => key);
  state.availableBackendKeys = new Set(healthyKeys);
  state.backendAvailabilityKnown = true;

  const previousBackend = state.selectedBackend;
  if (!state.availableBackendKeys.has(state.selectedBackend) && healthyKeys.length) {
    selectBackend(healthyKeys[0]);
  }
  updateBackendSelector();

  if (
    app.dataset.ready === "true" &&
    (previousBackend !== state.selectedBackend || (!hadAvailableBackends && healthyKeys.length))
  ) {
    if (previousBackend !== state.selectedBackend) {
      showBackendSwitchNotice(previousBackend, state.selectedBackend);
    }
    await renderRoute?.();
  } else if (!healthyKeys.length && app.dataset.ready === "true" && location.pathname !== "/health") {
    renderBackendUnavailable?.();
  }
}

async function checkBackendAvailability(key) {
  try {
    const response = await fetchWithTimeout(healthPath(key, "/elasticsearch"), 3500);
    const payload = await response.json();
    return { ok: response.ok && payload.status === "ok" };
  } catch {
    return { ok: false };
  }
}

function updateBackendSelector() {
  const keys = Object.keys(BACKENDS).filter((key) => state.availableBackendKeys.has(key));
  if (!keys.length) {
    backendSelect.innerHTML = `<option value="">利用可能なBackendなし</option>`;
    backendSelect.disabled = true;
    return;
  }

  backendSelect.disabled = false;
  backendSelect.innerHTML = keys
    .map((key) => `<option value="${key}">${escapeHtml(BACKENDS[key].label)}</option>`)
    .join("");
  backendSelect.value = state.selectedBackend;
}

function showBackendSwitchNotice(previousBackend, nextBackend) {
  const previousLabel = BACKENDS[previousBackend]?.label || previousBackend;
  const nextLabel = BACKENDS[nextBackend]?.label || nextBackend;
  sessionStorage.setItem(
    "qiita-backend-notice",
    `${previousLabel} Backendが利用できないため、${nextLabel}へ切り替えました。`
  );
}
