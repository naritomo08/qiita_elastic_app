# Load test

k6 で API に負荷をかけながら、`metrics` コンテナから各サービスの CPU・メモリ使用量を収集します。実行結果は `results/` 以下へ保存します。

## ファイル構成

```text
loadtest/
├── Dockerfile              # k6 と Python ランナーを含むイメージ
├── test.js                 # k6 シナリオ、閾値、リクエスト選択
├── run.py                  # 実行ディレクトリ作成、k6 起動、終了制御
├── config.py               # パスとメトリクス接続設定
├── metrics_collector.py    # コンテナメトリクスの定期収集と CSV 出力
├── report.py               # k6 結果とリソース使用量の集計・レポート生成
└── results/
    └── .gitkeep            # ホストへ保存する結果ディレクトリ
```

## 主な設定

- `TARGET_URL`: 負荷試験対象。必須
- `SCENARIO`: `mixed`、`search`、`articles`、`recent`
- `VUS` / `DURATION`: 同時実行数と試験時間
- `STAGES`: `30s:10,1m:50` 形式の段階負荷
- `METRICS_URL` / `METRICS_INTERVAL`: メトリクス取得先と間隔
- `MAX_ERROR_RATE` / `P95_LIMIT_MS`: k6 の合格閾値

## 実行方法

```sh
TARGET_URL=http://frontend:8082 \
docker compose --profile loadtest run --rm --build loadtest
```

結果ディレクトリには `k6-summary.json`、`k6-output.txt`、`container-metrics.csv`、`summary.txt` が作成されます。結果ディレクトリ名とレポート内の日時は JST（UTC+09:00）で出力されます。
