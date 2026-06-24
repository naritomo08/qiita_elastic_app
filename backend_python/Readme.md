# Python backend

FastAPI と Uvicorn で動作する記事検索 API です。Elasticsearch の検索と、外部 URL のリンクプレビュー取得を担当します。

## ファイル構成

```text
backend_python/
├── Dockerfile                 # 依存関係の導入と Uvicorn の起動
├── requirements.txt           # Python パッケージ一覧
├── main.py                    # FastAPI のルーティングと HTTP レスポンス
├── elasticsearch_client.py    # Elasticsearch への問い合わせと例外変換
├── link_preview.py            # URL 検証とリンクプレビュー取得
└── tests/
    └── test_backend.py        # API と検索条件のユニットテスト
```

## 主な設定

- `ES_URL`: Elasticsearch の URL
- `ES_INDEX`: 記事インデックス名

## 確認方法

リポジトリルートで以下を実行します。

```sh
python3 -m unittest backend_python.tests.test_backend
docker compose build backend_python
```
