# Ruby backend

WEBrick で動作する記事検索 API です。

## ファイル構成

```text
backend_ruby/
├── Dockerfile
├── server.rb                   # サーバー起動、ルーティング、HTTP 応答
├── elasticsearch_service.rb    # Elasticsearch 通信と記事検索
├── link_preview_service.rb     # URL 検証とリンクプレビュー取得
└── api_error.rb                # HTTP ステータス付き API 例外
```

## 主な設定

- `ES_URL`: Elasticsearch の URL
- `ES_INDEX`: 記事インデックス名

## 確認方法

```sh
for file in backend_ruby/*.rb; do ruby -c "$file"; done
docker compose build backend_ruby
```
