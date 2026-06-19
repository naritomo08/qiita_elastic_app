# Qiita Article Search

Elasticsearchへ投入済みのQiita記事を検索・閲覧するWebアプリです。

フロントエンドはPythonを使用しない静的HTML/CSS/JavaScript SPA、バックエンドは独立したREST APIです。両者はJSON APIだけで接続し、6言語の実装を同じ画面から切り替えられます。

## アーキテクチャ

```text
ブラウザ
  └── http://localhost:8082
        └── frontend: Nginx + HTML/CSS/JavaScript
              ├── /api/python/*  ── backend_python:5020
              ├── /api/elixir/* ── backend_elixir:5021
              ├── /api/php/*    ── backend_php:5022
              ├── /api/java/*   ── backend_java:5023
              ├── /api/go/*     ── backend_go:5024
              └── /api/ruby/*   ── backend_ruby:5025
                                         │
                                         ▼
                                   Elasticsearch
```

- frontend
  - Nginxで静的ファイルを配信
  - Dockerビルド時にCSS/JavaScriptへ内容ハッシュを付与
  - Python不使用
  - Jinja2などのサーバーサイドテンプレート不使用
  - `/api/<言語>/...` と `/health/<言語>` を各backendへリバースプロキシ
  - ブラウザからはfrontendと同じOriginだけへ接続
- backend_python / backend_elixir / backend_php / backend_java / backend_go / backend_ruby
  - Elasticsearch検索と記事取得
  - OGPリンクプレビュー取得
  - JSONだけを返すREST API
  - Docker Composeネットワーク内だけでAPIを提供
- フロントのBackendセレクターで6言語のバックエンドを切り替え
- 選択したバックエンドはブラウザのLocal Storageへ保存

## ポート

外部へ公開する必要があるのはfrontendの8082番ポートだけです。
バックエンドの5020〜5025番ポートはDocker Composeネットワーク内でのみ使用します。

| サービス | 動作確認URL |
|---|---|
| フロントエンド | <http://localhost:8082> |
| Pythonバックエンド | <http://localhost:8082/health/python> |
| Elixirバックエンド | <http://localhost:8082/health/elixir> |
| PHPバックエンド | <http://localhost:8082/health/php> |
| Javaバックエンド | <http://localhost:8082/health/java> |
| Goバックエンド | <http://localhost:8082/health/go> |
| Rubyバックエンド | <http://localhost:8082/health/ruby> |

## ディレクトリ構成

```text
.
├── frontend/
│   ├── Dockerfile
│   ├── build-assets.sh
│   ├── nginx.conf
│   ├── proxy_params
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
├── loadtest/
│   ├── Dockerfile
│   ├── run.py
│   ├── test.js
│   └── results/
├── metrics/
│   ├── Dockerfile
│   ├── main.py
│   └── test_main.py
├── docker-compose.yml
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

ブラウザはfrontendと同じOriginの `/api/<言語>/...` へ接続し、Nginxが
Docker Compose内の各バックエンドへ転送します。そのため、通常利用では
バックエンド用のCORS設定や5020〜5025番ポートの外部公開は不要です。

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
記事詳細URLの `<article_id>` は、検索結果や全記事一覧に含まれる実際の記事IDへ
置き換えてください。

画面右上のBackendセレクターで次を選べます。

- `Python`
- `Elixir`
- `PHP`
- `Java`
- `Go`
- `Ruby`

切り替えると現在の画面を選択したバックエンドから再取得します。

## API仕様

### ヘルスチェック

```http
GET /health/<backend>
```

例: `GET /health/python`

frontendのNginxが、選択したバックエンドの `/health` へ転送します。

### Elasticsearchヘルスチェック

```http
GET /health/<backend>/elasticsearch
```

各バックエンドからElasticsearchへの到達性、応答時間、クラスター名、バージョンを返します。
フロントエンドの稼働状況画面は、6バックエンドを並列チェックし、Elasticsearchは応答可能なバックエンド経由で確認します。さらにDocker Engineから各バックエンドとフロントエンド自身のCPU・メモリ使用量を取得します。画面は5秒ごとに自動更新され、手動更新にも対応します。

コンテナ統計の取得にはDockerソケットを監視APIコンテナへマウントします。監視APIはCompose内にだけ配置し、統計取得用のGET処理だけを実装しています。Dockerソケットは強い権限を持つため、このAPIを外部へ直接公開しないでください。標準パス以外を利用する場合は、`DOCKER_SOCKET` にホスト側のソケットパスを設定してください。

### 最近の記事

```http
GET /api/<backend>/recent?size=10&tag=Elasticsearch
```

例: `GET /api/python/recent?size=10`

`backend` は `python`、`elixir`、`php`、`java`、`go`、`ruby` のいずれかです。
`tag` は省略可能です。

### 記事検索

```http
GET /api/<backend>/search?q=Elasticsearch&page=1&size=10
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
GET /api/<backend>/articles?page=1&size=20
```

作成日の降順で記事を返します。

### 記事詳細

```http
GET /api/<backend>/articles/<article_id>
```

### リンクプレビュー

```http
GET /api/<backend>/link-preview?url=https://qiita.com/...
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
- frontend Nginxの `/api/<言語>/...` と `/health/<言語>` に対応する転送設定

フロントエンドは選択された言語のプロキシパス以外、バックエンドの実装や
Elasticsearchクライアントを認識しません。

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

## 負荷試験

