# Go backend

標準の `net/http` で動作する記事検索 API です。

## ファイル構成

```text
backend_go/
├── Dockerfile          # テスト、静的バイナリのビルド、実行イメージ作成
├── go.mod              # Go モジュール定義
├── main.go             # サーバー起動、ルーティング、HTTP ハンドラー
├── elasticsearch.go    # Elasticsearch 通信と検索結果の変換
├── linkpreview.go      # URL 検証とリンクプレビュー取得
├── util.go             # JSON 応答、入力値、環境変数などの共通処理
└── main_test.go        # API のユニットテスト
```

## 主な設定

- `ES_URL`: Elasticsearch の URL
- `ES_INDEX`: 記事インデックス名

## 確認方法

```sh
cd backend_go
go test ./...
```
