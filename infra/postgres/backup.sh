#!/bin/sh
# SIFAT LIBRARY — kunlik PostgreSQL backup (docker-compose.prod.yml `backup` service, cron 02:00)
# Talablar (TZ §8.3): kunlik backup, 30 kun retention, AES-256 (BACKUP_ENCRYPTION_KEY berilsa).
set -eu

PGHOST="${DB_HOST:-postgres}"
PGUSER="${DB_USER:-sifat}"
PGDATABASE="${DB_NAME:-sifat}"
export PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD is required}"

BACKUP_DIR="/backups"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="${BACKUP_DIR}/sifat_${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[backup] pg_dump boshlandi: ${PGDATABASE}@${PGHOST} -> ${OUT}"
pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" --no-owner --format=plain | gzip > "$OUT"

# AES-256 shifrlash (kalit berilgan bo'lsa)
if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -pass env:BACKUP_ENCRYPTION_KEY \
    -in "$OUT" -out "${OUT}.enc"
  rm -f "$OUT"
  OUT="${OUT}.enc"
  echo "[backup] AES-256 shifrlandi: ${OUT}"
else
  echo "[backup] OGOHLANTIRISH: BACKUP_ENCRYPTION_KEY berilmagan — backup shifrlanmagan (TZ §8.3 talabi)"
fi

# Retention: eski fayllarni o'chirish
find "$BACKUP_DIR" -name "sifat_*.sql.gz*" -type f -mtime +"$RETENTION_DAYS" -delete

SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup] tugadi: ${OUT} (${SIZE}); retention=${RETENTION_DAYS} kun"