`loadtest`プロファイルには、k6によるHTTP負荷試験とコンテナリソースの
定期収集が含まれています。試験対象にはfrontend経由のURLまたは
Composeネットワーク内のバックエンドURLを指定できます。

負荷試験中は既存の`metrics`サービスから、このComposeプロジェクトに属する
コンテナのCPU使用率とメモリ使用量を2秒ごとに取得します。
Elasticsearchのリソース情報は収集しません。

### 基本的な実行方法

最初にアプリケーションを起動します。

```bash
docker compose up -d --build
```

frontendのNginxを経由してPythonバックエンドへ、20仮想ユーザーで1分間
負荷をかける例です。

```bash
TARGET_URL=http://frontend:8082/api/python \
docker compose --profile loadtest run --rm loadtest
```

ユーザー数と実行時間を指定する例:

```bash
TARGET_URL=http://frontend:8082/api/go \
VUS=50 \
DURATION=2m \
SCENARIO=search \
docker compose --profile loadtest run --rm loadtest
```

### 段階的な負荷

`STAGES`を指定すると、一定負荷の`VUS`と`DURATION`の代わりに、
仮想ユーザー数を段階的に増減できます。形式は
`継続時間:目標ユーザー数`のカンマ区切りです。

```bash
TARGET_URL=http://frontend:8082/api/python \
STAGES=30s:10,1m:50,1m:100,30s:0 \
docker compose --profile loadtest run --rm loadtest
```

### 試験シナリオ

`SCENARIO`には次の値を指定できます。

| 値 | リクエスト |
|---|---|
| `mixed` | 検索60%、記事一覧25%、最近の記事15% |
| `search` | `/api/search`のみ |
| `articles` | `/api/articles`のみ |
| `recent` | `/api/recent`のみ |

検索語は`SEARCH_QUERY`で変更できます。

```bash
TARGET_URL=http://frontend:8082/api/elixir \
SCENARIO=search \
SEARCH_QUERY=Docker \
docker compose --profile loadtest run --rm loadtest
```

### 設定値

| 変数 | デフォルト | 説明 |
|---|---:|---|
| `TARGET_URL` | 必須 | frontend経由の `/api/<backend>` またはバックエンドのベースURL |
| `SCENARIO` | `mixed` | 試験シナリオ |
| `SEARCH_QUERY` | `Elasticsearch` | 検索シナリオの検索語 |
| `VUS` | `20` | 同時仮想ユーザー数 |
| `DURATION` | `1m` | 一定負荷の実行時間 |
| `STAGES` | 未指定 | 段階負荷。指定時は`VUS`と`DURATION`を使用しない |
| `SLEEP_SECONDS` | `0.2` | 仮想ユーザーごとのリクエスト間隔 |
| `REQUEST_TIMEOUT` | `10s` | HTTPリクエストのタイムアウト |
| `MAX_ERROR_RATE` | `0.01` | 許容する失敗率。`0.01`は1% |
| `P95_LIMIT_MS` | `1000` | p95応答時間の合格上限（ミリ秒） |
| `METRICS_INTERVAL` | `2` | コンテナ情報の取得間隔（秒） |

### 保存される結果

実行ごとに`loadtest/results/YYYYMMDD-HHMMSS-ffffff/`を作成します。

```text
loadtest/results/20260620-150000-123456/
├── summary.txt
├── k6-summary.json
├── k6-output.txt
└── container-metrics.csv
```

- `summary.txt`
  - リクエスト数、RPS、失敗率
  - 平均、中央値、p90、p95、p99、最大応答時間
  - 各コンテナの平均・最大CPU使用率
  - 各コンテナの平均・最大メモリ使用量
- `k6-summary.json`
  - k6の集計結果
- `k6-output.txt`
  - 実行中に表示されたk6出力
- `container-metrics.csv`
  - 時系列のコンテナCPU・メモリ情報

試験結果ディレクトリは`.gitignore`の対象です。
結果はホスト側の一般ユーザーから削除できるよう、ディレクトリを`775`、
ファイルを`664`相当の権限で作成します。Dockerのuser namespace設定によって
所有者が`nobody:nobody`と表示される場合でも、グループ権限で整理できます。

負荷試験は管理権限のある環境に対してのみ実行し、最初は小さい
`VUS`または`STAGES`から開始してください。

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
curl http://localhost:8082/health/python
curl http://localhost:8082/health/elixir
curl http://localhost:8082/health/php
curl http://localhost:8082/health/java
curl http://localhost:8082/health/go
curl http://localhost:8082/health/ruby
docker compose logs backend_python backend_elixir backend_php backend_java backend_go backend_ruby
```

### CORSエラーになる

通常のブラウザアクセスはfrontendのNginxを経由する同一Origin通信なので、
CORS設定は不要です。開発時などにバックエンドへ直接アクセスする場合だけ、
`.env`の `CORS_ORIGINS` に実際のフロントエンドOriginを追加します。

```env
CORS_ORIGINS=http://localhost:8082,http://example.local:8082
```

変更後:

```bash
docker compose up -d --force-recreate backend_python backend_elixir backend_php backend_java backend_go backend_ruby
```

### インデックスが見つからない

`elastic1` はCompose内または設定済みのコンテナから解決する名前です。
ホスト端末から直接 `curl http://elastic1:9200/...` を実行する代わりに、
バックエンドコンテナ内から確認します。

```bash
docker compose exec backend_python python -c \
  "import urllib.request; print(urllib.request.urlopen('http://elastic1:9200/_cat/indices?v').read().decode())"
```

実在するインデックス名を `.env` の `ES_INDEX` に設定してください。
