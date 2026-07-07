import { get } from "svelte/store";
import { BACKENDS } from "./config.js";
import { availableBackendKeys, backendAvailabilityKnown, notice, selectBackend, selectedBackend } from "./state.js";
import { fetchWithTimeout, healthPath } from "./api.js";

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

export async function refreshBackendAvailability() {
  const results = await Promise.all(Object.keys(BACKENDS).map(async (key) => [key, await checkBackendAvailability(key)]));
  const healthyKeys = results.filter(([, result]) => result.ok).map(([key]) => key);
  const previousBackend = get(selectedBackend);

  availableBackendKeys.set(new Set(healthyKeys));
  backendAvailabilityKnown.set(true);

  if (!healthyKeys.includes(previousBackend) && healthyKeys.length) {
    selectBackend(healthyKeys[0]);
    const previousLabel = BACKENDS[previousBackend]?.label || previousBackend;
    const nextLabel = BACKENDS[healthyKeys[0]]?.label || healthyKeys[0];
    notice.set(`${previousLabel} Backendが利用できないため、${nextLabel}へ切り替えました。`);
  }

  return healthyKeys;
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
