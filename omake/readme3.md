# Iceberg AccessLog → Elasticsearch(Data Stream) 連携手順

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
sudo tee /opt/iceberg/bin/load_nginx_access_to_iceberg.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SPARK_SQL="${SPARK_SQL:-sudo -u spark /usr/local/bin/spark-sql-iceberg}"

SRC_TABLE="${SRC_TABLE:-hive_prod.logs.syslog_iceberg}"
DST_TABLE="${DST_TABLE:-hive_prod.logs.nginx_access_curated}"

TARGET_DT="${1:-$(date -d 'yesterday' +%F)}"
PROGRAM_LIKE="${2:-qiita-search-frontend}"

log() {
  echo "[INFO] $(date '+%F %T') $*"
}

err() {
  echo "[ERROR] $(date '+%F %T') $*" >&2
}

if ! [[ "${TARGET_DT}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  err "TARGET_DT must be YYYY-MM-DD. input=${TARGET_DT}"
  exit 1
fi

PROGRAM_PATTERN="%${PROGRAM_LIKE}%"

log "nginx access reload start dt=${TARGET_DT} program_like=${PROGRAM_LIKE}"
log "src_table=${SRC_TABLE}"
log "dst_table=${DST_TABLE}"

${SPARK_SQL} <<EOSQL
REFRESH TABLE ${SRC_TABLE};

CREATE TABLE IF NOT EXISTS ${DST_TABLE} (
  event_time timestamp,
  host string,
  container_name string,
  remote_addr string,
  method string,
  uri string,
  status int,
  body_bytes_sent bigint,
  request_time double,
  upstream_addr string,
  user_agent string,
  raw_msg string,
  dt date,
  hr int
)
USING iceberg
PARTITIONED BY (dt);

DELETE FROM ${DST_TABLE}
WHERE dt = DATE '${TARGET_DT}'
  AND container_name LIKE '${PROGRAM_PATTERN}';

INSERT INTO ${DST_TABLE}
WITH src AS (
  SELECT
    host,
    program AS container_name,
    msg AS raw_msg,
    get_json_object(msg, '$.time') AS json_time,
    get_json_object(msg, '$.remote_addr') AS remote_addr,
    get_json_object(msg, '$.method') AS method,
    get_json_object(msg, '$.uri') AS uri,
    get_json_object(msg, '$.status') AS status,
    get_json_object(msg, '$.body_bytes_sent') AS body_bytes_sent,
    get_json_object(msg, '$.request_time') AS request_time,
    get_json_object(msg, '$.upstream_addr') AS upstream_addr,
    get_json_object(msg, '$.user_agent') AS user_agent
  FROM ${SRC_TABLE}
  WHERE dt BETWEEN DATE '${TARGET_DT}' - INTERVAL 1 DAY
               AND DATE '${TARGET_DT}' + INTERVAL 1 DAY
    AND program LIKE '${PROGRAM_PATTERN}'
    AND msg LIKE '{%'
    AND get_json_object(msg, '$.time') IS NOT NULL
)
SELECT
  to_timestamp(json_time) AS event_time,
  host,
  container_name,
  remote_addr,
  method,
  uri,
  CAST(status AS INT) AS status,
  CAST(body_bytes_sent AS BIGINT) AS body_bytes_sent,
  CAST(request_time AS DOUBLE) AS request_time,
  upstream_addr,
  user_agent,
  raw_msg,
  CAST(to_timestamp(json_time) AS DATE) AS dt,
  HOUR(to_timestamp(json_time)) AS hr
FROM src
WHERE CAST(to_timestamp(json_time) AS DATE) = DATE '${TARGET_DT}';
EOSQL

log "nginx access reload done dt=${TARGET_DT}"

log "start count check dt=${TARGET_DT}"

SRC_COUNT=$(${SPARK_SQL} -e "
SELECT count(*)
FROM ${SRC_TABLE}
WHERE dt BETWEEN DATE '${TARGET_DT}' - INTERVAL 1 DAY
             AND DATE '${TARGET_DT}' + INTERVAL 1 DAY
  AND program LIKE '${PROGRAM_PATTERN}'
  AND msg LIKE '{%'
  AND get_json_object(msg, '$.time') IS NOT NULL
  AND CAST(to_timestamp(get_json_object(msg, '$.time')) AS DATE) = DATE '${TARGET_DT}';
" | grep -E '^[0-9]+$' | tail -1)

DST_COUNT=$(${SPARK_SQL} -e "
SELECT count(*)
FROM ${DST_TABLE}
WHERE dt = DATE '${TARGET_DT}'
  AND container_name LIKE '${PROGRAM_PATTERN}';
" | grep -E '^[0-9]+$' | tail -1)

DIFF=$((DST_COUNT - SRC_COUNT))

log "src_count=${SRC_COUNT}"
log "dst_count=${DST_COUNT}"
log "diff=${DIFF}"

if [ "${SRC_COUNT}" -ne "${DST_COUNT}" ]; then
  err "nginx access count mismatch dt=${TARGET_DT} src=${SRC_COUNT} dst=${DST_COUNT}"
  exit 1
fi

log "nginx access count check ok dt=${TARGET_DT}"
EOF

sudo chmod +x /opt/iceberg/bin/load_nginx_access_to_iceberg.sh
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
