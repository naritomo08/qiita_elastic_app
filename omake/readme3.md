# Iceberg AccessLog → Elasticsearch(Data Stream) 連携手順【完全版】

## 概要

本手順では Iceberg に格納された nginx_access_curated テーブルを Elasticsearch Data Stream へ日次バッチ投入する。

構成は以下。

```text
Iceberg
  hive_prod.logs.nginx_access_curated
        ↓
Spark SQL
        ↓
Bulk API
        ↓
Elasticsearch Data Stream
  logs-access-iceberg
        ↓
Kibana
```

特徴

- Icebergを正本として利用
- Elasticsearchは検索用
- Data Stream利用
- ILMによる自動ローテーション
- 14日保持後自動削除
- cronによる定期実行可能

---

# 1. ILMポリシー作成

```bash
curl -X PUT "http://elastic1:9200/_ilm/policy/logs-access-iceberg-policy" \
-H "Content-Type: application/json" \
-d '{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": {
            "max_age": "1d",
            "max_primary_shard_size": "5gb"
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
```

---

# 2. Index Template作成

```bash
curl -X PUT "http://elastic1:9200/_index_template/logs-access-iceberg-template" \
-H "Content-Type: application/json" \
-d '{
  "index_patterns": ["logs-access-iceberg"],
  "priority": 600,
  "data_stream": {},
  "template": {
    "settings": {
      "index.lifecycle.name": "logs-access-iceberg-policy"
    },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "dt": {
          "type": "date",
          "format": "strict_date||yyyy-MM-dd"
        },
        "host": { "type": "keyword" },
        "container_name": { "type": "keyword" },
        "client_ip": { "type": "ip" },
        "method": { "type": "keyword" },
        "uri": { "type": "keyword" },
        "status": { "type": "integer" },
        "body_bytes_sent": { "type": "long" },
        "request_time": { "type": "double" },
        "upstream_addr": { "type": "keyword" },
        "user_agent": { "type": "text" },
        "raw_msg": { "type": "text" },
        "hr": { "type": "integer" }
      }
    }
  }
}'
```

---

# 3. Data Stream作成

```bash
curl -X PUT \
"http://elastic1:9200/_data_stream/logs-access-iceberg"
```

確認

```bash
curl -s \
"http://elastic1:9200/_data_stream/logs-access-iceberg?pretty"
```

---

# 4. Spark取り込みシェル作成

