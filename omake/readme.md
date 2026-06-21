# app→Elastic取り込みシェル導入

## 初期設定シェル(14日ローテーションも実施)

/opt/elastic/bin/setup_accesslog_datastream.sh

## アクセスログ取り込み

/opt/elastic/bin/import_accesslog_to_es.sh

# 取り込みシェル定期実行

sudo tee /etc/cron.d/accesslog_to_es >/dev/null <<'EOF'
5 0 * * * root /opt/elastic/bin/import_accesslog_to_es.sh >> /var/log/import_accesslog_to_es.log 2>&1
EOF
