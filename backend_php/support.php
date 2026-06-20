<?php
declare(strict_types=1);

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
