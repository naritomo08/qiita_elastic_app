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
        "referer": { "type": "keyword" },
        "user_agent": { "type": "text" }
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
sudo mkdir -p /opt/elastic/bin
```

```bash
sudo vi /opt/elastic/bin/export_accesslog_iceberg_to_es.sh
```

以下を配置する。

```bash
#!/usr/bin/env bash
set -euo pipefail

ES_URL="${ES_URL:-http://elastic1:9200}"
DATA_STREAM="${DATA_STREAM:-logs-access-iceberg}"

SPARK_SQL="${SPARK_SQL:-sudo -u spark /usr/local/bin/spark-sql-iceberg}"
CATALOG="${CATALOG:-hive_prod}"
DB="${DB:-logs}"
TABLE="${TABLE:-nginx_access_curated}"

TARGET_DT="${1:-$(date -d 'yesterday' +%F)}"

LOG_DIR="${LOG_DIR:-/tmp}"
WORK_DIR="${WORK_DIR:-/tmp/accesslog_iceberg_es_${TARGET_DT}_$$}"

mkdir -p "${WORK_DIR}"

log() {
  echo "[$(date '+%F %T')] $*"
}

JSON_DIR="${WORK_DIR}/json"
BULK_FILE="${WORK_DIR}/bulk.ndjson"
SQL_FILE="${WORK_DIR}/export.sql"

mkdir -p "${JSON_DIR}"

cat > "${SQL_FILE}" <<EOSQL
CREATE OR REPLACE TEMP VIEW accesslog_export AS
SELECT
  date_format(event_time,
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'") AS `@timestamp`,
  CAST(dt AS STRING) dt,
  host,
  container_name,
  client_ip,
  method,
  uri,
  status,
  body_bytes_sent,
  request_time,
  referer,
  user_agent
FROM ${CATALOG}.${DB}.${TABLE}
WHERE dt = DATE '${TARGET_DT}';

INSERT OVERWRITE DIRECTORY '${JSON_DIR}'
USING json
SELECT * FROM accesslog_export;
EOSQL

${SPARK_SQL} -f "${SQL_FILE}"

: > "${BULK_FILE}"

find "${JSON_DIR}" -name 'part-*' | while read f
do
  while read line
  do
    echo '{ "create": { "_index": "'"${DATA_STREAM}"'" } }' \
      >> "${BULK_FILE}"
    echo "${line}" >> "${BULK_FILE}"
  done < "${f}"
done

curl \
-H "Content-Type: application/x-ndjson" \
-X POST \
"${ES_URL}/_bulk?refresh=true" \
--data-binary @"${BULK_FILE}"

log "[INFO] completed"
```

権限付与

```bash
chmod +x /opt/elastic/bin/export_accesslog_iceberg_to_es.sh
```

---

# 5. 実行

前日分

```bash
/opt/elastic/bin/export_accesslog_iceberg_to_es.sh
```

任意日

```bash
/opt/elastic/bin/export_accesslog_iceberg_to_es.sh 2026-06-20
```

---

# 6. 件数確認

Iceberg側

```sql
SELECT count(*)
FROM hive_prod.logs.nginx_access_curated
WHERE dt = DATE '2026-06-20';
```

Elasticsearch側

```bash
curl -s \
"http://elastic1:9200/logs-access-iceberg/_count?q=dt:2026-06-20"
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
