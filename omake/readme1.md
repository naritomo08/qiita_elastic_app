# 本サイトのアクセスログを Elasticsearch へ取り込む

本サイトのアクセスログをアクセスログAPIから取得し、
Elasticsearch のデータストリーム `logs-access` へ日次で取り込む手順です。

以下の手順は、Elasticsearchへ接続できるホストで実行してください。

## 前提

- 実行ホストに `bash`、`curl`、`jq` がインストールされていること
- 実行ホストからアクセスログAPIと Elasticsearch のポート `9200` へ接続できること
- `/opt/elastic/bin` へファイルを作成できること

アクセスログAPIの標準の接続先は次のとおりです。

- アクセスログAPI: `http://elastic1:8082/api/access-logs`

## Elasticsearchの初期設定

14日で削除するILMポリシーと、アクセスログ用データストリームの
インデックステンプレートを作成します。

次の初期設定シェルを設置し、実行します。

```bash
sudo tee /opt/elastic/bin/setup_accesslog_datastream.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ES_URL="${ES_URL:-http://elastic1:9200}"

curl -fsS -X PUT "${ES_URL}/_ilm/policy/logs-access-14d-policy" \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "phases": {
        "hot": {
          "actions": {
            "rollover": {
              "max_age": "1d",
              "max_size": "10gb"
            }
          }
        },
        "delete": {
          "min_age": "14d",
          "actions": {
            "delete": {}
          }
        }
      }
    }
  }'

curl -fsS -X PUT "${ES_URL}/_index_template/logs_access_template" \
  -H "Content-Type: application/json" \
  -d '{
    "index_patterns": ["logs-access"],
    "priority": 2000,
    "data_stream": {},
    "template": {
      "settings": {
        "index.lifecycle.name": "logs-access-14d-policy"
      },
      "mappings": {
        "properties": {
          "@timestamp": { "type": "date" },
          "dt": { "type": "keyword" },
          "service": { "type": "keyword" },
          "host": { "type": "keyword" },
          "container": { "type": "keyword" },
          "remote_addr": { "type": "ip" },
          "method": { "type": "keyword" },
          "uri": { "type": "keyword" },
          "status": { "type": "integer" },
          "body_bytes_sent": { "type": "long" },
          "request_time": { "type": "float" },
          "upstream_addr": { "type": "keyword" },
          "user_agent": { "type": "text" }
        }
      }
    }
  }'

echo "[INFO] setup completed."
EOF

chmod 755 /opt/elastic/bin/setup_accesslog_datastream.sh

/opt/elastic/bin/setup_accesslog_datastream.sh
```

## アクセスログ取り込みシェルの設置

アクセスログAPIから指定日または前日分のログを取得し、
Elasticsearchへ登録するシェルを設置します。

同じ日付で再実行した場合は、既存データを削除してから登録し直します。

```bash
sudo tee /opt/elastic/bin/import_accesslog_to_es.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ES_URL="${ES_URL:-http://elastic1:9200}"
API_BASE_URL="${API_BASE_URL:-http://elastic1:8082/api/access-logs}"
DATA_STREAM="${DATA_STREAM:-logs-access}"
LOG_DIR="${LOG_DIR:-/tmp}"

TARGET_DT="${1:-$(date -d 'yesterday' +%F)}"

TMP_JSON="${LOG_DIR}/accesslog_${TARGET_DT}.json"
TMP_JSONL="${LOG_DIR}/accesslog_${TARGET_DT}.jsonl"
TMP_BULK="${LOG_DIR}/accesslog_${TARGET_DT}.bulk"

log() {
  echo "[$(date '+%F %T')] $*"
}

log "[INFO] TARGET_DT=${TARGET_DT}"
log "[INFO] DATA_STREAM=${DATA_STREAM}"

if ! [[ "${TARGET_DT}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  log "[ERROR] TARGET_DT must be YYYY-MM-DD. input=${TARGET_DT}"
  exit 1
fi

API_URL="${API_BASE_URL}?date=${TARGET_DT}&full=1"

log "[INFO] fetch access logs: ${API_URL}"

curl -fsS "${API_URL}" -o "${TMP_JSON}"

STATUS="$(jq -r '.status // empty' "${TMP_JSON}")"

if [ "${STATUS}" != "ok" ]; then
  log "[ERROR] API status is not ok."
  cat "${TMP_JSON}"
  exit 1
fi

jq -c --arg dt "${TARGET_DT}" '
  .logs[]
  | select(.dt == $dt)
' "${TMP_JSON}" > "${TMP_JSONL}"

COUNT="$(wc -l < "${TMP_JSONL}" | tr -d ' ')"

log "[INFO] log_count=${COUNT}"

if [ "${COUNT}" -eq 0 ]; then
  log "[WARN] no logs found. skip import."
  exit 0
fi

# 再実行対策：同じ dt の既存データを削除してから入れ直す
HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" "${ES_URL}/_data_stream/${DATA_STREAM}" || true)"

if [ "${HTTP_CODE}" = "200" ]; then
  log "[INFO] delete existing docs for dt=${TARGET_DT}"

  curl -fsS -X POST "${ES_URL}/${DATA_STREAM}/_delete_by_query?conflicts=proceed&refresh=true" \
    -H "Content-Type: application/json" \
    -d "{
      \"query\": {
        \"term\": {
          \"dt\": \"${TARGET_DT}\"
        }
      }
    }" >/dev/null
else
  log "[INFO] data stream does not exist yet. it will be created by bulk create."
fi

: > "${TMP_BULK}"

while IFS= read -r line; do
  printf '{"create":{"_index":"%s"}}\n' "${DATA_STREAM}" >> "${TMP_BULK}"
  printf '%s\n' "${line}" >> "${TMP_BULK}"
done < "${TMP_JSONL}"

RESULT="$(curl -fsS \
  -H "Content-Type: application/x-ndjson" \
  -X POST "${ES_URL}/_bulk?refresh=true" \
  --data-binary @"${TMP_BULK}")"

ERRORS="$(echo "${RESULT}" | jq -r '.errors')"
ITEMS="$(echo "${RESULT}" | jq '.items | length')"

log "[INFO] bulk_items=${ITEMS}"
log "[INFO] bulk_errors=${ERRORS}"

if [ "${ERRORS}" != "false" ]; then
  log "[ERROR] bulk import failed."
  echo "${RESULT}" | jq '.items[] | select(.create.error != null)'
  exit 1
fi

log "[INFO] import completed."
EOF

chmod 755 /opt/elastic/bin/import_accesslog_to_es.sh
```

## 手動実行

日付を `yyyy-mm-dd` 形式で指定して実行します。

```bash
/opt/elastic/bin/import_accesslog_to_es.sh yyyy-mm-dd
```

日付を省略すると前日分を取り込みます。

```bash
/opt/elastic/bin/import_accesslog_to_es.sh
```

## cronによる定期実行

毎日午前0時5分に前日分を取り込む例です。

```bash
sudo tee /etc/cron.d/accesslog_to_es >/dev/null <<'EOF'
5 0 * * * root /opt/elastic/bin/import_accesslog_to_es.sh >> /var/log/import_accesslog_to_es.log 2>&1
EOF
```

cronを設定する前に、手動実行が成功することを確認してください。

## 補足

- Elasticsearch の標準の接続先は `http://elastic1:9200` です。
- 取り込み先のデータストリームは `logs-access` です。
- 一時ファイルは標準で `/tmp` に作成されます。
- 取り込み対象のログが存在しない場合は、登録処理を行わず正常終了します。
