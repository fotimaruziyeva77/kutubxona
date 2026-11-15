#!/usr/bin/env bash
# Yangi kodni olish va qayta ishga tushirish (ma'lumotlar saqlanadi).
#   cd /srv/sifat/deploy && sudo bash update.sh
set -euo pipefail
cd "$(dirname "$0")"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

echo "==> Zaxira nusxa (yangilashdan oldin)"
bash backup.sh

echo "==> Kod: $BRANCH"
git fetch --depth 1 origin "$BRANCH"
git checkout -B "$BRANCH" FETCH_HEAD
git log -1 --oneline

echo "==> Build"
docker compose build tools backend frontend

echo "==> Migratsiya"
docker compose run --rm tools npx prisma migrate deploy

echo "==> Qayta ishga tushirish"
docker compose up -d
docker image prune -f >/dev/null
docker compose ps
