# Frontend

静的な検索画面を Nginx で配信し、各言語のバックエンド、メトリクス API、アクセスログ API へのリバースプロキシも担当します。

## ファイル構成

```text
frontend/
├── Dockerfile                       # 静的資産のビルドと Nginx イメージ作成
├── index.html                       # 画面の HTML
├── static/
│   ├── js/                          # ルーティング、ページ、部品、共通処理
│   ├── css/                         # 共通、記事本文、監視画面、レスポンシブ
│   └── style.css                    # 分割CSSのエントリーポイント
├── build-assets.sh                  # CSS/JS のハッシュ付きファイル名生成
├── nginx.conf                       # 配信、API プロキシ、アクセスログ設定
├── proxy_params                     # バックエンド共通のプロキシヘッダー
└── 05-init-access-log-volume.sh     # アクセスログ用ボリュームの初期化
```

## 公開先

- 画面: `http://localhost:8082/`
- バックエンド API: `/api/{python|elixir|php|java|go|ruby}/`
- コンテナメトリクス: `/api/container-metrics`
- アクセスログ: `/api/access-logs`

## 確認方法

```sh
docker compose build frontend
docker compose up frontend
```

`static/js/app.js` はブラウザ標準の ES Modules、`static/style.css` は CSS の `@import` を使って分割しています。Node.js やバンドラーは不要です。
