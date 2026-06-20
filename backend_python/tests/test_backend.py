import unittest
from unittest.mock import Mock


from backend_python import main
from backend_python.elasticsearch_client import (
    ArticleNotFoundError,
    QiitaArticleRepository,
    SearchResult,
)


ARTICLE = {
    "id": "article-1",
    "title": "テスト記事",
    "body": "本文",
    "tags": ["Python"],
    "url": "https://qiita.com/example/items/article-1",
}


class FakeRepository:
    def recent_articles(self, size=10, tag=None):
        return [ARTICLE] if not tag or tag == "Python" else []

    def search_articles(self, query, page, size):
        return SearchResult(total=1, page=page, size=size, results=[ARTICLE])

    def list_articles(self, page, size):
        return SearchResult(total=1, page=page, size=size, results=[ARTICLE])

    def get_article(self, article_id):
        if article_id == "missing":
            raise ArticleNotFoundError("指定された記事は見つかりませんでした。")
        return ARTICLE


class BackendTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        main.app.config.update(TESTING=True)
        main.repository = FakeRepository()
        cls.client = main.app.test_client()

    def test_health(self):
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_recent_api_with_tag(self):
        response = self.client.get("/api/recent?tag=Python&size=50")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["total"], 1)

    def test_search_api(self):
        response = self.client.get("/api/search?q=Python&page=2&size=5")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["page"], 2)

    def test_search_api_requires_query(self):
        self.assertEqual(self.client.get("/api/search").status_code, 400)

    def test_all_articles_api(self):
        response = self.client.get("/api/articles?page=2&size=20")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["page"], 2)
        self.assertEqual(payload["size"], 20)

    def test_article_api(self):
        self.assertEqual(
            self.client.get("/api/articles/article-1").get_json()["id"], "article-1"
        )
        self.assertEqual(self.client.get("/api/articles/missing").status_code, 404)

    def test_link_preview_rejects_local_url(self):
        response = self.client.get(
            "/api/link-preview?url=http://127.0.0.1:9200/private"
        )
        self.assertEqual(response.status_code, 400)


class QiitaArticleRepositoryTestCase(unittest.TestCase):
    def setUp(self):
        self.repository = QiitaArticleRepository.__new__(QiitaArticleRepository)
        self.repository._search = Mock(return_value={"hits": {"hits": []}})

    def test_recent_articles_sort_by_updated_at_without_tag(self):
        self.repository.recent_articles()

        body = self.repository._search.call_args.args[0]
        self.assertEqual(
            body["sort"],
            [{"updated_at": {"order": "desc", "unmapped_type": "date"}}],
        )

    def test_recent_articles_sort_by_created_at_with_tag(self):
        self.repository.recent_articles(tag="Python")

        body = self.repository._search.call_args.args[0]
        self.assertEqual(
            body["sort"],
            [{"created_at": {"order": "desc", "unmapped_type": "date"}}],
        )


if __name__ == "__main__":
    unittest.main()
