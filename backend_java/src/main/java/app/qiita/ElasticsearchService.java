package app.qiita;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ElasticsearchService {
    private static final ObjectMapper JSON = new ObjectMapper();

    private final String esUrl;
    private final String index;
    private final HttpClient client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3))
        .build();

    ElasticsearchService(String esUrl, String index) {
        this.esUrl = esUrl;
        this.index = index;
    }

    HealthCheck health() {
        long startedAt = System.nanoTime();
        try {
            Response response = requestJson("GET", esUrl, null, client);
            long latency = Math.round((System.nanoTime() - startedAt) / 1_000_000.0);
            if (response.status != 200) {
                return unavailable(startedAt);
            }
            String clusterName = String.valueOf(response.body.getOrDefault("cluster_name", ""));
            String version = "";
            if (response.body.get("version") instanceof Map<?, ?> versionMap) {
                Object number = versionMap.get("number");
                version = number == null ? "" : String.valueOf(number);
            }
            return new HealthCheck(200, Map.of(
                "status", "ok", "service", "elasticsearch", "checked_by", "java",
                "latency_ms", latency, "cluster_name", clusterName, "version", version
            ));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return unavailable(startedAt);
        } catch (IOException error) {
            return unavailable(startedAt);
        }
    }

    private static HealthCheck unavailable(long startedAt) {
        long latency = Math.round((System.nanoTime() - startedAt) / 1_000_000.0);
        return new HealthCheck(503, Map.of(
            "status", "error", "service", "elasticsearch", "checked_by", "java",
            "latency_ms", latency, "error", "Elasticsearch に接続できませんでした。"
        ));
    }

    Map<String, Object> recent(int size, String tag) throws Exception {
        Map<String, Object> query = tag.isEmpty()
            ? Map.of("match_all", Map.of())
            : Map.of("bool", Map.of(
                "should", List.of(
                    Map.of("term", Map.of("tags.keyword", tag)),
                    Map.of("match_phrase", Map.of("tags", tag))
                ),
                "minimum_should_match", 1
            ));
        String sortField = tag.isEmpty() ? "updated_at" : "created_at";
        Map<String, Object> response = esSearch(Map.of(
            "query", query,
            "sort", List.of(Map.of(sortField, Map.of("order", "desc", "unmapped_type", "date"))),
            "size", size
        ));
        Hits hits = parseHits(response);
        return Map.of("total", hits.results.size(), "results", hits.results);
    }

    Map<String, Object> search(String text, int page, int size) throws Exception {
        Map<String, Object> response = esSearch(Map.of(
            "query", Map.of("multi_match", Map.of(
                "query", text,
                "fields", List.of("title^3", "body", "tags^2")
            )),
            "highlight", Map.of(
                "pre_tags", List.of("<mark>"),
                "post_tags", List.of("</mark>"),
                "fields", Map.of(
                    "title", Map.of(),
                    "body", Map.of("fragment_size", 160, "number_of_fragments", 3)
                )
            ),
            "from", (page - 1) * size,
            "size", size
        ));
        return hitsResponse(response, page, size);
    }

    Map<String, Object> articles(int page, int size) throws Exception {
        Map<String, Object> response = esSearch(Map.of(
            "query", Map.of("match_all", Map.of()),
            "sort", List.of(Map.of("created_at", Map.of("order", "desc", "unmapped_type", "date"))),
            "from", (page - 1) * size,
            "size", size
        ));
        return hitsResponse(response, page, size);
    }

    private Map<String, Object> hitsResponse(Map<String, Object> response, int page, int size) {
        Hits hits = parseHits(response);
        return Map.of(
            "total", hits.total,
            "page", page,
            "size", size,
            "results", hits.results
        );
    }

    Map<String, Object> article(String id) throws Exception {
        Response response;
        try {
            response = requestJson(
                "GET",
                esUrl + "/" + escape(index) + "/_doc/" + escape(id),
                null,
                client
            );
        } catch (IOException error) {
            throw new ApiException(503, "Elasticsearch に接続できませんでした。接続先を確認してください。");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ApiException(503, "Elasticsearch に接続できませんでした。接続先を確認してください。");
        }
        if (response.status == 404) {
            String message = "index_not_found_exception".equals(errorType(response.body))
                ? "Elasticsearch インデックス「" + index + "」が見つかりません。"
                : "指定された記事は見つかりませんでした。";
            throw new ApiException(404, message);
        }
        if (response.status != 200) {
            throw new ApiException(mapEsStatus(response.status), "Elasticsearch から記事を取得できませんでした。");
        }
        Object sourceValue = response.body.get("_source");
        if (!(sourceValue instanceof Map<?, ?> rawSource)) {
            throw new ApiException(502, "Elasticsearch から想定外の記事データが返されました。");
        }
        Map<String, Object> source = stringMap(rawSource);
        source.put("id", response.body.get("_id"));
        return source;
    }

    private Map<String, Object> esSearch(Map<String, Object> body) throws Exception {
        Response response;
        try {
            response = requestJson("POST", esUrl + "/" + escape(index) + "/_search", body, client);
        } catch (IOException error) {
            throw new ApiException(503, "Elasticsearch に接続できませんでした。接続先を確認してください。");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ApiException(503, "Elasticsearch に接続できませんでした。接続先を確認してください。");
        }
        if (response.status == 404 && "index_not_found_exception".equals(errorType(response.body))) {
            throw new ApiException(404, "Elasticsearch インデックス「" + index + "」が見つかりません。");
        }
        if (response.status != 200) {
            throw new ApiException(mapEsStatus(response.status), "Elasticsearch で検索を実行できませんでした。");
        }
        return response.body;
    }

    private Hits parseHits(Map<String, Object> response) {
        Object hitsValue = response.get("hits");
        if (!(hitsValue instanceof Map<?, ?> rawHits)) {
            throw new ApiException(502, "Elasticsearch から想定外の検索結果が返されました。");
        }
        Map<String, Object> hits = stringMap(rawHits);
        int total;
        if (hits.get("total") instanceof Map<?, ?> totalMap) {
            Object totalValue = totalMap.get("value");
            if (!(totalValue instanceof Number number)) {
                throw new ApiException(502, "Elasticsearch から想定外の検索結果が返されました。");
            }
            total = number.intValue();
        } else if (hits.get("total") instanceof Number number) {
            total = number.intValue();
        } else {
            throw new ApiException(502, "Elasticsearch から想定外の検索結果が返されました。");
        }
        if (!(hits.get("hits") instanceof List<?> rawResults)) {
            throw new ApiException(502, "Elasticsearch から想定外の検索結果が返されました。");
        }
        List<Map<String, Object>> results = new ArrayList<>();
        for (Object item : rawResults) {
            if (!(item instanceof Map<?, ?> rawHit)) {
                throw new ApiException(502, "Elasticsearch から想定外の検索結果が返されました。");
            }
            Map<String, Object> hit = stringMap(rawHit);
            if (!(hit.get("_source") instanceof Map<?, ?> rawSource)) {
                throw new ApiException(502, "Elasticsearch から想定外の検索結果が返されました。");
            }
            Map<String, Object> result = stringMap(rawSource);
            result.put("id", hit.get("_id"));
            result.put("_score", hit.get("_score"));
            result.put("highlight", hit.getOrDefault("highlight", Map.of()));
            results.add(result);
        }
        return new Hits(total, results);
    }

    private static Response requestJson(String method, String endpoint, Object payload, HttpClient client)
        throws IOException, InterruptedException {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(endpoint))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "application/json");
        if ("POST".equals(method)) {
            builder.POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(payload)));
        } else {
            builder.GET();
        }
        HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        Map<String, Object> body = response.body().isBlank()
            ? new HashMap<>()
            : JSON.readValue(response.body(), new TypeReference<>() {});
        return new Response(response.statusCode(), body);
    }

    private static String errorType(Map<String, Object> response) {
        if (response.get("error") instanceof Map<?, ?> error) {
            Object type = error.get("type");
            return type == null ? "" : String.valueOf(type);
        }
        return "";
    }

    private static int mapEsStatus(int status) {
        return status >= 500 ? 502 : 500;
    }

    private static String escape(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static Map<String, Object> stringMap(Map<?, ?> input) {
        Map<String, Object> result = new LinkedHashMap<>();
        input.forEach((key, value) -> result.put(String.valueOf(key), value));
        return result;
    }

    record HealthCheck(int status, Map<String, Object> body) {}

    private record Response(int status, Map<String, Object> body) {}
    private record Hits(int total, List<Map<String, Object>> results) {}
}
