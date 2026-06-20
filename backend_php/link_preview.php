<?php
declare(strict_types=1);

const MAX_PREVIEW_BYTES = 1000000;

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
