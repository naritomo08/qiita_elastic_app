import os
import time

import requests
import uvicorn
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

from .elasticsearch_client import (
    ArticleNotFoundError,
    ElasticsearchIndexNotFoundError,
    ElasticsearchResponseError,
    ElasticsearchServiceError,
    ElasticsearchUnavailableError,
    QiitaArticleRepository,
)
from .link_preview import get_link_preview


app = FastAPI(title="Qiita Search Python Backend")
repository = QiitaArticleRepository()


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


def json_response(content: dict, status_code: int = 200) -> JSONResponse:
    return JSONResponse(content=content, status_code=status_code)


@app.get("/health")
def health():
    return json_response({"status": "ok", "backend": "python"})


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
        return json_response(
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
        return json_response(
            {
                "status": "error",
                "service": "elasticsearch",
                "checked_by": "python",
                "latency_ms": round((time.monotonic() - started_at) * 1000),
                "error": "Elasticsearch に接続できませんでした。",
            },
            503,
        )


@app.get("/api/recent")
def api_recent(size: str | None = Query(None), tag: str = ""):
    parsed_size = parse_positive_int(size, 10, 1, 100)
    parsed_tag = tag.strip()
    try:
        results = repository.recent_articles(size=parsed_size, tag=parsed_tag or None)
        return json_response({"total": len(results), "results": results})
    except ElasticsearchServiceError as exc:
        return json_response({"error": str(exc)}, _status_for_error(exc))


@app.get("/api/search")
def api_search(
    q: str = "",
    page: str | None = Query(None),
    size: str | None = Query(None),
):
    query = q.strip()
    if not query:
        return json_response({"error": "検索キーワード q を指定してください。"}, 400)
    parsed_page = parse_positive_int(page, 1)
    parsed_size = parse_positive_int(size, 10, 1, 100)
    try:
        result = repository.search_articles(query, parsed_page, parsed_size)
        return json_response(
            {
                "total": result.total,
                "page": result.page,
                "size": result.size,
                "results": result.results,
            }
        )
    except ElasticsearchServiceError as exc:
        return json_response({"error": str(exc)}, _status_for_error(exc))


@app.get("/api/articles")
def api_articles(page: str | None = Query(None), size: str | None = Query(None)):
    parsed_page = parse_positive_int(page, 1)
    parsed_size = parse_positive_int(size, 20, 1, 100)
    try:
        result = repository.list_articles(parsed_page, parsed_size)
        return json_response(
            {
                "total": result.total,
                "page": result.page,
                "size": result.size,
                "results": result.results,
            }
        )
    except ElasticsearchServiceError as exc:
        return json_response({"error": str(exc)}, _status_for_error(exc))


@app.get("/api/articles/{article_id:path}")
def api_article_detail(article_id: str):
    try:
        return json_response(repository.get_article(article_id))
    except ArticleNotFoundError as exc:
        return json_response({"error": str(exc)}, 404)
    except ElasticsearchServiceError as exc:
        return json_response({"error": str(exc)}, _status_for_error(exc))


@app.get("/api/link-preview")
def api_link_preview(url: str = ""):
    try:
        return json_response(get_link_preview(url.strip()))
    except ValueError as exc:
        return json_response({"error": str(exc)}, 400)
    except (requests.RequestException, OSError):
        return json_response({"error": "リンク先の情報を取得できませんでした。"}, 502)


def _status_for_error(error: ElasticsearchServiceError) -> int:
    if isinstance(error, ElasticsearchIndexNotFoundError):
        return 404
    if isinstance(error, ElasticsearchUnavailableError):
        return 503
    if isinstance(error, ElasticsearchResponseError):
        return 502
    return 500


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)
