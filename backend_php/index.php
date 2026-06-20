<?php
declare(strict_types=1);

const MAX_PREVIEW_BYTES = 1000000;

function env_value(string $key, string $default): string {
    $value = getenv($key);
    return $value === false || $value === '' ? $default : $value;
}

function json_response(int $status, array $payload): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function positive_int(?string $value, int $default, ?int $maximum = null): int {
    $parsed = filter_var($value, FILTER_VALIDATE_INT);
    $number = $parsed !== false && $parsed > 0 ? $parsed : $default;
    return $maximum === null ? $number : min($number, $maximum);
}

function http_json(string $method, string $url, ?array $payload = null): array {
    $headers = ['Content-Type: application/json'];
    $options = [
        'http' => [
            'method' => $method,
            'header' => implode("\r\n", $headers),
            'ignore_errors' => true,
            'timeout' => 10,
        ],
    ];
    if ($payload !== null) {
        $options['http']['content'] = json_encode($payload, JSON_UNESCAPED_UNICODE);
    }
    $body = @file_get_contents($url, false, stream_context_create($options));
    if ($body === false) {
        throw new RuntimeException('connection');
    }
    $status = 0;
    foreach ($http_response_header ?? [] as $header) {
        if (preg_match('/^HTTP\/\S+\s+(\d+)/', $header, $match)) {
            $status = (int)$match[1];
        }
    }
    $decoded = json_decode($body, true);
    return [$status, is_array($decoded) ? $decoded : []];
}

function error_type(array $response): string {
    return is_array($response['error'] ?? null) ? (string)($response['error']['type'] ?? '') : '';
}

function es_error_status(int $status): int {
    return $status >= 500 ? 502 : 500;
}

function es_search(array $body): array {
    $base = rtrim(env_value('ES_URL', 'http://elastic1:9200'), '/');
    $index = env_value('ES_INDEX', 'qiita-articles');
    try {
        [$status, $response] = http_json('POST', "$base/" . rawurlencode($index) . '/_search', $body);
    } catch (RuntimeException) {
        json_response(503, ['error' => 'Elasticsearch に接続できませんでした。接続先を確認してください。']);
    }
    if ($status === 404 && error_type($response) === 'index_not_found_exception') {
        json_response(404, ['error' => "Elasticsearch インデックス「$index」が見つかりません。"]);
    }
    if ($status !== 200) {
        json_response(es_error_status($status), ['error' => 'Elasticsearch で検索を実行できませんでした。']);
    }
    return $response;
}

function parse_hits(array $response): array {
    $hits = $response['hits'] ?? null;
    if (!is_array($hits) || !is_array($hits['hits'] ?? null)) {
        json_response(502, ['error' => 'Elasticsearch から想定外の検索結果が返されました。']);
    }
    $totalValue = $hits['total'] ?? 0;
    $total = is_array($totalValue) ? (int)($totalValue['value'] ?? 0) : (int)$totalValue;
    $results = [];
    foreach ($hits['hits'] as $hit) {
        if (!is_array($hit) || !is_array($hit['_source'] ?? null)) {
            json_response(502, ['error' => 'Elasticsearch から想定外の検索結果が返されました。']);
        }
        $results[] = array_merge($hit['_source'], [
            'id' => $hit['_id'] ?? null,
            '_score' => $hit['_score'] ?? null,
            'highlight' => $hit['highlight'] ?? new stdClass(),
        ]);
    }
    return [$total, $results];
}

function public_url(string $raw): array {
    $parts = parse_url(trim($raw));
    if (!is_array($parts) || !in_array($parts['scheme'] ?? '', ['http', 'https'], true) || empty($parts['host'])) {
        json_response(400, ['error' => 'http または https のURLを指定してください。']);
    }
    if (isset($parts['user']) || isset($parts['pass'])) {
        json_response(400, ['error' => '認証情報を含むURLはプレビューできません。']);
    }
    $records = @dns_get_record($parts['host'], DNS_A | DNS_AAAA);
    if ($records === false || $records === []) {
        json_response(400, ['error' => 'リンク先のホストを解決できません。']);
    }
    foreach ($records as $record) {
        $address = $record['ip'] ?? $record['ipv6'] ?? '';
        if ($address === '' || filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            json_response(400, ['error' => 'ローカルネットワークのURLはプレビューできません。']);
        }
    }
    return $parts;
}

