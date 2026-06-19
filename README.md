# Qiita Article Search

Elasticsearchへ投入済みのQiita記事を検索・閲覧するWebアプリです。

フロントエンドはPythonを使用しない静的HTML/CSS/JavaScript SPA、バックエンドは独立したREST APIです。両者はJSON APIだけで接続し、6言語の実装を同じ画面から切り替えられます。

## アーキテクチャ

```text
ブラウザ
  ├── http://localhost:8082
  │     └── frontend: Nginx + HTML/CSS/JavaScript
  │
  ├── http://localhost:5020/api/*
  │     └── Python backend: Flask REST API
  │
  ├── http://localhost:5021/api/* ── Elixir backend
  ├── http://localhost:5022/api/* ── PHP backend
  ├── http://localhost:5023/api/* ── Java backend
  ├── http://localhost:5024/api/* ── Go backend
  └── http://localhost:5025/api/* ── Ruby backend
                                      │
                                      ▼
                                Elasticsearch
```

- frontend
  - Nginxで静的ファイルを配信
  - Dockerビルド時にCSS/JavaScriptへ内容ハッシュを付与
  - Python不使用
  - Jinja2などのサーバーサイドテンプレート不使用
  - Fetch APIでbackendへ直接接続
- backend_python / backend_elixir / backend_php / backend_java / backend_go / backend_ruby
  - Elasticsearch検索と記事取得
  - OGPリンクプレビュー取得
  - JSONだけを返すREST API
  - CORS対応
- フロントのBackendセレクターで6言語のバックエンドを切り替え
- 選択したバックエンドはブラウザのLocal Storageへ保存

## ポート

| サービス | URL |
|---|---|
| フロントエンド | <http://localhost:8082> |
| Pythonバックエンド | <http://localhost:5020> |
| Elixirバックエンド | <http://localhost:5021> |
| PHPバックエンド | <http://localhost:5022> |
| Javaバックエンド | <http://localhost:5023> |
| Goバックエンド | <http://localhost:5024> |
| Rubyバックエンド | <http://localhost:5025> |
| Pythonヘルスチェック | <http://localhost:5020/health> |
| Elixirヘルスチェック | <http://localhost:5021/health> |
| PHPヘルスチェック | <http://localhost:5022/health> |
| Javaヘルスチェック | <http://localhost:5023/health> |
| Goヘルスチェック | <http://localhost:5024/health> |
| Rubyヘルスチェック | <http://localhost:5025/health> |

## ディレクトリ構成

```text
.
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── index.html
│   └── static/
│       ├── app.js
│       └── style.css
├── backend_python/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── main.py
│   ├── elasticsearch_client.py
│   ├── link_preview.py
│   └── tests/
│       └── test_backend.py
├── backend_elixir/
│   ├── Dockerfile
│   ├── mix.exs
│   ├── config/
│   ├── lib/
│   │   └── qiita_search_backend/
│   │       ├── application.ex
│   │       ├── router.ex
│   │       ├── elasticsearch.ex
│   │       └── link_preview.ex
│   └── test/
├── backend_php/
│   ├── Dockerfile
│   ├── index.php
│   └── router.php
├── backend_java/
│   ├── Dockerfile
│   ├── pom.xml
│   └── src/
├── backend_go/
│   ├── Dockerfile
│   ├── go.mod
│   ├── main.go
│   └── main_test.go
├── backend_ruby/
│   ├── Dockerfile
│   └── server.rb
├── docker-compose.yml
├── .env
├── .env.example
└── README.md
```

## 機能

- 最近更新された記事一覧
- タイトル・本文・タグ検索
- 本文ハイライト
- ページング
- タグクリックによる絞り込み
- 全記事一覧とページング
- Markdown表示
- Markdownコードブロックのコピー
- Mermaid図表示
- 単独URLのOGPリンクカード
- Qiita元記事へのリンク
- レスポンシブ表示
- JSON API
- Python／Elixir／PHP／Java／Go／Rubyバックエンド切替
- バックエンドとElasticsearchの動的ヘルスチェック画面

## 環境変数

```env
ES_URL=http://elastic1:9200
ES_INDEX=qiita-articles
BACKEND_HOST=0.0.0.0
BACKEND_PORT=5020
CORS_ORIGINS=http://localhost:8082,http://127.0.0.1:8082
```

| 変数 | 説明 |
|---|---|
| `ES_URL` | Elasticsearch接続先 |
| `ES_INDEX` | 記事インデックス |
| `BACKEND_HOST` | API待受ホスト |
| `BACKEND_PORT` | API待受ポート |
| `CORS_ORIGINS` | APIアクセスを許可するフロントエンドOrigin。カンマ区切り |

フロントエンドはブラウザで開いたホスト名を利用し、選択内容に応じて同一ホストの5020〜5025番へ接続します。

## 起動

```bash
docker compose up -d --build
```

フロントエンドのDockerビルド時に、CSSとJavaScriptは
`style.<内容ハッシュ>.css`、`app.<内容ハッシュ>.js`へ自動変換されます。
HTML内の参照も同時に更新されるため、手動でバージョン番号を変更する必要はありません。

状態確認:

```bash
docker compose ps
```

ログ確認:

```bash
docker compose logs -f frontend backend_python backend_elixir backend_php backend_java backend_go backend_ruby
```

停止:

```bash
docker compose down
```

