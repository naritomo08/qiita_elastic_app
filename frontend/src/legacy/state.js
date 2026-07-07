import { BACKENDS } from "./config.js";

let selectedBackend = localStorage.getItem("qiita-search-backend");
if (!BACKENDS[selectedBackend]) selectedBackend = "python";

export const app = document.querySelector("#legacy-app");
export const backendSelect = document.querySelector("#backend-select");
export const state = {
  selectedBackend,
  availableBackendKeys: new Set(Object.keys(BACKENDS)),
  backendAvailabilityKnown: false,
};

export function selectBackend(key) {
  state.selectedBackend = key;
  localStorage.setItem("qiita-search-backend", key);
}
