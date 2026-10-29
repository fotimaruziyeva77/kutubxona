#!/bin/sh
# Vault dev rejimida barcha secretlarni yozish
# docker-compose up dan keyin bir marta ishlatiladi:
#   docker exec sifat-vault sh /vault/init.sh
set -e

export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=dev-root-token

echo "=== Vault secrets yozilmoqda ==="

# KV v2 engine yoqish
vault secrets enable -path=sifat kv-v2 2>/dev/null || true

# Database
vault kv put sifat/database \
  url="postgresql://sifat:sifat@sifat-postgres:5432/sifat" \
  host="sifat-postgres" \
  port="5432" \
  name="sifat" \
  user="sifat" \
  password="sifat"

# Redis
vault kv put sifat/redis \
  url="redis://sifat-redis:6379"

# JWT
vault kv put sifat/jwt \
  secret="$(openssl rand -hex 32)" \
  refresh_secret="$(openssl rand -hex 32)"

# MinIO
vault kv put sifat/minio \
  endpoint="sifat-minio" \
  port="9000" \
  access_key="minio" \
  secret_key="minio123"

# Elasticsearch
vault kv put sifat/elasticsearch \
  node="http://sifat-elasticsearch:9200"

# Kafka
vault kv put sifat/kafka \
  broker="sifat-kafka:9092"

echo "=== Vault secrets tayyor ==="
echo "UI: http://localhost:8200 | Token: dev-root-token"
