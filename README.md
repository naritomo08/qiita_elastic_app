# Qiita Article Search

Elasticsearchへ投入済みのQiita記事を検索・閲覧するWebアプリです。

フロントエンドはPythonを使用しない静的HTML/CSS/JavaScript SPA、バックエンドは独立したREST APIです。両者はJSON APIだけで接続し、6言語の実装を同じ画面から切り替えられます。

事前に以下リンク先を参考にElasticSearch構築と、Qiita記事のElasticSearch取り込みを実施していること。

https://qiita.com/naritomo08/items/8368c2f57803e471cc2f

https://github.com/naritomo08/qiita_to_elastic

## アーキテクチャ

```text
ブラウザ
  └── http://localhost:8082
        └── frontend: Nginx + HTML/CSS/JavaScript
              ├── /api/python/*  ── backend_python:5000
              ├── /api/elixir/* ── backend_elixir:5000
              ├── /api/php/*    ── backend_php:5000
              ├── /api/java/*   ── backend_java:5000
              ├── /api/go/*     ── backend_go:5000
              └── /api/ruby/*   ── backend_ruby:5000
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
バックエンドの5000番ポートはDocker Composeネットワーク内でのみ使用します。

| サービス | 動作確認URL |
|---|---|
| フロントエンド | <http://localhost:8082> |
| Pythonバックエンド | <http://localhost:8082/health/python> |
| Elixirバックエンド | <http://localhost:8082/health/elixir> |
| PHPバックエンド | <http://localhost:8082/health/php> |
| Javaバックエンド | <http://localhost:8082/health/java> |
| Goバックエンド | <http://localhost:8082/health/go> |
| Rubyバックエンド | <http://localhost:8082/health/ruby> |

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
- アクセスログの閲覧・CSVダウンロード

## 環境変数

```env
ES_URL=http://elastic1:9200
ES_INDEX=qiita-articles
```

| 変数 | 説明 |
|---|---|
| `ES_URL` | Elasticsearch接続先 |
| `ES_INDEX` | 記事インデックス |

ブラウザはfrontendと同じOriginの `/api/<言語>/...` へ接続し、Nginxが
Docker Compose内の各バックエンドへ転送します。各バックエンドの待受先と
5000番ポートは各バックエンドコンテナ内で共通して使用され、外部には公開されません。

## 起動

```bash
cp .env.example .env
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

アクセスログのメタ情報に載せるDockerホスト名は、ホスト側の`/etc/hostname`を監視APIコンテナへ読み取り専用でマウントして取得します（コンテナ自身のホスト名ではなく、Dockerを動かしている物理/VMホストの名前を識別するため）。標準パス以外を利用する場合は、`HOST_HOSTNAME_PATH` にホスト側の`hostname`ファイルパスを設定してください。

### アクセスログ

```http
GET /api/access-logs?tail=100
GET /api/access-logs?full=1
GET /api/access-logs?date=2026-06-19&full=1
```

frontendのNginxは、ブラウザから実際に届いたリクエストだけを`access_json`形式でログ出力し、稼働状況画面の「アクセスログ」セクションに表示します。ヘルスチェックやコンテナメトリクスの取得など、画面が自動で行う監視系リクエスト（`/health*`、`/api/container-metrics`、`/api/access-logs`自身）はNginxの`map`でログ出力自体から除外しているため、実際の利用者操作だけが残ります。

ログはDockerの名前付きボリューム`frontend_access_logs`へ、JSTの日付ごとの
`access-YYYY-MM-DD.jsonl`として保存します。`date`省略時は当日（JST）が対象になります。
frontendコンテナを再作成しても名前付きボリュームは残るため、Docker logging driverの
ローカルキャッシュ保持量には依存しません。

| パラメータ | 説明 |
|---|---|
| `tail` | 直近N件を取得（省略時200、最大1000）。稼働状況画面の自動更新（5秒ごと）で使用 |
| `full=1` | 対象日分を全件取得。CSVダウンロードとElasticsearch投入で使用 |
| `date` | 取得対象日を`YYYY-MM-DD`（JST）で指定。省略時は当日。不正な値（`abc`、`2026/06/20`、`2026-13-99`など）はHTTP 400 |

`date`に対応する日次ファイルだけを読み込むため、他の日付のログを走査しません。日次の
Elasticsearch投入バッチは、当日分の取り込み漏れ・バッチ失敗時の再投入・
Elasticsearch再構築時の過去データ復旧・cron停止時の欠損を、`date`を指定して
該当日を再取得することで埋め合わせできます。

Nginxは同じ`access_json`を標準出力と永続ボリュームへ二重出力します。標準出力は従来どおり
Dockerのsyslog logging driverへ送られ、`metrics`サービスは永続ボリュームを読み取り専用で
マウントしてAPIレスポンスを構築します。API取得元とsyslog配送経路が分離されているため、
syslogサーバーやDockerログキャッシュの状態でAPIの過去ログが欠落しません。

