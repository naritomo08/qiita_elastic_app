# Metrics

Docker Engine API から Compose プロジェクト内の CPU・メモリ指標を取得し、フロントエンドの永続アクセスログも JSON API として公開します。

## ファイル構成

```text
metrics/
├── Dockerfile
├── main.py                 # HTTP サーバーの起動
├── config.py               # 環境変数、定数、ホスト名の解決
├── http_server.py          # `/health`、`/metrics`、`/logs` の処理
├── docker_api.py           # Unix Socket 経由の Docker Engine API 通信
├── container_metrics.py    # コンテナ一覧、CPU、メモリ指標の計算
├── access_logs.py          # 日付別ログの読み込み、検証、JSON 整形
└── test_main.py            # 指標計算とログ処理のユニットテスト
```

## 主な設定

- `DOCKER_SOCKET`: Docker Socket のパス
- `PROJECT_NAME`: 対象の Compose プロジェクト名
- `PORT`: HTTP 待受ポート
- `HOST_HOSTNAME_FILE`: Docker ホスト名を読むファイル
- `ACCESS_LOG_DIR`: フロントエンドのアクセスログディレクトリ

## API

- `GET /health`
- `GET /metrics`
- `GET /logs?service=frontend&date=YYYY-MM-DD&tail=200`
- `GET /logs?service=frontend&date=YYYY-MM-DD&full=1`

## 確認方法

```sh
cd metrics
python3 -m unittest -v test_main.py
python3 -m py_compile *.py
```
