import { writable } from "svelte/store";
import { BACKENDS } from "./config.js";

let initialBackend = localStorage.getItem("qiita-search-backend");
if (!BACKENDS[initialBackend]) initialBackend = "python";

export const selectedBackend = writable(initialBackend);
export const availableBackendKeys = writable(new Set(Object.keys(BACKENDS)));
export const backendAvailabilityKnown = writable(false);
export const notice = writable("");

export function selectBackend(key) {
  if (!BACKENDS[key]) return;
  localStorage.setItem("qiita-search-backend", key);
  selectedBackend.set(key);
}

export function showNotice(message) {
  notice.set(message);
}
