# Iceberg のアクセスログを AWS Athena から参照する手順

## 概要

[`readme2.md`](./readme2.md) で自宅 HDFS の Iceberg に取り込んだ
`hive_prod.logs.nginx_access_curated` を、AWS 側の分析用 Iceberg テーブルへ日付単位で複製し、Athena から参照します。

```text
hive_prod.logs.nginx_access_curated（自宅 HDFS、正本）
                  ↓ Spark DELETE + INSERT
glue_prod.logs.nginx_access_curated（Amazon S3、分析用コピー）
                  ↓ AWS Glue Data Catalog
               Amazon Athena
                  ↓ 任意
          QuickSight / Amazon Quick
```

この手順では、次の3記事で S3、Glue Data Catalog、Athena、IAM、および Spark の AWS 用設定が構築済みであることを前提とします。

- [自宅HDFS上のApache IcebergをAmazon S3へ複製しAthenaから分析してみる【構築編】](https://qiita.com/naritomo08/items/d3db5aefc9a56cc2b2a6)
- [AWS S3上のApache IcebergをAthena向けに運用する【運用編】](https://qiita.com/naritomo08/items/f84d266b7f2f3a53d6e0)
- [AWS S3上のApache IcebergをAthena経由で可視化する【発展編】](https://qiita.com/naritomo08/items/48f6e29c32071a5a0b28)

記事で作成した `syslog_iceberg`、`authlog_iceberg`、S3 bucket、Glue database、Athena workgroup はそのまま残します。この README で追加する対象は `nginx_access_curated` と、任意で作る同テーブル用の View / QuickSight リソースだけです。

## 前提

- 自宅側に `hive_prod.logs.nginx_access_curated` が存在し、参照対象日のデータが入っていること
- `/etc/iceberg/aws.env` に `AWS_REGION`、`ICEBERG_BUCKET`、`ATHENA_RESULT_BUCKET`、`ATHENA_WORKGROUP`、`GLUE_DATABASE`、`AWS_PROFILE` が設定されていること
- `/usr/local/bin/spark-sql-iceberg-aws` から `hive_prod` と `glue_prod` の両方を参照できること
- `/opt/iceberg/bin` と `/usr/local/bin` 配下を作成・更新できる `sudo` 権限があること
- Athena workgroup が engine version 3 を使用していること

構築編の IAM policy は Glue の `${GLUE_DATABASE}` 配下の全テーブルと Iceberg bucket 配下を対象にしているため、記事どおりの policy であれば本テーブルにも利用できます。独自に対象 ARN や S3 prefix を狭めている場合は、`nginx_access_curated` 用の権限を追加してください。

## 1. AWS 設定を読み込む

同期を実行するホストで変数設定を読み込みます。

実行ユーザー: spark

```bash
source /etc/profile.d/iceberg-s3-athena.sh
use_iceberg_aws_sync
```

変数と接続先アカウントを確認します。想定外のアカウントや bucket が表示された場合は、以降を実行しないでください。

```bash
printf 'AWS_REGION=%s\n' "${AWS_REGION}"
printf 'AWS_PROFILE=%s\n' "${AWS_PROFILE}"
printf 'ICEBERG_BUCKET=%s\n' "${ICEBERG_BUCKET}"
printf 'ATHENA_WORKGROUP=%s\n' "${ATHENA_WORKGROUP}"
printf 'GLUE_DATABASE=%s\n' "${GLUE_DATABASE}"

aws sts get-caller-identity --profile "${AWS_PROFILE}"
```

## 2. 自宅側テーブルの定義を確認する

AWS 側は自宅側と同じカラム名、型、順序で作成する必要があります。先に実テーブルを確認します。

実行ユーザー: spark

```bash
/usr/local/bin/spark-sql-iceberg <<'EOF'
DESCRIBE TABLE hive_prod.logs.nginx_access_curated;
SHOW CREATE TABLE hive_prod.logs.nginx_access_curated;
EOF
```

`readme2.md` の想定定義は次の順序です。

```text
event_time, host, container_name, client_ip, method, uri, status,
body_bytes_sent, request_time, upstream_addr, user_agent, raw_msg, dt, hr
```

実テーブルで `client_ip` が `remote_addr` など別名になっている場合は、次節の AWS 側 DDL も実テーブルに合わせてください。後続の共通同期スクリプトは `SELECT *` でコピーするため、カラム順序も一致させます。

## 3. AWS 側 Iceberg テーブルを作成する

次の DDL は `readme2.md` の定義と一致する場合の例です。`GLUE_DATABASE=logs` 以外の場合も変数から実際の database 名が使われます。

実行ユーザー: spark

```bash
/usr/local/bin/spark-sql-iceberg-aws <<EOF
CREATE TABLE IF NOT EXISTS glue_prod.${GLUE_DATABASE}.nginx_access_curated (
  event_time       timestamp,
  host             string,
  container_name   string,
  client_ip        string,
  method           string,
  uri              string,
  status           int,
  body_bytes_sent  bigint,
  request_time     double,
  upstream_addr    string,
  user_agent       string,
  raw_msg          string,
  dt               date,
  hr               int
)
USING iceberg
LOCATION 's3://${ICEBERG_BUCKET}/warehouse/${GLUE_DATABASE}/nginx_access_curated'
PARTITIONED BY (dt)
TBLPROPERTIES (
  'format-version'='2',
  'write.distribution-mode'='hash',
  'write.parquet.compression-codec'='zstd'
);
EOF
```

Glue と S3 を確認します。

```bash
aws glue get-table \
  --region "${AWS_REGION}" \
  --database-name "${GLUE_DATABASE}" \
  --name nginx_access_curated \
  --profile "${AWS_PROFILE}"

aws s3 ls \
  "s3://${ICEBERG_BUCKET}/warehouse/${GLUE_DATABASE}/nginx_access_curated/" \
  --recursive \
  --profile "${AWS_PROFILE}"
```

テーブル作成直後は `metadata/` だけで、データ同期後に `data/` が作られます。

## 4. 同期シェルを作成する

同期処理は `/usr/local/bin/export-iceberg-to-s3` の1本にまとめます。`TABLE` を指定すると1テーブルだけ、指定しない場合は3テーブルを順番に同期します。既存ファイルは次のコマンドで丸ごと置き換わるため、独自変更がある場合は先に退避してください。

### 4.1 シェル本体

自宅 HDFS から AWS S3 へ対象日のデータを同期します。AWS 側の同じ `dt` を `DELETE` してから `INSERT` し、同期元と同期先の件数を比較します。

ファイル: `/usr/local/bin/export-iceberg-to-s3`

実行ユーザー: 通常ユーザー

```bash
sudo tee /usr/local/bin/export-iceberg-to-s3 > /dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/iceberg/aws.env}

if [ -r "${ENV_FILE}" ]; then
  set -a
  . "${ENV_FILE}"
  set +a
fi

SOURCE_CATALOG=${SOURCE_CATALOG:-hive_prod}
DEST_CATALOG=${DEST_CATALOG:-glue_prod}
SOURCE_DB=${SOURCE_DB:-logs}
DEST_DB=${DEST_DB:-${GLUE_DATABASE:-logs}}
DT=${DT:-$(date -d yesterday +%F)}
SPARK_SQL_BIN=${SPARK_SQL_BIN:-/usr/local/bin/spark-sql-iceberg-aws}
SPARK_RUN_USER=${SPARK_RUN_USER:-spark}
SPARK_RUN_LOCAL_DIRS=${SPARK_RUN_LOCAL_DIRS:-/var/lib/spark/work}

if [ "$(id -un)" != "${SPARK_RUN_USER}" ]; then
  export ENV_FILE
  export SOURCE_CATALOG
  export DEST_CATALOG
  export SOURCE_DB
  export DEST_DB
  export GLUE_DATABASE="${GLUE_DATABASE:-}"
  export TABLE="${TABLE:-}"
  export TABLES="${TABLES:-}"
  export DT
  export SPARK_SQL_BIN
  export AWS_REGION
  export AWS_PROFILE="${AWS_SYNC_PROFILE:-${AWS_PROFILE:-}}"
  export AWS_SHARED_CREDENTIALS_FILE="${AWS_SYNC_SHARED_CREDENTIALS_FILE:-${AWS_SHARED_CREDENTIALS_FILE:-}}"
  export AWS_CONFIG_FILE="${AWS_SYNC_CONFIG_FILE:-${AWS_CONFIG_FILE:-}}"
  export SPARK_LOCAL_DIRS="${SPARK_RUN_LOCAL_DIRS}"

  exec sudo -E -u "${SPARK_RUN_USER}" -H "$0" "$@"
fi

if [ -z "${AWS_PROFILE:-}" ] && [ -n "${AWS_SYNC_PROFILE:-}" ]; then
  AWS_PROFILE="${AWS_SYNC_PROFILE}"
fi

if [ -z "${AWS_SHARED_CREDENTIALS_FILE:-}" ] && [ -n "${AWS_SYNC_SHARED_CREDENTIALS_FILE:-}" ]; then
  AWS_SHARED_CREDENTIALS_FILE="${AWS_SYNC_SHARED_CREDENTIALS_FILE}"
fi

if [ -z "${AWS_CONFIG_FILE:-}" ] && [ -n "${AWS_SYNC_CONFIG_FILE:-}" ]; then
  AWS_CONFIG_FILE="${AWS_SYNC_CONFIG_FILE}"
fi

export AWS_PROFILE
export AWS_SHARED_CREDENTIALS_FILE
export AWS_CONFIG_FILE
export AWS_REGION

: "${AWS_PROFILE:?AWS_PROFILE is required}"
: "${AWS_SHARED_CREDENTIALS_FILE:?AWS_SHARED_CREDENTIALS_FILE is required}"
: "${AWS_CONFIG_FILE:?AWS_CONFIG_FILE is required}"
: "${AWS_REGION:?AWS_REGION is required}"

if [ -n "${TABLE:-}" ]; then
  TABLES=("${TABLE}")
else
  read -r -a TABLES <<< "${TABLES:-syslog_iceberg authlog_iceberg nginx_access_curated}"
fi

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

run_count() {
  local sql="$1"
  local out

  out="$("${SPARK_SQL_BIN}" -S -e "${sql}")"
  printf '%s\n' "${out}" | extract_last_integer
}

export_table() {
  local table="$1"
  local src_table="${SOURCE_CATALOG}.${SOURCE_DB}.${table}"
  local dest_table="${DEST_CATALOG}.${DEST_DB}.${table}"
  local src_count
  local dest_count

  log "start export: TABLE=${table}, DT=${DT}"
  log "SOURCE=${src_table}"
  log "DEST=${dest_table}"

  src_count="$(run_count "SELECT count(*) FROM ${src_table} WHERE dt = DATE '${DT}'")"
  log "source count=${src_count}"

  "${SPARK_SQL_BIN}" <<SQL
DELETE FROM ${dest_table}
WHERE dt = DATE '${DT}';

INSERT INTO ${dest_table}
SELECT *
FROM ${src_table}
WHERE dt = DATE '${DT}';
SQL

  dest_count="$(run_count "SELECT count(*) FROM ${dest_table} WHERE dt = DATE '${DT}'")"
  log "dest count=${dest_count}"

  if [ "${src_count}" != "${dest_count}" ]; then
    err "count mismatch: TABLE=${table}, source=${src_count}, dest=${dest_count}"
    exit 1
  fi

  log "completed successfully: TABLE=${table}"
}

main() {
  local table

  log "daily export start: DT=${DT}"
  for table in "${TABLES[@]}"; do
    export_table "${table}"
  done
  log "daily export completed successfully: DT=${DT}"
}

main "$@"
EOF

sudo chmod 755 /usr/local/bin/export-iceberg-to-s3
```

### 4.2 対象日を手動同期する

3テーブルをまとめて同期する場合は `TABLE` を指定しません。`DT` を省略すると前日が対象です。

```bash
DT=2026-08-27 export-iceberg-to-s3
```

同じ日付で再実行できます。systemd から実行する場合は `ExecStart=/usr/local/bin/export-iceberg-to-s3` とし、`readme2.md` の日次取り込みが完了した後に動くよう timer の実行時刻を調整してください。

## 5. 同期結果を確認する

Spark から自宅側と AWS 側の件数を比較します。

実行ユーザー: spark

```bash
TARGET_DATE=2026-08-27

/usr/local/bin/spark-sql-iceberg-aws <<EOF
SELECT count(*) AS home_count
FROM hive_prod.logs.nginx_access_curated
WHERE dt = DATE '${TARGET_DATE}';

SELECT count(*) AS aws_count
FROM glue_prod.${GLUE_DATABASE}.nginx_access_curated
WHERE dt = DATE '${TARGET_DATE}';
EOF
```

`home_count` と `aws_count` が一致することを確認します。

## 6. Athena から参照する

AWS Console で Athena を開き、次を選択します。

```text
Workgroup: <ATHENA_WORKGROUP>
Data source / Catalog: AwsDataCatalog
Database: <GLUE_DATABASE>（記事の例では logs）
```

以降の SQL は `GLUE_DATABASE=logs` の例です。別名の場合は `logs` を実際の database 名に置き換えます。

### 対象日の件数

```sql
SELECT count(*) AS log_count
FROM logs.nginx_access_curated
WHERE dt = DATE '2026-06-21';
```

### 最新のアクセスログ

確認用途でも `dt` と必要な列を指定し、不要な S3 スキャンを避けます。

```sql
SELECT
    event_time,
    host,
    container_name,
    client_ip,
    method,
    uri,
    status,
    request_time
FROM logs.nginx_access_curated
WHERE dt = DATE '2026-06-21'
ORDER BY event_time DESC
LIMIT 20;
```

### HTTP status 別件数

```sql
SELECT
    status,
    count(*) AS request_count
FROM logs.nginx_access_curated
WHERE dt BETWEEN current_date - INTERVAL '6' DAY AND current_date
GROUP BY status
ORDER BY status;
```

### container 別の件数と応答時間

```sql
SELECT
    container_name,
    count(*) AS request_count,
    round(avg(request_time) * 1000, 2) AS avg_ms,
    round(approx_percentile(request_time, 0.95) * 1000, 2) AS p95_ms
FROM logs.nginx_access_curated
WHERE dt BETWEEN current_date - INTERVAL '6' DAY AND current_date
GROUP BY container_name
ORDER BY request_count DESC;
```

`event_time` は、自宅側 Spark / Trino で表示した時刻と比較し、タイムゾーンによるずれがないことを実データで確認してください。

## 7. 可視化用 View を作る（任意）

QuickSight / Quick から扱いやすいように、日次集計 View を作る例です。

```sql
CREATE OR REPLACE VIEW logs.v_nginx_access_daily AS
SELECT
    dt,
    container_name,
    status,
    count(*) AS request_count,
    avg(request_time) * 1000 AS avg_ms,
    approx_percentile(request_time, 0.95) * 1000 AS p95_ms
FROM logs.nginx_access_curated
GROUP BY
    dt,
    container_name,
    status;
```

確認します。

```sql
SELECT *
FROM logs.v_nginx_access_daily
WHERE dt >= current_date - INTERVAL '6' DAY
ORDER BY dt DESC, request_count DESC;
```

QuickSight / Quick で使う場合は、記事の発展編と同様に Athena data source を選び、次を Dataset に指定します。

```text
Catalog: AwsDataCatalog
Database: logs
Table: v_nginx_access_daily
```

更新頻度を制御しやすい `SPICE` を基本とし、常に最新の AWS 側コピーを参照する必要がある場合だけ `Direct Query` を選びます。

## 8. AWS 側 Iceberg を運用する

日次同期の `DELETE + INSERT` を繰り返すと、snapshot、metadata file、data file が増えます。運用編と同じ方針で、`nginx_access_curated` も日次確認と週次 maintenance の対象にします。

### 8.1 snapshot 保持設定

Athena で保持設定を行います。次の例では最低3 snapshot、最長7日、過去の metadata file は30個まで保持します。

```sql
ALTER TABLE logs.nginx_access_curated SET TBLPROPERTIES (
  'vacuum_min_snapshots_to_keep'='3',
  'vacuum_max_snapshot_age_seconds'='604800',
  'vacuum_max_metadata_files_to_keep'='30'
);
```

7日は例です。同期障害に気付いて調査・復旧するまでの期間より短くしないでください。

### 8.2 snapshot と data file を確認する

Athena の Iceberg metadata table で snapshot を確認します。

```sql
SELECT
    committed_at,
    snapshot_id,
    operation
FROM "logs"."nginx_access_curated$snapshots"
ORDER BY committed_at DESC
LIMIT 20;
```

data file の数とサイズを確認します。

```sql
SELECT
    count(*) AS file_count,
    sum(record_count) AS record_count,
    round(sum(file_size_in_bytes) / 1024.0 / 1024.0, 2) AS total_mb,
    round(avg(file_size_in_bytes) / 1024.0 / 1024.0, 2) AS avg_file_mb
FROM "logs"."nginx_access_curated$files";
```

小さい file の詳細です。

```sql
SELECT
    file_path,
    record_count,
    file_size_in_bytes
FROM "logs"."nginx_access_curated$files"
ORDER BY file_size_in_bytes ASC
LIMIT 50;
```

### 8.3 OPTIMIZE と VACUUM

`nginx_access_curated` は `dt` partition のため、まず対象日を絞って compaction します。

```sql
OPTIMIZE logs.nginx_access_curated
REWRITE DATA USING BIN_PACK
WHERE dt = DATE '2026-06-21';
```

`OPTIMIZE` の `WHERE` には partition column だけを指定できます。全 table の `OPTIMIZE` はスキャン量と実行時間が増えるため、小規模 PoC 以外では避けます。

`OPTIMIZE` 後に件数と代表データを確認し、問題がなければ期限切れ snapshot と orphan file を回収します。

```sql
SELECT count(*)
FROM logs.nginx_access_curated
WHERE dt = DATE '2026-06-21';
```

```sql
VACUUM logs.nginx_access_curated;
```

実行順序は次のとおりです。

```text
OPTIMIZE
  ↓
件数・検索結果を確認
  ↓
VACUUM
  ↓
snapshot・S3 容量を確認
```

`VACUUM` には Iceberg table prefix に対する `s3:DeleteObject` が必要です。また、期限切れ snapshot は復元やタイムトラベルができなくなります。

### 8.4 S3 容量と Athena スキャン量を確認する

S3 のオブジェクト数と容量を確認します。

実行ユーザー: spark

```bash
aws s3 ls \
  "s3://${ICEBERG_BUCKET}/warehouse/${GLUE_DATABASE}/nginx_access_curated/" \
  --recursive \
  --summarize \
  --profile "${AWS_PROFILE}" \
  | tail -5
```

運用編の `/opt/iceberg/bin/run_athena_query_with_stats.sh` を使い、代表クエリの `DataScannedInBytes` と実行時間を確認します。

実行ユーザー: spark

```bash
SQL="SELECT status, count(*) \
FROM ${GLUE_DATABASE}.nginx_access_curated \
WHERE dt = DATE '${TARGET_DATE}' \
GROUP BY status" \
/opt/iceberg/bin/run_athena_query_with_stats.sh
```

日付条件の付け忘れ、`SELECT *`、対象期間の拡大、小さい file の増加がないかを継続して確認します。

### 8.5 日次確認スクリプトを丸ごと入れ替える

運用編の `/opt/iceberg/bin/check_aws_iceberg.sh` を、`nginx_access_curated` を含む次の内容で置き換えます。

実行ユーザー: 通常ユーザー

```bash
sudo tee /opt/iceberg/bin/check_aws_iceberg.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

AWS_REGION=${AWS_REGION:-ap-northeast-1}
AWS_PROFILE=${AWS_PROFILE:-default}
ICEBERG_BUCKET=${ICEBERG_BUCKET:?ICEBERG_BUCKET is required}
ATHENA_RESULT_BUCKET=${ATHENA_RESULT_BUCKET:?ATHENA_RESULT_BUCKET is required}
ATHENA_WORKGROUP=${ATHENA_WORKGROUP:-home-log-iceberg}
GLUE_DATABASE=${GLUE_DATABASE:-logs}
DT=${DT:-$(date -d yesterday +%F)}
RUN_ATHENA=${RUN_ATHENA:-/opt/iceberg/bin/run_athena_query_with_stats.sh}

TABLES=(
  syslog_iceberg
  authlog_iceberg
  nginx_access_curated
)

log() {
  echo "[INFO] $(date '+%F %T') $*"
}

run_athena() {
  local sql="$1"

  AWS_REGION="${AWS_REGION}" \
  AWS_PROFILE="${AWS_PROFILE}" \
  ATHENA_RESULT_BUCKET="${ATHENA_RESULT_BUCKET}" \
  ATHENA_WORKGROUP="${ATHENA_WORKGROUP}" \
  SQL="${sql}" \
  "${RUN_ATHENA}"
}

if ! [[ "${DT}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  log "ERROR DT must be YYYY-MM-DD: ${DT}"
  exit 1
fi

log "check AWS Iceberg daily: DT=${DT}"

for table in "${TABLES[@]}"; do
  log "S3 summarize: ${table}"
  aws s3 ls \
    "s3://${ICEBERG_BUCKET}/warehouse/${GLUE_DATABASE}/${table}/" \
    --recursive \
    --summarize \
    --profile "${AWS_PROFILE}" \
    | tail -5

  log "Athena count: ${table}"
  run_athena "SELECT count(*) FROM ${GLUE_DATABASE}.${table} WHERE dt = DATE '${DT}'"
done

log "check completed successfully: DT=${DT}"
EOF

sudo chmod 755 /opt/iceberg/bin/check_aws_iceberg.sh
sudo chown spark:spark /opt/iceberg/bin/check_aws_iceberg.sh
```

対象日を指定して手動実行し、3テーブルそれぞれの件数、スキャン量、S3容量が表示されることを確認します。

実行ユーザー: spark

```bash
DT=2026-08-18 \
/opt/iceberg/bin/check_aws_iceberg.sh
```

`DT` を省略した場合は前日を確認します。

### 8.6 週次 maintenance スクリプトを丸ごと入れ替える

運用編の週次 maintenance シェルを、`nginx_access_curated` を含む次の内容で `/opt/iceberg/bin/maintain_aws_iceberg.sh` に作成し直します。

実行ユーザー: 通常ユーザー

```bash
sudo tee /opt/iceberg/bin/maintain_aws_iceberg.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

AWS_REGION=${AWS_REGION:-ap-northeast-1}
AWS_PROFILE=${AWS_PROFILE:-default}
ATHENA_RESULT_BUCKET=${ATHENA_RESULT_BUCKET:?ATHENA_RESULT_BUCKET is required}
ATHENA_WORKGROUP=${ATHENA_WORKGROUP:-home-log-iceberg}
GLUE_DATABASE=${GLUE_DATABASE:-logs}
DT=${DT:-}
RUN_ATHENA=${RUN_ATHENA:-/opt/iceberg/bin/run_athena_query_with_stats.sh}

TABLES=(
  syslog_iceberg
  authlog_iceberg
  nginx_access_curated
)

log() {
  echo "[INFO] $(date '+%F %T') $*"
}

run_athena() {
  local sql="$1"

  AWS_REGION="${AWS_REGION}" \
  AWS_PROFILE="${AWS_PROFILE}" \
  ATHENA_RESULT_BUCKET="${ATHENA_RESULT_BUCKET}" \
  ATHENA_WORKGROUP="${ATHENA_WORKGROUP}" \
  SQL="${sql}" \
  "${RUN_ATHENA}"
}

if [ -n "${DT}" ] && ! [[ "${DT}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  log "ERROR DT must be YYYY-MM-DD: ${DT}"
  exit 1
fi

log "weekly maintenance start: DT=${DT:-all}"

for table in "${TABLES[@]}"; do
  log "set vacuum properties: ${table}"
  run_athena "ALTER TABLE ${GLUE_DATABASE}.${table} SET TBLPROPERTIES ('vacuum_min_snapshots_to_keep'='3','vacuum_max_snapshot_age_seconds'='604800','vacuum_max_metadata_files_to_keep'='30')"

  if [ -n "${DT}" ]; then
    log "optimize ${table}: DT=${DT}"
    run_athena "OPTIMIZE ${GLUE_DATABASE}.${table} REWRITE DATA USING BIN_PACK WHERE dt = DATE '${DT}'"
  else
    log "optimize ${table}: full table"
    run_athena "OPTIMIZE ${GLUE_DATABASE}.${table} REWRITE DATA USING BIN_PACK"
  fi

  log "vacuum: ${table}"
  run_athena "VACUUM ${GLUE_DATABASE}.${table}"
done

log "maintenance completed successfully"
EOF

sudo chmod 755 /opt/iceberg/bin/maintain_aws_iceberg.sh
sudo chown spark:spark /opt/iceberg/bin/maintain_aws_iceberg.sh
```

まず `DT` を指定して手動実行します。

実行ユーザー: spark

```bash
DT=2026-08-18 \
/opt/iceberg/bin/maintain_aws_iceberg.sh
```

成功後は、既存の `maintain-aws-iceberg.timer` が `nginx_access_curated` も処理します。ただし、運用編の timer は `DT` 未指定で全 table を `OPTIMIZE` します。データ量が増えた環境では、対象日を分割するよう maintenance スクリプトまたは unit を調整してから定期実行してください。

```bash
systemctl list-timers maintain-aws-iceberg.timer
sudo systemctl status maintain-aws-iceberg.timer --no-pager
journalctl -u maintain-aws-iceberg.service -n 100 --no-pager
```

AWS 日次同期、`OPTIMIZE`、`VACUUM` は同時に動かしません。特に `VACUUM` は同期処理が完了してから実行します。

### 8.7 Spark 手続きで maintenance する場合

Athena の代わりに Spark で対象日の data file を再配置する例です。

実行ユーザー: spark

```bash
/usr/local/bin/spark-sql-iceberg-aws <<EOF
CALL glue_prod.system.rewrite_data_files(
  table => '${GLUE_DATABASE}.nginx_access_curated',
  where => 'dt = DATE ''${TARGET_DATE}'''
);
EOF
```

orphan file は、必ず古い日時を指定して dry run から確認します。次は削除候補の確認だけで、削除は行いません。

```bash
ORPHAN_BEFORE="2026-06-14 00:00:00"

/usr/local/bin/spark-sql-iceberg-aws <<EOF
CALL glue_prod.system.remove_orphan_files(
  table => '${GLUE_DATABASE}.nginx_access_curated',
  older_than => TIMESTAMP '${ORPHAN_BEFORE}',
  dry_run => true
);
EOF
```

同期中または直近に作成された file が候補へ含まれていないことを確認した場合だけ、運用編の手順に従って `dry_run => false` を実行します。通常は Athena の `OPTIMIZE` / `VACUUM` に統一し、Athena と Spark の maintenance を重ねて実行しません。

### 8.8 IAM、S3 Versioning、lifecycle を確認する

通常の同期・確認・maintenance は同期用 profile で実行します。最低限、Athena実行、Glue参照・更新、Iceberg prefix のS3読書き・削除権限が必要です。特に `VACUUM` と orphan file 削除には `s3:DeleteObject` が必要です。

```bash
aws sts get-caller-identity --profile "${AWS_PROFILE}"

aws s3api get-bucket-versioning \
  --bucket "${ICEBERG_BUCKET}" \
  --profile "${AWS_PROFILE}"

aws s3api get-bucket-lifecycle-configuration \
  --bucket "${ICEBERG_BUCKET}" \
  --profile "${AWS_PROFILE}"
```

運用編どおり lifecycle の対象が `warehouse/` の場合、同じ配下に作成した `nginx_access_curated` にも適用されるため追加設定は不要です。table ごとに prefix を限定した独自設定の場合は、次の prefix が対象になっていることを管理用 profile で確認します。

```text
warehouse/<GLUE_DATABASE>/nginx_access_curated/
```

既存の lifecycle configuration を `put-bucket-lifecycle-configuration` で置き換えると、他テーブルの rule を消す可能性があります。変更時は現在の全 rule を取得・退避し、`nginx_access_curated` の rule を既存設定へ追加した完全な configuration を使用します。noncurrent version の保持期間は Iceberg の snapshot 保持期間より短くしません。

### 8.9 運用チェックリスト

日次:

- AWS 同期が成功し、自宅側と AWS 側の対象日件数が一致している
- Athena の代表クエリが成功し、時刻表示にずれがない
- `DataScannedInBytes` と S3 容量が急増していない

週次:

- snapshot 数、data file 数、平均 file size を確認する
- 必要な日付だけ `OPTIMIZE` する
- 同期終了後に `VACUUM` する
- maintenance 後も件数と検索結果が正しい

月次:

- snapshot 保持期間が復旧要件に合っている
- S3 Versioning / lifecycle と Athena query result の保持状況を確認する
- IAM Access Key、AWS利用料金、QuickSight / Quick の更新頻度を確認する

## 9. 今回導入したデータだけを削除する

自宅 HDFS の正本は削除しません。また、記事で作成済みの `syslog_iceberg`、`authlog_iceberg`、Glue database、S3 bucket、Athena workgroup、IAM user / policy も削除しません。

### 9.1 指定日の AWS コピーだけを削除する

日次同期に `nginx_access_curated` を追加済みの場合は、削除対象日が次回同期で再投入されないことを先に確認します。

Athena で削除前の件数を確認します。

```sql
SELECT dt, count(*) AS delete_target_count
FROM logs.nginx_access_curated
WHERE dt = DATE '2026-06-21'
GROUP BY dt;
```

対象日が正しいことを確認してから、同じ Athena workgroup で実行します。

```sql
DELETE FROM logs.nginx_access_curated
WHERE dt = DATE '2026-06-21';
```

削除結果を確認します。

```sql
SELECT count(*) AS remaining_count
FROM logs.nginx_access_curated
WHERE dt = DATE '2026-06-21';
```

`remaining_count` が `0` なら、Athena からは参照されません。Iceberg の `DELETE` はスナップショットを更新するため、過去スナップショットが保持されている間は古い data file が S3 に残ることがあります。物理ファイルの回収は運用編の保持方針に従って `VACUUM logs.nginx_access_curated;` を実行します。`VACUUM` により期限切れスナップショットへはタイムトラベルできなくなるため、保持期間を短く変更して即時削除する運用は避けてください。

Iceberg の整合性を壊すため、`data/dt=2026-06-21/` のような S3 prefix を `aws s3 rm` で直接削除してはいけません。

### 9.2 この README で追加した AWS 側テーブルをすべて削除する

`nginx_access_curated` を日次同期の `TABLES` に追加した場合は、先にその1行を削除します。systemd timer 自体は `syslog_iceberg` と `authlog_iceberg` の同期に使うため停止・削除しません。

QuickSight / Quick を作成した場合は、依存するリソースを次の順に削除します。共有している Athena data source や QuickSight / Quick アカウント自体は削除しません。

```text
今回作成した Dashboard
  ↓
今回作成した Analysis
  ↓
v_nginx_access_daily を使う Dataset（SPICE データを含む）
```

次に Athena で View とテーブルを削除します。

削除前に、対象が今回作成したテーブルと S3 prefix であることをもう一度確認します。

```bash
aws glue get-table \
  --region "${AWS_REGION}" \
  --database-name "${GLUE_DATABASE}" \
  --name nginx_access_curated \
  --query '[Table.Name,Table.StorageDescriptor.Location,Table.Parameters.metadata_location]' \
  --output table \
  --profile "${AWS_PROFILE}"
```

テーブル名が `nginx_access_curated`、location が
`s3://${ICEBERG_BUCKET}/warehouse/${GLUE_DATABASE}/nginx_access_curated` 配下であることを確認します。その後、次の2文を Athena で1文ずつ実行します。

```sql
DROP VIEW IF EXISTS logs.v_nginx_access_daily;
DROP TABLE IF EXISTS logs.nginx_access_curated;
```

Athena の Iceberg テーブルに対する `DROP TABLE` は、Glue のテーブル登録だけでなくテーブル内の S3 データも削除します。そのため、この専用テーブル以外の名前に置き換えて実行しないでください。

削除後、AWS CLI で今回のテーブルだけがなくなったことを確認します。

```bash
aws glue get-table \
  --region "${AWS_REGION}" \
  --database-name "${GLUE_DATABASE}" \
  --name nginx_access_curated \
  --profile "${AWS_PROFILE}"

aws s3 ls \
  "s3://${ICEBERG_BUCKET}/warehouse/${GLUE_DATABASE}/nginx_access_curated/" \
  --recursive \
  --summarize \
  --profile "${AWS_PROFILE}"
```

Glue は `EntityNotFoundException`、S3 はオブジェクト `0` 件になれば削除完了です。S3 Versioning が有効な場合、削除後も noncurrent version と delete marker が保持されることがあります。その場合は運用編で設定した、この table prefix を対象にする lifecycle で回収します。

共有の Athena query result bucket には他のクエリ結果も入るため、この手順では bucket や `athena-results/` を一括削除しません。記事側の既存環境はそのまま利用できます。

## 参考

- [Amazon Athena で Apache Iceberg テーブルをクエリする](https://docs.aws.amazon.com/athena/latest/ug/querying-iceberg.html)
- [Athena の Iceberg DELETE](https://docs.aws.amazon.com/athena/latest/ug/delete-statement.html)
- [Athena の Iceberg VACUUM](https://docs.aws.amazon.com/athena/latest/ug/vacuum-statement.html)
- [Athena の Iceberg DROP TABLE](https://docs.aws.amazon.com/athena/latest/ug/querying-iceberg-drop-table.html)
