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
- `/opt/iceberg/bin/export_iceberg_to_s3.sh` が設置されていること
- Athena workgroup が engine version 3 を使用していること

構築編の IAM policy は Glue の `${GLUE_DATABASE}` 配下の全テーブルと Iceberg bucket 配下を対象にしているため、記事どおりの policy であれば本テーブルにも利用できます。独自に対象 ARN や S3 prefix を狭めている場合は、`nginx_access_curated` 用の権限を追加してください。

## 1. AWS 設定を読み込む

同期を実行するホストで設定を読み込みます。

```bash
set -a
source /etc/iceberg/aws.env
set +a
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

```bash
sudo -u spark /usr/local/bin/spark-sql-iceberg <<'EOF'
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

```bash
sudo -u spark \
  AWS_PROFILE="${AWS_PROFILE}" \
  AWS_REGION="${AWS_REGION}" \
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

## 4. 対象日を AWS へ同期する

例として `2026-06-21` を同期します。

```bash
TARGET_DATE="2026-06-21"

sudo -u spark \
  AWS_PROFILE="${AWS_PROFILE}" \
  AWS_REGION="${AWS_REGION}" \
  GLUE_DATABASE="${GLUE_DATABASE}" \
  SPARK_SQL_BIN=/usr/local/bin/spark-sql-iceberg-aws \
  TABLE=nginx_access_curated \
  DT="${TARGET_DATE}" \
  /opt/iceberg/bin/export_iceberg_to_s3.sh
```

このスクリプトは AWS 側の同じ `dt` を `DELETE` してから自宅側のデータを `INSERT` し、同期元と同期先の件数を比較します。同じ日付で再実行できます。

日次同期の対象に追加する場合は、記事で作成した `/opt/iceberg/bin/export_logs_to_s3_daily.sh` の `TABLES` に追加します。

```bash
TABLES=(
  syslog_iceberg
  authlog_iceberg
  nginx_access_curated
)
```

`readme2.md` の日次取り込みが完了した後に AWS 同期が動くよう、実行時刻を調整してください。

## 5. 同期結果を確認する

Spark から自宅側と AWS 側の件数を比較します。

```bash
sudo -u spark \
  AWS_PROFILE="${AWS_PROFILE}" \
  AWS_REGION="${AWS_REGION}" \
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

## 8. 今回導入したデータだけを削除する

自宅 HDFS の正本は削除しません。また、記事で作成済みの `syslog_iceberg`、`authlog_iceberg`、Glue database、S3 bucket、Athena workgroup、IAM user / policy も削除しません。

### 8.1 指定日の AWS コピーだけを削除する

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

### 8.2 この README で追加した AWS 側テーブルをすべて削除する

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
