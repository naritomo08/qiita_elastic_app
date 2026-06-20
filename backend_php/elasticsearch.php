<?php
declare(strict_types=1);

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

function handle_elasticsearch_health(): never {
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

function handle_recent(): never {
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

function handle_search(): never {
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

function handle_articles(): never {
    $page = positive_int($_GET['page'] ?? null, 1);
    $size = positive_int($_GET['size'] ?? null, 20, 100);
    [$total, $results] = parse_hits(es_search([
        'query' => ['match_all' => new stdClass()],
        'sort' => [['created_at' => ['order' => 'desc', 'unmapped_type' => 'date']]],
        'from' => ($page - 1) * $size, 'size' => $size,
    ]));
    json_response(200, compact('total', 'page', 'size', 'results'));
}

function handle_article(string $id): never {
    $base = rtrim(env_value('ES_URL', 'http://elastic1:9200'), '/');
    $index = env_value('ES_INDEX', 'qiita-articles');
    try {
        [$status, $response] = http_json('GET', "$base/" . rawurlencode($index) . '/_doc/' . rawurlencode($id));
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
