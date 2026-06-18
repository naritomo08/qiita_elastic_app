import os
from dataclasses import dataclass
from typing import Any

from elasticsearch import Elasticsearch
from elasticsearch.exceptions import (
    ConnectionError as ElasticsearchConnectionError,
    NotFoundError,
    TransportError,
)


class ElasticsearchServiceError(Exception):
    """Base exception for Elasticsearch-related application errors."""


class ElasticsearchUnavailableError(ElasticsearchServiceError):
    """Raised when Elasticsearch cannot be reached."""


class ElasticsearchIndexNotFoundError(ElasticsearchServiceError):
    """Raised when the configured index does not exist."""


class ArticleNotFoundError(ElasticsearchServiceError):
    """Raised when an article document does not exist."""


class ElasticsearchResponseError(ElasticsearchServiceError):
    """Raised when Elasticsearch returns an unexpected response."""


@dataclass(frozen=True)
class SearchResult:
    total: int
    page: int
    size: int
    results: list[dict[str, Any]]


class QiitaArticleRepository:
    def __init__(self) -> None:
        self.es_url = os.getenv("ES_URL", "http://elastic1:9200")
        self.index = os.getenv("ES_INDEX", "qiita_articles")
        self.client = Elasticsearch(self.es_url, request_timeout=10)

    def recent_articles(
        self, size: int = 10, tag: str | None = None
    ) -> list[dict[str, Any]]:
        query: dict[str, Any] = {"match_all": {}}
        if tag:
            query = {
                "bool": {
                    "should": [
                        {"term": {"tags.keyword": tag}},
                        {"match_phrase": {"tags": tag}},
                    ],
                    "minimum_should_match": 1,
                }
            }
        response = self._search(
            {
                "query": query,
                "sort": [{"updated_at": {"order": "desc", "unmapped_type": "date"}}],
                "size": size,
            }
        )
        return self._parse_hits(response)

    def list_articles(self, page: int, size: int) -> SearchResult:
        response = self._search(
            {
                "query": {"match_all": {}},
                "sort": [{"created_at": {"order": "desc", "unmapped_type": "date"}}],
                "from": (page - 1) * size,
                "size": size,
            }
        )
        try:
            total_value = response["hits"]["total"]
            total = (
                int(total_value["value"])
                if isinstance(total_value, dict)
                else int(total_value)
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ElasticsearchResponseError(
                "Elasticsearch から想定外の記事一覧が返されました。"
            ) from exc
        return SearchResult(
            total=total,
            page=page,
            size=size,
            results=self._parse_hits(response),
        )

    def search_articles(self, query: str, page: int, size: int) -> SearchResult:
        response = self._search(
            {
                "query": {
                    "multi_match": {
                        "query": query,
                        "fields": ["title^3", "body", "tags^2"],
                    }
                },
                "highlight": {
                    "pre_tags": ["<mark>"],
                    "post_tags": ["</mark>"],
                    "fields": {
                        "title": {},
                        "body": {
                            "fragment_size": 160,
                            "number_of_fragments": 3,
                        },
                    },
                },
                "from": (page - 1) * size,
                "size": size,
            }
        )

        try:
            hits = response["hits"]
            total_value = hits["total"]
            total = (
                int(total_value["value"])
                if isinstance(total_value, dict)
                else int(total_value)
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ElasticsearchResponseError(
                "Elasticsearch から想定外の検索結果が返されました。"
            ) from exc

        return SearchResult(
            total=total,
            page=page,
            size=size,
            results=self._parse_hits(response),
        )

    def get_article(self, article_id: str) -> dict[str, Any]:
        try:
            response = self.client.get(index=self.index, id=article_id)
        except NotFoundError as exc:
            error_type = self._error_type(exc)
            if error_type == "index_not_found_exception":
                raise ElasticsearchIndexNotFoundError(
                    f"Elasticsearch インデックス「{self.index}」が見つかりません。"
                ) from exc
            raise ArticleNotFoundError("指定された記事は見つかりませんでした。") from exc
        except ElasticsearchConnectionError as exc:
            raise ElasticsearchUnavailableError(
                "Elasticsearch に接続できませんでした。接続先を確認してください。"
            ) from exc
        except TransportError as exc:
            raise ElasticsearchServiceError(
                "Elasticsearch から記事を取得できませんでした。"
            ) from exc

        try:
            source = response["_source"]
            if not isinstance(source, dict):
                raise TypeError("_source is not an object")
            return {"id": response["_id"], **source}
        except (KeyError, TypeError) as exc:
            raise ElasticsearchResponseError(
                "Elasticsearch から想定外の記事データが返されました。"
            ) from exc

    def _search(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self.client.search(index=self.index, body=body)
        except NotFoundError as exc:
            raise ElasticsearchIndexNotFoundError(
                f"Elasticsearch インデックス「{self.index}」が見つかりません。"
            ) from exc
        except ElasticsearchConnectionError as exc:
            raise ElasticsearchUnavailableError(
                "Elasticsearch に接続できませんでした。接続先を確認してください。"
            ) from exc
        except TransportError as exc:
            raise ElasticsearchServiceError(
                "Elasticsearch で検索を実行できませんでした。"
            ) from exc

        if not isinstance(response, dict):
            try:
                response = response.body
            except AttributeError as exc:
                raise ElasticsearchResponseError(
                    "Elasticsearch から想定外のレスポンスが返されました。"
                ) from exc
        return response

    @staticmethod
    def _parse_hits(response: dict[str, Any]) -> list[dict[str, Any]]:
        try:
            raw_hits = response["hits"]["hits"]
            if not isinstance(raw_hits, list):
                raise TypeError("hits.hits is not a list")

            results = []
            for hit in raw_hits:
                source = hit.get("_source", {})
                if not isinstance(source, dict):
                    raise TypeError("_source is not an object")
                results.append(
                    {
                        "id": hit["_id"],
                        **source,
                        "_score": hit.get("_score"),
                        "highlight": hit.get("highlight", {}),
                    }
                )
            return results
        except (KeyError, TypeError) as exc:
            raise ElasticsearchResponseError(
                "Elasticsearch から想定外の検索結果が返されました。"
            ) from exc

    @staticmethod
    def _error_type(exc: NotFoundError) -> str | None:
        info = getattr(exc, "info", None)
        if isinstance(info, dict):
            error = info.get("error", {})
            if isinstance(error, dict):
                return error.get("type")
        return None