function meta_content(string $html, string $attribute, string $value): string {
    $quoted = preg_quote($value, '/');
    $patterns = [
        '/<meta[^>]+' . $attribute . '=["\']' . $quoted . '["\'][^>]+content=["\']([^"\']*)["\'][^>]*>/is',
        '/<meta[^>]+content=["\']([^"\']*)["\'][^>]+' . $attribute . '=["\']' . $quoted . '["\'][^>]*>/is',
    ];
    foreach ($patterns as $pattern) {
        if (preg_match($pattern, $html, $match)) {
            return trim(html_entity_decode($match[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        }
    }
    return '';
}

function first_non_empty(string ...$values): string {
    foreach ($values as $value) {
        if ($value !== '') return $value;
    }
    return '';
}

function utf8_truncate(string $value, int $maximum): string {
    $characters = preg_split('//u', $value, -1, PREG_SPLIT_NO_EMPTY);
    if ($characters === false || count($characters) <= $maximum) return $value;
    return implode('', array_slice($characters, 0, $maximum));
}

function absolute_url(string $value, string $base): string {
    if ($value === '') return '';
    if (preg_match('#^https?://#i', $value)) return $value;
    $parts = parse_url($base);
    if (!is_array($parts)) return '';
    $origin = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
    if (str_starts_with($value, '/')) return $origin . $value;
    $path = $parts['path'] ?? '/';
    return $origin . rtrim(dirname($path), '/') . '/' . ltrim($value, '/');
}

function link_preview(string $target): never {
    public_url($target);
    $current = trim($target);
    for ($redirects = 0; $redirects <= 3; $redirects++) {
        public_url($current);
        $context = stream_context_create(['http' => [
            'method' => 'GET',
            'header' => "User-Agent: Mozilla/5.0 (compatible; QiitaSearchLinkPreview/1.0)\r\nAccept: text/html,application/xhtml+xml",
            'ignore_errors' => true,
            'follow_location' => 0,
            'timeout' => 8,
        ]]);
        $stream = @fopen($current, 'rb', false, $context);
        if ($stream === false) json_response(502, ['error' => 'リンク先の情報を取得できませんでした。']);
        $headers = $http_response_header ?? [];
        $status = 0;
        $contentType = '';
        $location = '';
        foreach ($headers as $header) {
            if (preg_match('/^HTTP\/\S+\s+(\d+)/', $header, $match)) $status = (int)$match[1];
            if (stripos($header, 'Content-Type:') === 0) $contentType = strtolower(trim(substr($header, 13)));
            if (stripos($header, 'Location:') === 0) $location = trim(substr($header, 9));
        }
        if ($status >= 300 && $status < 400 && $location !== '') {
            fclose($stream);
            $current = absolute_url($location, $current);
            continue;
        }
        $html = stream_get_contents($stream, MAX_PREVIEW_BYTES);
        fclose($stream);
        if ($status < 200 || $status >= 300 || $html === false) {
            json_response(502, ['error' => 'リンク先の情報を取得できませんでした。']);
        }
        if (!str_contains($contentType, 'text/html') && !str_contains($contentType, 'application/xhtml+xml')) {
            json_response(400, ['error' => 'HTMLページではないためプレビューできません。']);
        }
        $parts = parse_url($current);
        $host = (string)($parts['host'] ?? '');
        $titleTag = preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $match)
            ? trim(html_entity_decode(strip_tags($match[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8')) : '';
        json_response(200, [
            'url' => $current,
            'title' => utf8_truncate(first_non_empty(meta_content($html, 'property', 'og:title'), $titleTag, $host), 300),
            'description' => utf8_truncate(first_non_empty(meta_content($html, 'property', 'og:description'), meta_content($html, 'name', 'description')), 500),
            'image' => absolute_url(meta_content($html, 'property', 'og:image'), $current),
            'site_name' => utf8_truncate(first_non_empty(meta_content($html, 'property', 'og:site_name'), $host), 100),
        ]);
    }
    json_response(502, ['error' => 'リンク先の情報を取得できませんでした。']);
}

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';

if ($path === '/health') {
    json_response(200, ['status' => 'ok', 'backend' => 'php']);
}

if ($path === '/health/elasticsearch') {
    $startedAt = hrtime(true);
    try {
        [$status, $response] = http_json('GET', rtrim(env_value('ES_URL', 'http://elastic1:9200'), '/'));
        $latency = (int)round((hrtime(true) - $startedAt) / 1000000);
        if ($status === 200) {
            json_response(200, [
                'status' => 'ok',
                'service' => 'elasticsearch',
                'checked_by' => 'php',
                'latency_ms' => $latency,
                'cluster_name' => (string)($response['cluster_name'] ?? ''),
                'version' => (string)($response['version']['number'] ?? ''),
            ]);
        }
    } catch (RuntimeException) {
        $latency = (int)round((hrtime(true) - $startedAt) / 1000000);
    }
    json_response(503, [
        'status' => 'error',
        'service' => 'elasticsearch',
        'checked_by' => 'php',
        'latency_ms' => $latency,
        'error' => 'Elasticsearch に接続できませんでした。',
    ]);
}

if ($path === '/api/recent') {
    $size = positive_int($_GET['size'] ?? null, 10, 100);
    $tag = trim((string)($_GET['tag'] ?? ''));
    $query = $tag === '' ? ['match_all' => new stdClass()] : ['bool' => [
        'should' => [
            ['term' => ['tags.keyword' => $tag]],
            ['match_phrase' => ['tags' => $tag]],
        ],
        'minimum_should_match' => 1,
    ]];
    $sortField = $tag === '' ? 'updated_at' : 'created_at';
    [, $results] = parse_hits(es_search([
        'query' => $query,
        'sort' => [[$sortField => ['order' => 'desc', 'unmapped_type' => 'date']]],
        'size' => $size,
    ]));
    json_response(200, ['total' => count($results), 'results' => $results]);
}

if ($path === '/api/search') {
    $query = trim((string)($_GET['q'] ?? ''));
    if ($query === '') json_response(400, ['error' => '検索キーワード q を指定してください。']);
    $page = positive_int($_GET['page'] ?? null, 1);
    $size = positive_int($_GET['size'] ?? null, 10, 100);
    [$total, $results] = parse_hits(es_search([
        'query' => ['multi_match' => ['query' => $query, 'fields' => ['title^3', 'body', 'tags^2']]],
        'highlight' => [
            'pre_tags' => ['<mark>'], 'post_tags' => ['</mark>'],
            'fields' => ['title' => new stdClass(), 'body' => ['fragment_size' => 160, 'number_of_fragments' => 3]],
        ],
        'from' => ($page - 1) * $size, 'size' => $size,
    ]));
    json_response(200, compact('total', 'page', 'size', 'results'));
}

if ($path === '/api/articles') {
    $page = positive_int($_GET['page'] ?? null, 1);
    $size = positive_int($_GET['size'] ?? null, 20, 100);
    [$total, $results] = parse_hits(es_search([
        'query' => ['match_all' => new stdClass()],
        'sort' => [['created_at' => ['order' => 'desc', 'unmapped_type' => 'date']]],
        'from' => ($page - 1) * $size, 'size' => $size,
    ]));
    json_response(200, compact('total', 'page', 'size', 'results'));
}

if (preg_match('#^/api/articles/(.+)$#', $path, $match)) {
    $base = rtrim(env_value('ES_URL', 'http://elastic1:9200'), '/');
    $index = env_value('ES_INDEX', 'qiita-articles');
    try {
        [$status, $response] = http_json('GET', "$base/" . rawurlencode($index) . '/_doc/' . rawurlencode(urldecode($match[1])));
    } catch (RuntimeException) {
        json_response(503, ['error' => 'Elasticsearch に接続できませんでした。接続先を確認してください。']);
    }
    if ($status === 404) {
        $message = error_type($response) === 'index_not_found_exception'
            ? "Elasticsearch インデックス「$index」が見つかりません。"
            : '指定された記事は見つかりませんでした。';
        json_response(404, ['error' => $message]);
    }
    if ($status !== 200 || !is_array($response['_source'] ?? null)) {
        json_response($status === 200 ? 502 : es_error_status($status), ['error' => 'Elasticsearch から記事を取得できませんでした。']);
    }
    json_response(200, array_merge($response['_source'], ['id' => $response['_id'] ?? null]));
}

if ($path === '/api/link-preview') {
    link_preview(trim((string)($_GET['url'] ?? '')));
}

json_response(404, ['error' => 'Not found']);
