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