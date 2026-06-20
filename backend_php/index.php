<?php
declare(strict_types=1);

require __DIR__ . '/support.php';
require __DIR__ . '/elasticsearch.php';
require __DIR__ . '/link_preview.php';

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';

if ($path === '/health') {
    json_response(200, ['status' => 'ok', 'backend' => 'php']);
}

if ($path === '/health/elasticsearch') {
    handle_elasticsearch_health();
}

if ($path === '/api/recent') {
    handle_recent();
}

if ($path === '/api/search') {
    handle_search();
}

if ($path === '/api/articles') {
    handle_articles();
}

if (preg_match('#^/api/articles/(.+)$#', $path, $match)) {
    handle_article(urldecode($match[1]));
}

if ($path === '/api/link-preview') {
    link_preview(trim((string)($_GET['url'] ?? '')));
}

json_response(404, ['error' => 'Not found']);
