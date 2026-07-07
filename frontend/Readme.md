# Frontend

Svelte/Vite でビルドした検索画面を Nginx で配信し、各言語のバックエンド、メトリクス API、アクセスログ API へのリバースプロキシも担当します。

## ファイル構成

```text
frontend/
├── Dockerfile                       # 静的資産のビルドと Nginx イメージ作成
├── index.html                       # Vite の HTML エントリーポイント
├── package.json                     # Svelte/Vite の依存関係と npm scripts
├── vite.config.js                   # Vite 設定
├── src/
│   ├── App.svelte                   # ルーティングと共通レイアウト
│   ├── routes/                      # 各画面の Svelte コンポーネント
│   ├── components/                  # 画面部品
│   └── lib/                         # API、状態、整形、Markdown 補助
├── static/
│   ├── css/                         # 共通、記事本文、監視画面、レスポンシブ
│   └── style.css                    # CSS のエントリーポイント
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

ローカルに Node.js がある場合は、フロントエンドだけを Vite dev server で起動できます。

```sh
cd frontend
npm install
npm run dev
```

Vite dev server は `/api` と `/health` を `http://localhost:8082` にプロキシします。Docker イメージでは `npm run build` の `dist/` を Nginx にコピーして配信します。