#### syslog logging driverのホスト設定

`docker-compose.yml`の`frontend.logging`は、Dockerホスト上の
`127.0.0.1:514/TCP`へログを送信します。この設定を使用する場合は、コンテナを起動する前に
ホスト上でrsyslogなどをTCP 514番で待ち受けさせてください。送信先へ接続できない場合、
Dockerがlogging driverを初期化できず、frontendコンテナの作成・起動に失敗することがあります。

Ubuntu/Debian系でrsyslogを使用する場合の設定例です。

```bash
sudo apt-get install rsyslog
sudo tee /etc/rsyslog.d/30-docker-tcp.conf >/dev/null <<'EOF'
module(load="imtcp")
input(type="imtcp" address="127.0.0.1" port="514")
EOF
sudo systemctl restart rsyslog
sudo systemctl enable rsyslog
```

TCP 514番の待ち受けを確認します。

```bash
sudo ss -lntp | grep ':514'
```

`127.0.0.1`だけで待ち受けるため、この用途ではホストのファイアウォールで514番を外部へ
開放する必要はありません。ログの保存先や振り分けは、利用環境のrsyslog設定に合わせて
必要に応じて追加してください。

syslog転送を使用しない場合は、`docker-compose.yml`の`frontend`から次の部分を削除して
ください。

```yaml
    logging:
      driver: syslog
      options:
        syslog-address: "tcp://127.0.0.1:514"
        tag: "{{.Name}}"
```

削除後にfrontendコンテナを再作成すると、Dockerの既定logging driverが使用されます。

```bash
docker compose up -d --force-recreate frontend
```

syslog設定を削除しても、アクセスログは引き続き名前付きボリューム
`frontend_access_logs`へ保存されるため、稼働状況画面のログ表示には影響しません。

永続ログは`access_log_maintenance`サービスが1時間ごとに確認し、標準では最終更新から
14日（14×24時間）以上経過した日次ファイルを削除します。実際の削除は14日経過後の
次回確認時（最大約1時間後）に行われます。保持日数はCompose起動時に
`ACCESS_LOG_RETENTION_DAYS`で変更できます。

```bash
ACCESS_LOG_RETENTION_DAYS=30 docker compose up -d
```

`metrics`サービスはCompose内に閉じているため、外部システムから取得する場合はfrontendの
8082番ポートへ直接アクセスします。

各ログレコードは以下のように加工されます。

* `time` → `@timestamp`（Elasticsearch/Kibanaの既定フィールド名に合わせる）
* `dt`: そのレコードの`@timestamp`から日付部分（`YYYY-MM-DD`）を切り出した、日付パーティション用キー
* `service` / `host` / `container`: ログを出したサービス名・Dockerホスト名・コンテナ名を、レコード単体でも追跡できるように付与

レスポンス全体にも`date`（対象日。`date`パラメータ省略時はJSTでの当日日付）、`count`（`logs`件数）、`host`、`container`を付与しています。

```json
{
  "status": "ok",
  "service": "frontend",
  "host": "elastic1",
  "container": "qiita-search-frontend",
  "date": "2026-06-20",
  "count": 1,
  "logs": [
    {
      "@timestamp": "2026-06-20T21:18:20+09:00",
      "dt": "2026-06-20",
      "service": "frontend",
      "host": "elastic1",
      "container": "qiita-search-frontend",
      "remote_addr": "203.0.113.42",
      "method": "GET",
      "uri": "/api/go/search?q=foo",
      "status": 200,
      "body_bytes_sent": 512,
      "request_time": 0.012,
      "upstream_addr": "172.19.0.5:5000",
      "user_agent": "curl/8.0"
    }
  ]
}
```

```bash
curl -s "http://localhost:8082/api/access-logs?full=1" | jq '.logs'
```

CSVへ変換する場合:

```bash
curl -s "http://localhost:8082/api/access-logs?full=1" \
  | jq -r '.logs[] | [."@timestamp",.remote_addr,.method,.uri,.status,.body_bytes_sent,.request_time,.upstream_addr,.user_agent] | @csv'
```

Elasticsearchへ投入する場合は、`logs`配列の各要素をそのまま1ドキュメントとしてbulk登録できます（`@timestamp`済みなので日付フィルタやKibanaのタイムフィールドにそのまま使え、`dt`をインデックス名やIcebergのパーティション列に使えます）。

```bash
curl -s "http://localhost:8082/api/access-logs?full=1" | jq -c '.logs[] | {index: {_index: "access-logs-" + .dt}}, .' \
  | curl -s -H "Content-Type: application/x-ndjson" -XPOST "http://elastic1:9200/_bulk" --data-binary @-
```

