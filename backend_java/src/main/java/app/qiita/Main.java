package app.qiita;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public final class Main {
    private static final ObjectMapper JSON = new ObjectMapper();

    private final ElasticsearchService elasticsearch = new ElasticsearchService(
        env("ES_URL", "http://elastic1:9200").replaceAll("/+$", ""),
        env("ES_INDEX", "qiita-articles")
    );
    private final LinkPreviewService linkPreview = new LinkPreviewService();

    public static void main(String[] args) throws IOException {
        new Main().start();
    }

    private void start() throws IOException {
        int port = 5000;
        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
        server.createContext("/", this::handle);
        server.setExecutor(null);
        server.start();
        System.out.printf("Java backend listening on :%d%n", port);
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            String path = exchange.getRequestURI().getPath();
            Map<String, String> query = query(exchange.getRequestURI().getRawQuery());
            if (path.equals("/health")) {
                respond(exchange, 200, Map.of("status", "ok", "backend", "java"));
            } else if (path.equals("/health/elasticsearch")) {
                ElasticsearchService.HealthCheck health = elasticsearch.health();
                respond(exchange, health.status(), health.body());
            } else if (path.equals("/api/recent")) {
                int size = positiveInt(query.get("size"), 10, 100);
                String tag = query.getOrDefault("tag", "").trim();
                respond(exchange, 200, elasticsearch.recent(size, tag));
            } else if (path.equals("/api/search")) {
                String text = query.getOrDefault("q", "").trim();
                if (text.isEmpty()) throw new ApiException(400, "検索キーワード q を指定してください。");
                int page = positiveInt(query.get("page"), 1, 0);
                int size = positiveInt(query.get("size"), 10, 100);
                respond(exchange, 200, elasticsearch.search(text, page, size));
            } else if (path.equals("/api/articles")) {
                int page = positiveInt(query.get("page"), 1, 0);
                int size = positiveInt(query.get("size"), 20, 100);
                respond(exchange, 200, elasticsearch.articles(page, size));
            } else if (path.startsWith("/api/articles/")) {
                String id = URLDecoder.decode(path.substring("/api/articles/".length()), StandardCharsets.UTF_8);
                respond(exchange, 200, elasticsearch.article(id));
            } else if (path.equals("/api/link-preview")) {
                respond(exchange, 200, linkPreview.fetch(query.getOrDefault("url", "").trim()));
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

    private static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isEmpty() ? fallback : value;
    }
}
