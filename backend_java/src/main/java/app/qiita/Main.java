package app.qiita;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class Main {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_PREVIEW_BYTES = 1_000_000;
    private final String esUrl = env("ES_URL", "http://elastic1:9200").replaceAll("/+$", "");
    private final String index = env("ES_INDEX", "qiita-articles");
    private final Set<String> allowedOrigins = Set.copyOf(Arrays.stream(env(
        "CORS_ORIGINS",
        "http://localhost:8082,http://127.0.0.1:8082"
    ).split(",")).map(String::trim).toList());
    private final HttpClient esClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3))
        .build();

    public static void main(String[] args) throws IOException {
        new Main().start();
    }

    private void start() throws IOException {
        int port = Integer.parseInt(env("BACKEND_PORT", "5023"));
        HttpServer server = HttpServer.create(new InetSocketAddress(env("BACKEND_HOST", "0.0.0.0"), port), 0);
        server.createContext("/", this::handle);
        server.setExecutor(null);
        server.start();
        System.out.printf("Java backend listening on :%d%n", port);
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            addCors(exchange);
            if ("OPTIONS".equals(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                return;
            }
            String path = exchange.getRequestURI().getPath();
            Map<String, String> query = query(exchange.getRequestURI().getRawQuery());
            if (path.equals("/health")) {
                respond(exchange, 200, Map.of("status", "ok", "backend", "java"));
            } else if (path.equals("/health/elasticsearch")) {
                elasticsearchHealth(exchange);
            } else if (path.equals("/api/recent")) {
                recent(exchange, query);
            } else if (path.equals("/api/search")) {
                search(exchange, query);
            } else if (path.equals("/api/articles")) {
                articles(exchange, query);
            } else if (path.startsWith("/api/articles/")) {
                article(exchange, URLDecoder.decode(path.substring("/api/articles/".length()), StandardCharsets.UTF_8));
            } else if (path.equals("/api/link-preview")) {
                respond(exchange, 200, linkPreview(query.getOrDefault("url", "").trim()));
            } else {
                respond(exchange, 404, Map.of("error", "Not found"));
            }
        } catch (ApiException error) {
            respond(exchange, error.status, Map.of("error", error.getMessage()));
        } catch (Exception error) {
            error.printStackTrace();
            respond(exchange, 500, Map.of("error", "サーバー内部でエラーが発生しました。"));
        } finally {
            exchange.close();
        }
    }

    private void recent(HttpExchange exchange, Map<String, String> params) throws Exception {
        int size = positiveInt(params.get("size"), 10, 100);
        String tag = params.getOrDefault("tag", "").trim();
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
        respond(exchange, 200, Map.of("total", hits.results.size(), "results", hits.results));
    }

    private void elasticsearchHealth(HttpExchange exchange) throws IOException {
        long startedAt = System.nanoTime();
        try {
            Response response = requestJson("GET", esUrl, null, esClient);
            long latency = Math.round((System.nanoTime() - startedAt) / 1_000_000.0);
            if (response.status != 200) {
                respond(exchange, 503, Map.of(
                    "status", "error", "service", "elasticsearch", "checked_by", "java",
                    "latency_ms", latency, "error", "Elasticsearch に接続できませんでした。"
                ));
                return;
            }
            String clusterName = String.valueOf(response.body.getOrDefault("cluster_name", ""));
            String version = "";
            if (response.body.get("version") instanceof Map<?, ?> versionMap) {
                Object number = versionMap.get("number");
                version = number == null ? "" : String.valueOf(number);
            }
            respond(exchange, 200, Map.of(
                "status", "ok", "service", "elasticsearch", "checked_by", "java",
                "latency_ms", latency, "cluster_name", clusterName, "version", version
            ));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            respondElasticsearchUnavailable(exchange, startedAt);
        } catch (IOException error) {
            respondElasticsearchUnavailable(exchange, startedAt);
        }
    }

    private void respondElasticsearchUnavailable(HttpExchange exchange, long startedAt) throws IOException {
        long latency = Math.round((System.nanoTime() - startedAt) / 1_000_000.0);
        respond(exchange, 503, Map.of(
            "status", "error", "service", "elasticsearch", "checked_by", "java",
            "latency_ms", latency, "error", "Elasticsearch に接続できませんでした。"
        ));
    }

    private void search(HttpExchange exchange, Map<String, String> params) throws Exception {
        String text = params.getOrDefault("q", "").trim();
        if (text.isEmpty()) throw new ApiException(400, "検索キーワード q を指定してください。");
        int page = positiveInt(params.get("page"), 1, 0);
        int size = positiveInt(params.get("size"), 10, 100);
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
        respondHits(exchange, response, page, size);
    }

    private void articles(HttpExchange exchange, Map<String, String> params) throws Exception {
        int page = positiveInt(params.get("page"), 1, 0);
        int size = positiveInt(params.get("size"), 20, 100);
        Map<String, Object> response = esSearch(Map.of(
            "query", Map.of("match_all", Map.of()),
            "sort", List.of(Map.of("created_at", Map.of("order", "desc", "unmapped_type", "date"))),
            "from", (page - 1) * size,
            "size", size
        ));
        respondHits(exchange, response, page, size);
    }

    private void respondHits(HttpExchange exchange, Map<String, Object> response, int page, int size) throws IOException {
        Hits hits = parseHits(response);
        respond(exchange, 200, Map.of(
            "total", hits.total,
            "page", page,
            "size", size,
            "results", hits.results
        ));
    }

    private void article(HttpExchange exchange, String id) throws Exception {
        Response response;
        try {
            response = requestJson(
                "GET",
                esUrl + "/" + escape(index) + "/_doc/" + escape(id),
                null,
                esClient
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
        respond(exchange, 200, source);
    }

    private Map<String, Object> esSearch(Map<String, Object> body) throws Exception {
        Response response;
        try {
            response = requestJson("POST", esUrl + "/" + escape(index) + "/_search", body, esClient);
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

    private Map<String, Object> linkPreview(String rawUrl) throws Exception {
        URI current = validatePublicUrl(rawUrl);
        HttpClient previewClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
        for (int redirects = 0; redirects <= 3; redirects++) {
            HttpRequest request = HttpRequest.newBuilder(current)
                .timeout(Duration.ofSeconds(8))
                .header("User-Agent", "Mozilla/5.0 (compatible; QiitaSearchLinkPreview/1.0)")
                .header("Accept", "text/html,application/xhtml+xml")
                .GET()
                .build();
            HttpResponse<byte[]> response;
            try {
                response = previewClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
            } catch (IOException error) {
                throw new ApiException(502, "リンク先の情報を取得できませんでした。");
            }
            if (response.statusCode() >= 300 && response.statusCode() < 400) {
                String location = response.headers().firstValue("location").orElse("");
                if (location.isEmpty()) throw new ApiException(502, "リンク先の情報を取得できませんでした。");
                current = validatePublicUrl(current.resolve(location).toString());
                continue;
            }
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new ApiException(502, "リンク先の情報を取得できませんでした。");
            }
            String contentType = response.headers().firstValue("content-type").orElse("").toLowerCase();
            if (!contentType.contains("text/html") && !contentType.contains("application/xhtml+xml")) {
                throw new ApiException(400, "HTMLページではないためプレビューできません。");
            }
            byte[] bytes = response.body();
            String document = new String(bytes, 0, Math.min(bytes.length, MAX_PREVIEW_BYTES), StandardCharsets.UTF_8);
            String host = current.getHost();
            String title = firstNonEmpty(meta(document, "property", "og:title"), title(document), host);
            String description = firstNonEmpty(meta(document, "property", "og:description"), meta(document, "name", "description"));
            String siteName = firstNonEmpty(meta(document, "property", "og:site_name"), host);
            return Map.of(
                "url", current.toString(),
                "title", truncate(title, 300),
                "description", truncate(description, 500),
                "image", absoluteHttpUrl(meta(document, "property", "og:image"), current),
                "site_name", truncate(siteName, 100)
            );
        }
        throw new ApiException(502, "リンク先の情報を取得できませんでした。");
    }

    private URI validatePublicUrl(String raw) {
        URI uri;
        try {
            uri = URI.create(raw);
        } catch (IllegalArgumentException error) {
            throw new ApiException(400, "http または https のURLを指定してください。");
        }
        if (!List.of("http", "https").contains(uri.getScheme()) || uri.getHost() == null) {
            throw new ApiException(400, "http または https のURLを指定してください。");
        }
        if (uri.getUserInfo() != null) {
            throw new ApiException(400, "認証情報を含むURLはプレビューできません。");
        }
        try {
            InetAddress[] addresses = InetAddress.getAllByName(uri.getHost());
            for (InetAddress address : addresses) {
                if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
                    || address.isSiteLocalAddress() || address.isMulticastAddress()) {
                    throw new ApiException(400, "ローカルネットワークのURLはプレビューできません。");
                }
            }
        } catch (IOException error) {
            throw new ApiException(400, "リンク先のホストを解決できません。");
        }
        return uri;
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

    private static String meta(String document, String attribute, String value) {
        String quoted = Pattern.quote(value);
        List<Pattern> patterns = List.of(
            Pattern.compile("<meta[^>]+" + attribute + "=[\"']" + quoted + "[\"'][^>]+content=[\"']([^\"']*)[\"'][^>]*>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL),
            Pattern.compile("<meta[^>]+content=[\"']([^\"']*)[\"'][^>]+" + attribute + "=[\"']" + quoted + "[\"'][^>]*>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL)
        );
        for (Pattern pattern : patterns) {
            Matcher matcher = pattern.matcher(document);
            if (matcher.find()) return htmlDecode(matcher.group(1)).trim();
        }
        return "";
    }

    private static String title(String document) {
        Matcher matcher = Pattern.compile("<title[^>]*>(.*?)</title>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL).matcher(document);
        return matcher.find() ? htmlDecode(matcher.group(1).replaceAll("<[^>]+>", "")).trim() : "";
    }

    private static String htmlDecode(String value) {
        return value.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
            .replace("&lt;", "<").replace("&gt;", ">");
    }

    private static String absoluteHttpUrl(String value, URI base) {
        if (value.isEmpty()) return "";
        try {
            URI resolved = base.resolve(value);
            return List.of("http", "https").contains(resolved.getScheme()) ? resolved.toString() : "";
        } catch (IllegalArgumentException error) {
            return "";
        }
    }

    private static String truncate(String value, int maximum) {
        int count = value.codePointCount(0, value.length());
        return count <= maximum ? value : value.substring(0, value.offsetByCodePoints(0, maximum));
    }

    private void addCors(HttpExchange exchange) {
        String origin = exchange.getRequestHeaders().getFirst("Origin");
        if (origin != null && allowedOrigins.contains(origin)) {
            exchange.getResponseHeaders().set("Access-Control-Allow-Origin", origin);
            exchange.getResponseHeaders().set("Vary", "Origin");
        }
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, OPTIONS");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
    }

    private static void respond(HttpExchange exchange, int status, Object payload) throws IOException {
        byte[] body = JSON.writeValueAsBytes(payload);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, body.length);
        exchange.getResponseBody().write(body);
    }

    private static Map<String, String> query(String rawQuery) {
        Map<String, String> result = new HashMap<>();
        if (rawQuery == null || rawQuery.isEmpty()) return result;
        for (String pair : rawQuery.split("&")) {
            String[] parts = pair.split("=", 2);
            result.put(
                URLDecoder.decode(parts[0], StandardCharsets.UTF_8),
                parts.length == 2 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : ""
            );
        }
        return result;
    }

    private static int positiveInt(String value, int fallback, int maximum) {
        int number;
        try {
            number = Integer.parseInt(value);
        } catch (RuntimeException error) {
            number = fallback;
        }
        if (number < 1) number = fallback;
        return maximum > 0 ? Math.min(number, maximum) : number;
    }

    private static int mapEsStatus(int status) {
        return status >= 500 ? 502 : 500;
    }

    private static String escape(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) if (value != null && !value.isEmpty()) return value;
        return "";
    }

    private static Map<String, Object> stringMap(Map<?, ?> input) {
        Map<String, Object> result = new LinkedHashMap<>();
        input.forEach((key, value) -> result.put(String.valueOf(key), value));
        return result;
    }

    private static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isEmpty() ? fallback : value;
    }

    private record Response(int status, Map<String, Object> body) {}
    private record Hits(int total, List<Map<String, Object>> results) {}

    private static final class ApiException extends RuntimeException {
        private final int status;
        private ApiException(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
