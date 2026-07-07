# Frontend

React/Vite でビルドした検索画面を Nginx で配信し、各言語のバックエンド、メトリクス API、アクセスログ API へのリバースプロキシも担当します。

## ファイル構成

```text
frontend/
├── Dockerfile                       # 静的資産のビルドと Nginx イメージ作成
├── index.html                       # Vite の HTML エントリーポイント
├── package.json                     # React/Vite の依存関係と npm scripts
├── vite.config.js                   # Vite の開発サーバー設定
├── src/                             # React アプリケーション
├── static/
│   ├── css/                         # 共通、記事本文、監視画面、レスポンシブ
│   └── style.css                    # 分割CSSのエントリーポイント
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

ローカルでフロントエンドだけを開発する場合は、既存の Nginx/frontend コンテナを `8082` で起動したうえで Vite を起動します。

```sh
cd frontend
npm install
npm run dev
```

Vite 開発サーバーは `/api` と `/health` を `http://localhost:8082` へプロキシします。
