# Java backend

Java 21 の組み込み HTTP サーバーで動作する記事検索 API です。Maven で実行可能 JAR を作成します。

## ファイル構成

```text
backend_java/
├── Dockerfile
├── pom.xml                         # Maven 設定と依存関係
└── src/main/java/app/qiita/
    ├── Main.java                   # 起動、ルーティング、共通 HTTP 処理
    ├── ElasticsearchService.java   # Elasticsearch 通信と記事検索
    ├── LinkPreviewService.java     # URL 検証とリンクプレビュー取得
    └── ApiException.java           # HTTP ステータス付き API 例外
```

## 主な設定

- `ES_URL`: Elasticsearch の URL
- `ES_INDEX`: 記事インデックス名

## 確認方法

```sh
cd backend_java
mvn test
mvn package
```
