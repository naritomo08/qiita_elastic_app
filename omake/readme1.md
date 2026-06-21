# app→Elastic取り込みシェル導入

## 初期設定シェル設置、実行(14日ローテーションも実施)

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

## アクセスログ取り込みシェル設置

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

以下コマンドで実行(日付指定しなければ前日文を取り込む。)

```bash
/opt/elastic/bin/import_accesslog_to_es.sh yyyy-mm-dd
```

## 取り込みシェル定期実行

```bash
sudo tee /etc/cron.d/accesslog_to_es >/dev/null <<'EOF'
5 0 * * * root /opt/elastic/bin/import_accesslog_to_es.sh >> /var/log/import_accesslog_to_es.log 2>&1
EOF
```
