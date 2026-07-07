# Frontend

Vue + Vite でビルドした検索画面を Nginx で配信し、各言語のバックエンド、メトリクス API、アクセスログ API へのリバースプロキシも担当します。

## ファイル構成

```text
frontend/
├── Dockerfile                       # Viteビルドと Nginx イメージ作成
├── index.html                       # Vite の HTML エントリーポイント
├── package.json                     # Vue + Vite の依存関係と npm scripts
├── vite.config.js                   # Vite 設定
├── src/
│   ├── App.vue                      # Vue のルートコンポーネント
│   ├── main.js                      # Vue アプリのエントリーポイント
│   └── legacy/                      # 既存SPAロジックを Vite 管理下へ移したコード
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

ローカルで Node.js が利用できる場合は、フロントエンドだけを Vite dev server で起動できます。

```sh
cd frontend
npm install
npm run dev
```