## ブラウザアクセス

- トップ: <http://localhost:8082/>
- 検索: <http://localhost:8082/search?q=Elasticsearch>
- タグ絞り込み: <http://localhost:8082/?tag=Elasticsearch>
- 全記事一覧: <http://localhost:8082/all>
- 稼働状況: <http://localhost:8082/health>
- 記事詳細: `http://localhost:8082/articles/<article_id>`

NginxのSPAフォールバックにより、検索・記事詳細URLを直接開いても表示できます。

画面右上のBackendセレクターで次を選べます。

- `Python :5020`
- `Elixir :5021`
- `PHP :5022`
- `Java :5023`
- `Go :5024`
- `Ruby :5025`

切り替えると現在の画面を選択したバックエンドから再取得します。

## API仕様

### ヘルスチェック

```http
GET /health
```

各バックエンドプロセスの稼働状態を返します。

### Elasticsearchヘルスチェック

```http
GET /health/elasticsearch
```

各バックエンドからElasticsearchへの到達性、応答時間、クラスター名、バージョンを返します。
フロントエンドの稼働状況画面は、6バックエンドを並列チェックし、Elasticsearchは応答可能なバックエンド経由で確認します。画面は5秒ごとに自動更新され、手動更新にも対応します。

### 最近の記事

```http
GET /api/recent?size=10&tag=Elasticsearch
```

`tag` は省略可能です。

### 記事検索

```http
GET /api/search?q=Elasticsearch&page=1&size=10
```

レスポンス:

```json
{
  "total": 10,
  "page": 1,
  "size": 10,
  "results": []
}
```

### 全記事一覧

```http
GET /api/articles?page=1&size=20
```

作成日の降順で記事を返します。

### 記事詳細

```http
GET /api/articles/<article_id>
```

### リンクプレビュー

```http
GET /api/link-preview?url=https://qiita.com/...
```

## バックエンドAPI互換契約

新しいバックエンドで以下のHTTP契約を維持します。

- `GET /health`
- `GET /health/elasticsearch`
- `GET /api/recent`
- `GET /api/search`
- `GET /api/articles`
- `GET /api/articles/<article_id>`
- `GET /api/link-preview`
- JSONレスポンスのフィールド構造
- frontend Originに対するCORSヘッダー
- Python版は5020、Elixir版は5021、PHP版は5022、Java版は5023、Go版は5024、Ruby版は5025
- `frontend/static/app.js` の `BACKENDS` に対応するURL

フロントエンドは選択されたポート以外、バックエンドの実装言語やElasticsearchクライアントを認識しません。

## Elasticsearchドキュメント

```json
{
  "title": "記事タイトル",
  "body": "記事本文",
  "tags": ["hadoop", "elasticsearch"],
  "url": "https://qiita.com/...",
  "created_at": "2026-06-01T00:00:00+09:00",
  "updated_at": "2026-06-01T00:00:00+09:00"
}
```

タグの完全一致検索を安定させるには、`tags.keyword`を持つマッピングを推奨します。

## Dockerネットワーク

Elasticsearchが別Compose構成のコンテナで、`ES_URL=http://elastic1:9200` のようにコンテナ名で接続する場合、backendとElasticsearchを同じDockerネットワークへ参加させます。

```yaml
services:
  backend_python:
    networks:
      - default
      - elastic
  backend_elixir:
    networks:
      - default
      - elastic
  backend_php:
    networks:
      - default
      - elastic
  backend_java:
    networks:
      - default
      - elastic
  backend_go:
    networks:
      - default
      - elastic
  backend_ruby:
    networks:
      - default
      - elastic

networks:
  default:
  elastic:
    external: true
```

Docker Desktop上のホストへ接続する場合:

```env
ES_URL=http://host.docker.internal:9200
```

## テスト

```bash
docker compose build

docker compose run --rm backend_python \
  python -m unittest discover \
  -s backend_python/tests \
  -p 'test_backend.py' \
  -v

docker compose build backend_elixir backend_php backend_java backend_go backend_ruby
```

Elixir版はDockerビルド中にExUnitを実行します。
Go版はDockerビルド中に `go test` を実行します。PHP、Java、Ruby版もDockerビルド中に構文・コンパイル検証を行います。

フロントエンドがPythonを含まないことは次で確認できます。

```bash
docker run --rm qiita_elastic_app-frontend:latest sh -c \
  'if command -v python || command -v python3; then exit 1; else echo "Python is not installed"; fi'
```

## トラブルシューティング

### 画面にAPI接続エラーが表示される

```bash
curl http://localhost:5020/health
curl http://localhost:5021/health
curl http://localhost:5022/health
curl http://localhost:5023/health
curl http://localhost:5024/health
curl http://localhost:5025/health
docker compose logs backend_python backend_elixir backend_php backend_java backend_go backend_ruby
```

### CORSエラーになる

`.env`の `CORS_ORIGINS` に実際のフロントエンドOriginを追加します。

```env
CORS_ORIGINS=http://localhost:8082,http://example.local:8082
```

変更後:

```bash
docker compose up -d --force-recreate backend_python backend_elixir backend_php backend_java backend_go backend_ruby
```

### インデックスが見つからない

```bash
curl 'http://elastic1:9200/_cat/indices?v'
```

実在するインデックス名を `.env` の `ES_INDEX` に設定してください。
