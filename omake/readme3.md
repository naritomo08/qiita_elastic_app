# Nginx Access Log → Iceberg 取り込み手順（完全版）

## 概要

既存の `hive_prod.logs.syslog_iceberg` に格納された nginx コンテナの JSON ログを解析し、

```text
hive_prod.logs.syslog_iceberg
    ↓
hive_prod.logs.nginx_access_curated
```

へ日次バッチで取り込む。

---

## Iceberg テーブル作成

```sql
%spark.sql

CREATE TABLE hive_prod.logs.nginx_access_curated (
  event_time timestamp,
  host string,
  container_name string,
  client_ip string,
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
LOCATION 'hdfs://cluster1/warehouse/iceberg/logs/nginx_access_curated'
PARTITIONED BY (dt)
TBLPROPERTIES (
  'format-version'='2',
  'write.distribution-mode'='hash'
);
```

---

## Nginx JSONログ例

```json
{
  "time":"2026-06-20T23:23:09+00:00",
  "remote_addr":"192.168.11.128",
  "method":"GET",
  "uri":"/api/php/articles?page=1&size=1",
  "status":200,
  "body_bytes_sent":10550,
  "request_time":0.010,
  "upstream_addr":"172.25.0.5:5000",
  "user_agent":"Mozilla/5.0"
}
```

---

## 取り込みシェル

ファイル:

```text
/opt/iceberg/bin/load_nginx_access_to_iceberg.sh
```

```bash
#!/usr/bin/env bash
set -euo pipefail

DT="${1:-$(date -d 'yesterday' +%F)}"
PROGRAM_LIKE="${2:-%qiita-search-frontend%}"
SPARK_SQL="${SPARK_SQL:-sudo -u spark /usr/local/bin/spark-sql-iceberg}"

SRC_TABLE="${SRC_TABLE:-hive_prod.logs.syslog_iceberg}"
DST_TABLE="${DST_TABLE:-hive_prod.logs.nginx_access_curated}"

log() {
  echo "[INFO] $(date '+%F %T') $*"
}

err() {
  echo "[ERROR] $(date '+%F %T') $*" >&2
}

extract_last_integer() {
  awk '
    {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0)
      if ($0 ~ /^[0-9]+$/) val=$0
    }
    END {
      if (val == "") exit 1
      print val
    }
  '
}

run_spark_count() {
  local sql="$1"
  local out rc

  set +e
  out=$(${SPARK_SQL} 2>&1 <<SQL
${sql}
SQL
)
  rc=$?
  set -e

  if [ "${rc}" -ne 0 ]; then
    printf '%s\n' "${out}" >&2
    err "spark-sql failed"
    return 1
  fi

  printf '%s\n' "${out}" | extract_last_integer
}

log "nginx access reload start dt=${DT} program_like=${PROGRAM_LIKE}"
log "src_table=${SRC_TABLE}"
log "dst_table=${DST_TABLE}"

${SPARK_SQL} <<SQL
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
WHERE dt = DATE '${DT}'
  AND container_name LIKE '${PROGRAM_LIKE}';

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
  WHERE dt = DATE '${DT}'
    AND program LIKE '${PROGRAM_LIKE}'
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
FROM src;
SQL

log "nginx access reload done dt=${DT}"
log "start count check dt=${DT}"

SRC_COUNT="$(run_spark_count "
SELECT COUNT(*)
FROM ${SRC_TABLE}
WHERE dt = DATE '${DT}'
  AND program LIKE '${PROGRAM_LIKE}'
  AND msg LIKE '{%'
  AND get_json_object(msg, '$.time') IS NOT NULL;
")"

DST_COUNT="$(run_spark_count "
SELECT COUNT(*)
FROM ${DST_TABLE}
WHERE dt = DATE '${DT}';
")"

DIFF=$((DST_COUNT - SRC_COUNT))

log "src_count=${SRC_COUNT}"
log "dst_count=${DST_COUNT}"
log "diff=${DIFF}"

if [ "${SRC_COUNT}" != "${DST_COUNT}" ]; then
  err "nginx access count mismatch dt=${DT} src=${SRC_COUNT} dst=${DST_COUNT}"
  exit 1
fi

log "OK nginx access count matched dt=${DT}"
log "nginx access reload finished dt=${DT}"
```

---

## 実行例

```bash
TARGET_DATE="2026-06-20"

/opt/iceberg/bin/load_nginx_access_to_iceberg.sh "${TARGET_DATE}" qiita-search-frontend
/opt/iceberg/bin/load_nginx_access_to_iceberg.sh "${TARGET_DATE}" elastic-search-frontend
/opt/iceberg/bin/load_nginx_access_to_iceberg.sh "${TARGET_DATE}" trino-search-frontend
```

---

## Zeppelin / Trino 件数確認

```sql
SELECT 'syslog_nginx' AS src, count(*) AS cnt
FROM iceberg.logs.syslog_iceberg
WHERE dt = current_date - INTERVAL '1' day
  AND program LIKE '%qiita-search-frontend%'

UNION ALL

SELECT 'nginx_access' AS src, count(*) AS cnt
FROM iceberg.logs.nginx_access_curated
WHERE dt = current_date - INTERVAL '1' day
  AND container_name LIKE '%qiita-search-frontend%';
```

---

## データ確認

```sql
SELECT *
FROM iceberg.logs.nginx_access_curated
WHERE dt = current_date - INTERVAL '1' day
ORDER BY event_time DESC
LIMIT 20;
```

---

## cron例

```cron
30 1 * * * /opt/iceberg/bin/load_nginx_access_to_iceberg.sh $(date -d 'yesterday' +\%F) qiita-search-frontend
35 1 * * * /opt/iceberg/bin/load_nginx_access_to_iceberg.sh $(date -d 'yesterday' +\%F) elastic-search-frontend
40 1 * * * /opt/iceberg/bin/load_nginx_access_to_iceberg.sh $(date -d 'yesterday' +\%F) trino-search-frontend
```
