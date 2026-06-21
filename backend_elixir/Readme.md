# Elixir backend

Plug と Bandit で動作する記事検索 API です。Docker ビルド時にテストを実行し、OTP release を作成します。

## ファイル構成

```text
backend_elixir/
├── Dockerfile
├── mix.exs                              # Mix プロジェクトと依存関係
├── config/
│   └── config.exs                       # 実行時設定
├── lib/qiita_search_backend/
│   ├── application.ex                   # Supervisor と HTTP サーバーの起動
│   ├── router.ex                        # API ルーティングとレスポンス
│   ├── elasticsearch.ex                 # Elasticsearch 通信と記事検索
│   └── link_preview.ex                  # URL 検証とリンクプレビュー取得
└── test/
    ├── test_helper.exs
    └── router_test.exs                  # ルーターのテスト
```

## 主な設定

- `ES_URL`: Elasticsearch の URL
- `ES_INDEX`: 記事インデックス名

## 確認方法

```sh
cd backend_elixir
mix test
```
