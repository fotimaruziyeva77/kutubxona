#!/bin/bash
# Rolling deploy skripti
# Ishlatish: bash deploy.sh dev|staging <git-sha>
set -euo pipefail

ENV=${1:-dev}
SHA=${2:-$(git rev-parse --short HEAD)}
DEPLOY_PATH="/opt/sifat"
APP_USER="deploy"

echo "=== Deploy: $ENV | SHA: $SHA ==="

# Artifact arxivni serverga nusxalash (GitHub Actions dan chaqiriladi)
rsync -az --delete \
  apps/backend/dist/ "$APP_USER@${ENV}.sifat.uz:$DEPLOY_PATH/apps/backend/dist/"

rsync -az --delete \
  apps/backend/node_modules/ "$APP_USER@${ENV}.sifat.uz:$DEPLOY_PATH/apps/backend/node_modules/"

rsync -az --delete \
  apps/frontend/.next/standalone/ "$APP_USER@${ENV}.sifat.uz:$DEPLOY_PATH/apps/frontend/"

rsync -az --delete \
  apps/frontend/.next/static/ "$APP_USER@${ENV}.sifat.uz:$DEPLOY_PATH/apps/frontend/.next/static/"

# Remote: Prisma migrate + servislarni restart
ssh "$APP_USER@${ENV}.sifat.uz" bash <<REMOTE
  cd $DEPLOY_PATH/apps/backend
  npx prisma migrate deploy
  systemctl restart sifat-backend

  systemctl restart sifat-frontend

  # Smoke test
  sleep 5
  curl -sf https://${ENV}.sifat.uz/api/docs > /dev/null || (echo "SMOKE TEST FAILED" && exit 1)
  echo "=== Deploy muvaffaqiyatli: https://${ENV}.sifat.uz ==="
REMOTE
