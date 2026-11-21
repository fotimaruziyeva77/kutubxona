#!/usr/bin/env bash
# PostgreSQL zaxira nusxasi → deploy/backups/sifat-YYYYmmdd-HHMM.sql.gz
# Oxirgi 14 ta nusxa saqlanadi. Har kuni avtomatik (cron, root):
#   0 3 * * * cd /srv/sifat/deploy && bash backup.sh >/dev/null 2>&1
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
f="backups/sifat-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U sifat -d sifat --no-owner | gzip > "$f"
chmod 600 "$f"
ls -1t backups/sifat-*.sql.gz | tail -n +15 | xargs -r rm -f
echo "Zaxira: $f ($(du -h "$f" | cut -f1))"
