import http from "k6/http";
import { check, sleep } from "k6";

const targetUrl = (__ENV.TARGET_URL || "").replace(/\/+$/, "");
const scenario = (__ENV.SCENARIO || "mixed").toLowerCase();
const query = __ENV.SEARCH_QUERY || "Elasticsearch";
const sleepSeconds = numberEnv("SLEEP_SECONDS", 0.2);

if (!targetUrl) {
  throw new Error("TARGET_URL is required");
}

export const options = buildOptions();

export default function () {
  const path = selectPath();
  const response = http.get(`${targetUrl}${path}`, {
    tags: { endpoint: path.split("?")[0] },
    timeout: __ENV.REQUEST_TIMEOUT || "10s",
  });

  check(response, {
    "HTTP status is 200": (result) => result.status === 200,
    "response is JSON": (result) =>
      (result.headers["Content-Type"] || "").includes("application/json"),
  });

  if (sleepSeconds > 0) sleep(sleepSeconds);
}

function selectPath() {
  const encodedQuery = encodeURIComponent(query);
  if (scenario === "search") {
    return `/api/search?q=${encodedQuery}&page=1&size=10`;
  }
  if (scenario === "articles") {
    return "/api/articles?page=1&size=20";
  }
  if (scenario === "recent") {
    return "/api/recent?size=10";
  }

  const choice = Math.random();
  if (choice < 0.6) {
    return `/api/search?q=${encodedQuery}&page=1&size=10`;
  }
  if (choice < 0.85) {
    return "/api/articles?page=1&size=20";
  }
  return "/api/recent?size=10";
}

function buildOptions() {
  const common = {
    thresholds: {
      http_req_failed: [`rate<${__ENV.MAX_ERROR_RATE || "0.01"}`],
      http_req_duration: [`p(95)<${__ENV.P95_LIMIT_MS || "1000"}`],
    },
    summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  };
  const stages = parseStages(__ENV.STAGES);
  if (stages.length > 0) return { ...common, stages };

  return {
    ...common,
    vus: integerEnv("VUS", 20),
    duration: __ENV.DURATION || "1m",
  };
}

function parseStages(value) {
  if (!value) return [];
  return value.split(",").map((stage) => {
    const [duration, target] = stage.trim().split(":");
    if (!duration || target === undefined || Number.isNaN(Number(target))) {
      throw new Error(`Invalid STAGES value: ${value}`);
    }
    return { duration, target: Number(target) };
  });
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(__ENV[name] || `${fallback}`, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function numberEnv(name, fallback) {
  const value = Number(__ENV[name] || `${fallback}`);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be zero or greater`);
  }
  return value;
}
