#!/usr/bin/env bash
# Saytni qo'shimcha domen orqali ham ochish (masalan vaqtinchalik subdomen).
#   sudo bash /srv/kutubxona/deploy/add-domain.sh kutubxona.sifatdev.uz
#
# 1) nginx bloki (www'siz) — nginx -t xato bersa darhol olib tashlanadi
# 2) domen CORS_ORIGINS ga qo'shiladi (.env) va backend qayta ishga tushadi
# 3) DNS shu serverga ko'rsatsa — certbot (HTTPS)
set -euo pipefail
D="${1:?Foydalanish: add-domain.sh <domen>}"
cd "$(dirname "$0")"
[ "$(id -u)" -eq 0 ] || { echo "sudo bilan ishga tushiring"; exit 1; }

FRONTEND_PORT=$(grep -E '^FRONTEND_PORT=' .env | cut -d= -f2); FRONTEND_PORT=${FRONTEND_PORT:-3020}
BACKEND_PORT=$(grep -E '^BACKEND_PORT=' .env | cut -d= -f2); BACKEND_PORT=${BACKEND_PORT:-4020}

# ── 1. nginx ────────────────────────────────────────────────────────────────
SITE=/etc/nginx/sites-available/$D
if [ -f "$SITE" ] && grep -q "listen 443" "$SITE"; then
  echo "==> nginx: $SITE allaqachon HTTPS bilan — o'zgartirilmadi"
else
  echo "==> nginx: $D"
  # Shablondan faqat asosiy server blokini olamiz (www-redirect blokisiz).
  awk 'BEGIN{n=0} /^server \{/{n++} n>=2' nginx/sifatlibrary.uz.conf \
    | sed -e "s/server_name sifatlibrary\.uz;/server_name $D;/" \
          -e "s/127\.0\.0\.1:4020/127.0.0.1:${BACKEND_PORT}/g" \
          -e "s/127\.0\.0\.1:3020/127.0.0.1:${FRONTEND_PORT}/g" > "$SITE"
  ln -sf "$SITE" "/etc/nginx/sites-enabled/$D"
  if ! nginx -t; then
    rm -f "/etc/nginx/sites-enabled/$D"
    echo "XATO: nginx -t — blok olib tashlandi, boshqa saytlar o'zgarmadi"; exit 1
  fi
  systemctl reload nginx
fi

# ── 2. CORS ─────────────────────────────────────────────────────────────────
PUBLIC_URL=$(grep -E '^PUBLIC_URL=' .env | cut -d= -f2)
CUR=$(grep -E '^CORS_ORIGINS=' .env | cut -d= -f2 || true)
[ -n "$CUR" ] || CUR="$PUBLIC_URL"
if ! echo ",$CUR," | grep -q ",https://$D,"; then
  NEW="$CUR,https://$D"
  if grep -qE '^CORS_ORIGINS=' .env; then
    sed -i "s#^CORS_ORIGINS=.*#CORS_ORIGINS=$NEW#" .env
  else
    echo "CORS_ORIGINS=$NEW" >> .env
  fi
  echo "==> CORS_ORIGINS=$NEW"
  docker compose up -d backend
fi

# ── 3. HTTPS ────────────────────────────────────────────────────────────────
if [ "$(dig +short "$D" @8.8.8.8 | tail -1)" = "$(curl -fsS4 https://api.ipify.org)" ]; then
  certbot --nginx -d "$D" --redirect --non-interactive --keep-until-expiring
  echo "==> Tayyor: https://$D"
else
  echo "!! $D hali bu serverga ko'rsatmayapti (dig +short $D @8.8.8.8). Keyinroq:"
  echo "   certbot --nginx -d $D --redirect"
fi