稼働状況画面では対象日を指定して「表示」を押すと、その日の直近200件を表示します。
5秒ごとの自動更新と「CSVダウンロード」は同じ対象日を使用し、CSVは対象日を
`date`に指定した`full=1`の結果を、UTF-8 BOM付き・JST表記で全件ダウンロードします。

過去日分を再投入する場合（バッチ失敗時の再実行やElasticsearch再構築時の復旧）は`date`を指定します。

```bash
curl -s "http://localhost:8082/api/access-logs?date=2026-06-19&full=1" \
  | jq -c '.logs[] | {index: {_index: "access-logs-" + .dt}}, .' \
  | curl -s -H "Content-Type: application/x-ndjson" -XPOST "http://elastic1:9200/_bulk" --data-binary @-
```

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

## バックエンドAPI互換規約

新しいバックエンドで以下のHTTP規約を維持します。

- `GET /health`
- `GET /health/elasticsearch`
- `GET /api/recent`
- `GET /api/search`
- `GET /api/articles`
- `GET /api/articles/<article_id>`
- `GET /api/link-preview`
- JSONレスポンスのフィールド構造
- すべてのバックエンドはコンテナ内の5000番ポートを使用
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

k6のリクエストには`X-Load-Test: 1`ヘッダーが自動で付与されます。frontendの
Nginxはこのヘッダーを識別し、負荷試験のリクエストをアクセスログへ記録しません。
バックエンドURLを直接指定した場合もヘッダーは付与されますが、この除外設定は
frontendのNginxアクセスログだけが対象です。

### 基本的な実行方法

最初にアプリケーションを起動します。

```bash
docker compose up -d --build
```

frontendのNginxを経由してPythonバックエンドへ、20仮想ユーザーで1分間
負荷をかける例です。

```bash
TARGET_URL=http://frontend:8082/api/python \
docker compose --profile loadtest run --rm --build loadtest
```

ユーザー数と実行時間を指定する例:

```bash
TARGET_URL=http://frontend:8082/api/go \
VUS=50 \
DURATION=2m \
SCENARIO=search \
docker compose --profile loadtest run --rm --build loadtest
```

### 段階的な負荷

`STAGES`を指定すると、一定負荷の`VUS`と`DURATION`の代わりに、
仮想ユーザー数を段階的に増減できます。形式は
`継続時間:目標ユーザー数`のカンマ区切りです。

```bash
TARGET_URL=http://frontend:8082/api/python \
STAGES=30s:10,1m:50,1m:100,30s:0 \
docker compose --profile loadtest run --rm --build loadtest
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
docker compose --profile loadtest run --rm --build loadtest
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
ディレクトリ名と`summary.txt`、`container-metrics.csv`内の日時はJSTです。

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
  - JSTのタイムスタンプ付きの、時系列のコンテナCPU・メモリ情報

試験結果ディレクトリは`.gitignore`の対象です。
結果はホスト側の一般ユーザーから削除できるよう、ディレクトリを`777`、
ファイルを`666`相当の権限で作成します。Dockerのuser namespace設定によって
所有者が`nobody:nobody`と表示される環境でも整理できます。この設定は
`.gitignore`対象の負荷試験結果だけに適用されます。

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

### インデックスが見つからない

`elastic1` はCompose内または設定済みのコンテナから解決する名前です。
ホスト端末から直接 `curl http://elastic1:9200/...` を実行する代わりに、
バックエンドコンテナ内から確認します。

```bash
docker compose exec backend_python python -c \
  "import urllib.request; print(urllib.request.urlopen('http://elastic1:9200/_cat/indices?v').read().decode())"
```

実在するインデックス名を `.env` の `ES_INDEX` に設定してください。

## おまけ情報

`omake/` フォルダには、本アプリのアクセスログを検索・分析用途へ活用するための補足手順を置いています。アプリの起動には必須ではありませんが、アクセスログを Elasticsearch や Iceberg に連携して、Kibana や分析基盤で確認したい場合の参考資料です。

| ファイル | 概要 |
|---|---|
| `omake/readme1.md` | frontend のアクセスログAPIから日次ログを取得し、Elasticsearch Data Stream `logs-access` へ投入する手順。ILM、インデックステンプレート、再実行可能な取り込みシェル、cron例を含みます。 |
| `omake/readme2.md` | syslog 側に蓄積された nginx JSONログを Spark SQL で整形し、Iceberg テーブル `hive_prod.logs.nginx_access_curated` へ日次取り込みする手順。件数確認や複数フロントエンド向けの実行例も含みます。 |
| `omake/readme3.md` | Iceberg の `nginx_access_curated` を正本として、Elasticsearch Data Stream `logs-access-iceberg` へ連携する手順。Kibana Data View 登録や ILM による保持期間管理の運用イメージをまとめています。 |
