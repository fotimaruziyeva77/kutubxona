#!/usr/bin/env bash
# Yangi versiyani o'rnatish (ma'lumotlar saqlanadi).
#   sudo bash /srv/kutubxona/deploy/update.sh
# Avval GitHub → Actions → pilot-images yashil bo'lganini tekshiring.
set -euo pipefail
cd "$(dirname "$0")"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

echo "==> Zaxira nusxa (yangilashdan oldin)"
bash backup.sh

echo "==> Kod: $BRANCH (compose/skriptlar uchun)"
git fetch origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
git log -1 --oneline

echo "==> Image'lar"
docker compose --profile tools pull

echo "==> Migratsiya"
docker compose run --rm tools npx prisma migrate deploy

echo "==> Qayta ishga tushirish"
docker compose up -d backend frontend
docker image prune -f >/dev/null
docker compose ps
