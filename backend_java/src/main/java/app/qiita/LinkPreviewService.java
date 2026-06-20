package app.qiita;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class LinkPreviewService {
    private static final int MAX_PREVIEW_BYTES = 1_000_000;

    Map<String, Object> fetch(String rawUrl) throws Exception {
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

    private static String firstNonEmpty(String... values) {
        for (String value : values) if (value != null && !value.isEmpty()) return value;
        return "";
    }
}