```bash
sudo tee /opt/elastic/bin/export_accesslog_iceberg_to_es.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ES_URL="${ES_URL:-http://elastic1:9200}"
DATA_STREAM="${DATA_STREAM:-logs-access-iceberg}"

SPARK_SQL="${SPARK_SQL:-sudo -u spark /usr/local/bin/spark-sql-iceberg}"
CATALOG="${CATALOG:-hive_prod}"
DB="${DB:-logs}"
TABLE="${TABLE:-nginx_access_curated}"

TARGET_DT="${1:-$(date -d 'yesterday' +%F)}"

WORK_DIR="${WORK_DIR:-/tmp/accesslog_iceberg_es_${TARGET_DT}_$$}"
JSON_DIR="${WORK_DIR}/json"
BULK_FILE="${WORK_DIR}/bulk.ndjson"
SQL_FILE="${WORK_DIR}/export.sql"
RESP_FILE="${WORK_DIR}/bulk_response.json"

mkdir -p "${WORK_DIR}" "${JSON_DIR}"

log() {
  echo "[$(date '+%F %T')] $*"
}

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

if ! [[ "${TARGET_DT}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  log "[ERROR] TARGET_DT must be YYYY-MM-DD. input=${TARGET_DT}"
  exit 1
fi

log "[INFO] TARGET_DT=${TARGET_DT}"
log "[INFO] DATA_STREAM=${DATA_STREAM}"
log "[INFO] TABLE=${CATALOG}.${DB}.${TABLE}"
log "[INFO] WORK_DIR=${WORK_DIR}"

cat > "${SQL_FILE}" <<EOSQL
CREATE OR REPLACE TEMP VIEW accesslog_export AS
SELECT
  date_format(event_time, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'") AS \`@timestamp\`,
  CAST(dt AS STRING) AS dt,
  CAST(host AS STRING) AS host,
  CAST(container_name AS STRING) AS container_name,
  CAST(client_ip AS STRING) AS client_ip,
  CAST(method AS STRING) AS method,
  CAST(uri AS STRING) AS uri,
  CAST(status AS INT) AS status,
  CAST(body_bytes_sent AS BIGINT) AS body_bytes_sent,
  CAST(request_time AS DOUBLE) AS request_time,
  CAST(upstream_addr AS STRING) AS upstream_addr,
  CAST(user_agent AS STRING) AS user_agent,
  CAST(raw_msg AS STRING) AS raw_msg,
  CAST(hr AS INT) AS hr
FROM ${CATALOG}.${DB}.${TABLE}
WHERE dt = DATE '${TARGET_DT}';

INSERT OVERWRITE DIRECTORY '${JSON_DIR}'
USING json
SELECT * FROM accesslog_export;
EOSQL

log "[INFO] export Iceberg to JSONL by Spark"
${SPARK_SQL} -f "${SQL_FILE}"

JSON_FILES=$(find "${JSON_DIR}" -type f -name 'part-*' | sort || true)

if [ -z "${JSON_FILES}" ]; then
  log "[WARN] no JSON files generated"
  exit 0
fi

DOC_COUNT=$(cat ${JSON_FILES} | wc -l | awk '{print $1}')

if [ "${DOC_COUNT}" -eq 0 ]; then
  log "[WARN] no records found. TARGET_DT=${TARGET_DT}"
  exit 0
fi

log "[INFO] exported docs=${DOC_COUNT}"

: > "${BULK_FILE}"

while IFS= read -r json_line; do
  printf '{ "create": { "_index": "%s" } }\n' "${DATA_STREAM}" >> "${BULK_FILE}"
  printf '%s\n' "${json_line}" >> "${BULK_FILE}"
done < <(cat ${JSON_FILES})

log "[INFO] bulk upload to Elasticsearch"

HTTP_CODE=$(curl -s -o "${RESP_FILE}" -w "%{http_code}" \
  -H "Content-Type: application/x-ndjson" \
  -X POST "${ES_URL}/_bulk?refresh=true" \
  --data-binary @"${BULK_FILE}")

if [ "${HTTP_CODE}" != "200" ]; then
  log "[ERROR] bulk request failed. http_code=${HTTP_CODE}"
  cat "${RESP_FILE}"
  exit 1
fi

HAS_ERRORS=$(jq -r '.errors' "${RESP_FILE}")

if [ "${HAS_ERRORS}" != "false" ]; then
  log "[ERROR] bulk completed with item errors"
  jq '.items[] | select(.create.error != null) | .create.error' "${RESP_FILE}" | head -20
  exit 1
fi

ES_COUNT=$(curl -s "${ES_URL}/${DATA_STREAM}/_count?q=dt:${TARGET_DT}" | jq -r '.count')

log "[INFO] bulk completed"
log "[INFO] source_docs=${DOC_COUNT}"
log "[INFO] es_count_dt_${TARGET_DT}=${ES_COUNT}"
EOF

sudo chmod +x /opt/elastic/bin/export_accesslog_iceberg_to_es.sh
```

---

# 5. 実行

前日分

```bash
/opt/elastic/bin/export_accesslog_iceberg_to_es.sh
```

任意日

```bash
/opt/elastic/bin/export_accesslog_iceberg_to_es.sh 2026-06-21
```

---

# 6. 件数確認

Iceberg側

```bash
sudo -u spark /usr/local/bin/spark-sql-iceberg -e "
SELECT count(*) AS cnt
FROM hive_prod.logs.nginx_access_curated
WHERE dt = DATE '2026-06-21';
"
```

Elasticsearch側

```bash
curl -s \
"http://elastic1:9200/logs-access-iceberg/_count?q=dt:2026-06-21"
```

---

# 7. Data Stream確認

```bash
curl -s \
"http://elastic1:9200/_data_stream/logs-access-iceberg?pretty"
```

---

# 8. Kibana登録

Data View

```text
logs-access-iceberg
```

Time Field

```text
@timestamp
```

---

# 9. cron登録

毎日01:30実行

```bash
crontab -e
```

```cron
30 1 * * * /opt/elastic/bin/export_accesslog_iceberg_to_es.sh \
>> /tmp/export_accesslog_iceberg_to_es.log 2>&1
```

---

# 運用イメージ

```text
nginx access log
      ↓
Iceberg
      ↓
Spark SQL
      ↓
logs-access-iceberg
      ↓
Kibana
```

ローテーション・保持期間管理は Elasticsearch ILM が実施するため、
日付付き index の削除シェルは不要。
