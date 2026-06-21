# PHP backend

PHP の組み込み Web サーバーで動作する記事検索 API です。

## ファイル構成

```text
backend_php/
├── Dockerfile          # PHP ファイルの構文検査とサーバー起動
├── router.php          # 組み込み Web サーバーのルータースクリプト
├── index.php           # パス判定と各ハンドラーへの振り分け
├── elasticsearch.php   # Elasticsearch 通信と記事 API
├── link_preview.php    # URL 検証とリンクプレビュー取得
└── support.php         # JSON 応答、HTTP 通信、入力値の共通処理
```

## 主な設定

- `ES_URL`: Elasticsearch の URL
- `ES_INDEX`: 記事インデックス名

## 確認方法

```sh
for file in backend_php/*.php; do php -l "$file"; done
docker compose build backend_php
```
