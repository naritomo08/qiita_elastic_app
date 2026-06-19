import os
import time

import requests
from flask import Flask, jsonify, request

from .elasticsearch_client import (
    ArticleNotFoundError,
    ElasticsearchIndexNotFoundError,
    ElasticsearchResponseError,
    ElasticsearchServiceError,
    ElasticsearchUnavailableError,
    QiitaArticleRepository,
)
from .link_preview import get_link_preview


app = Flask(__name__)
repository = QiitaArticleRepository()
allowed_origins = {
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:8082,http://127.0.0.1:8082",
    ).split(",")
    if origin.strip()
}


def parse_positive_int(
    value: str | None, default: int, minimum: int = 1, maximum: int | None = None
) -> int:
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError):
        return default
    if parsed < minimum:
        return minimum
    return min(parsed, maximum) if maximum is not None else parsed


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin in allowed_origins:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.get("/health")
def health():
    return jsonify({"status": "ok", "backend": "python"})


@app.get("/health/elasticsearch")
def elasticsearch_health():
    started_at = time.monotonic()
    try:
        response = requests.get(
            os.getenv("ES_URL", "http://elastic1:9200"),
            timeout=(2, 3),
            proxies={"http": None, "https": None},
        )
        response.raise_for_status()
        payload = response.json()
        return jsonify(
            {
                "status": "ok",
                "service": "elasticsearch",
                "checked_by": "python",
                "latency_ms": round((time.monotonic() - started_at) * 1000),
                "cluster_name": payload.get("cluster_name", ""),
                "version": payload.get("version", {}).get("number", ""),
            }
        )
    except (requests.RequestException, ValueError):
        return jsonify(
            {
                "status": "error",
                "service": "elasticsearch",
                "checked_by": "python",
                "latency_ms": round((time.monotonic() - started_at) * 1000),
                "error": "Elasticsearch に接続できませんでした。",
            }
        ), 503


@app.get("/api/recent")
def api_recent():
    size = parse_positive_int(request.args.get("size"), 10, 1, 100)
    tag = request.args.get("tag", "").strip()
    try:
        results = repository.recent_articles(size=size, tag=tag or None)
        return jsonify({"total": len(results), "results": results})
    except ElasticsearchServiceError as exc:
        return jsonify({"error": str(exc)}), _status_for_error(exc)


@app.get("/api/search")
def api_search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "検索キーワード q を指定してください。"}), 400
    page = parse_positive_int(request.args.get("page"), 1)
    size = parse_positive_int(request.args.get("size"), 10, 1, 100)
    try:
        result = repository.search_articles(query, page, size)
        return jsonify(
            {
                "total": result.total,
                "page": result.page,
                "size": result.size,
                "results": result.results,
            }
        )
    except ElasticsearchServiceError as exc:
        return jsonify({"error": str(exc)}), _status_for_error(exc)


@app.get("/api/articles")
def api_articles():
    page = parse_positive_int(request.args.get("page"), 1)
    size = parse_positive_int(request.args.get("size"), 20, 1, 100)
    try:
        result = repository.list_articles(page, size)
        return jsonify(
            {
                "total": result.total,
                "page": result.page,
                "size": result.size,
                "results": result.results,
            }
        )
    except ElasticsearchServiceError as exc:
        return jsonify({"error": str(exc)}), _status_for_error(exc)


@app.get("/api/articles/<path:article_id>")
def api_article_detail(article_id: str):
    try:
        return jsonify(repository.get_article(article_id))
    except ArticleNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except ElasticsearchServiceError as exc:
        return jsonify({"error": str(exc)}), _status_for_error(exc)


@app.get("/api/link-preview")
def api_link_preview():
    try:
        return jsonify(get_link_preview(request.args.get("url", "").strip()))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except (requests.RequestException, OSError):
        return jsonify({"error": "リンク先の情報を取得できませんでした。"}), 502


def _status_for_error(error: ElasticsearchServiceError) -> int:
    if isinstance(error, ElasticsearchIndexNotFoundError):
        return 404
    if isinstance(error, ElasticsearchUnavailableError):
        return 503
    if isinstance(error, ElasticsearchResponseError):
        return 502
    return 500


if __name__ == "__main__":
    app.run(
        host=os.getenv("BACKEND_HOST", "0.0.0.0"),
        port=parse_positive_int(os.getenv("BACKEND_PORT"), 5020),
    )
