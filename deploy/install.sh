#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SIFAT LIBRARY — serverga birinchi o'rnatish (boshqa saytlar bor server)
#
#   sudo bash /srv/kutubxona/deploy/install.sh
#
# Talablar (serverda allaqachon bor): Docker + compose, nginx, certbot.
# Nima qiladi:
#   1) kodni feature/frontend-fixes branch'ga o'tkazadi
#   2) deploy/.env yaratadi (tasodifiy sirlar)
#   3) tayyor image'larni ghcr.io dan yuklaydi (serverda build YO'Q)
#   4) baza: migratsiya + geo/badge seed (demo akkauntlar YO'Q)
#   5) ilovani 127.0.0.1:3020 / :4020 da ishga tushiradi
#   6) nginx'ga sifatlibrary.uz blokini qo'shadi (nginx -t xato bersa — darhol
#      olib tashlanadi, boshqa saytlarga tegmaydi), DNS tayyor bo'lsa certbot
# Qayta ishga tushirish xavfsiz: mavjud .env va ma'lumotlar saqlanadi.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BRANCH="${BRANCH:-feature/frontend-fixes}"
DOMAIN="${DOMAIN:-sifatlibrary.uz}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$DEPLOY_DIR")"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mXATO: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root sifatida ishga tushiring: sudo bash install.sh"
command -v docker >/dev/null || die "docker topilmadi"
docker compose version >/dev/null 2>&1 || die "docker compose plagini topilmadi"
command -v nginx >/dev/null || die "nginx topilmadi"

# ── 1. Kod ───────────────────────────────────────────────────────────────────
say "Kod: $BRANCH ($APP_DIR)"
git -C "$APP_DIR" fetch origin "$BRANCH"
git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
git -C "$APP_DIR" log -1 --oneline
cd "$DEPLOY_DIR"

# ── 2. .env ──────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  say ".env yaratilmoqda (tasodifiy sirlar)"
  cp .env.example .env
  while grep -q 'CHANGE_ME' .env; do
    sed -i "0,/CHANGE_ME/s//$(openssl rand -hex 32)/" .env
  done
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://${DOMAIN}#" .env
  chmod 600 .env
else
  say ".env mavjud — o'zgartirilmadi"
fi
mkdir -p secrets backups
FRONTEND_PORT=$(grep -E '^FRONTEND_PORT=' .env | cut -d= -f2); FRONTEND_PORT=${FRONTEND_PORT:-3020}
BACKEND_PORT=$(grep -E '^BACKEND_PORT=' .env | cut -d= -f2); BACKEND_PORT=${BACKEND_PORT:-4020}

# Portlar bo'shmi? (o'zimizning konteynerlar bo'lsa — normal)
for p in "$FRONTEND_PORT" "$BACKEND_PORT"; do
  if ss -tln | grep -q ":$p " && ! docker compose ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$p->"; then
    die "127.0.0.1:$p band — .env da FRONTEND_PORT/BACKEND_PORT ni boshqa bo'sh portga o'zgartiring"
  fi
done

# ── 3. Image'lar ─────────────────────────────────────────────────────────────
say "Image'lar yuklanmoqda (ghcr.io)"
if ! docker compose --profile tools pull; then
  die "Image yuklanmadi. GitHub → Actions → pilot-images muvaffaqiyatli tugaganini
  tekshiring. Paket yopiq bo'lsa: docker login ghcr.io (README, 'Image yuklanmasa')."
fi

# ── 4. Baza ──────────────────────────────────────────────────────────────────
say "Baza va ichki servislar"
docker compose up -d postgres redis vault minio kafka
say "Migratsiya"
docker compose run --rm tools npx prisma migrate deploy
say "Seed: faqat geo (viloyat/tuman/mahalla) + badge katalogi"
docker compose run --rm tools npx ts-node --transpile-only prisma/seed.ts

# ── 5. Ilova ─────────────────────────────────────────────────────────────────
say "Ilova ishga tushmoqda"
docker compose up -d backend frontend
ok=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${BACKEND_PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || { docker compose logs --tail 80 backend; die "backend ishga tushmadi (log yuqorida)"; }

# ── 6. nginx + HTTPS ─────────────────────────────────────────────────────────
SITE=/etc/nginx/sites-available/${DOMAIN}
if [ -f "$SITE" ] && grep -q "listen 443" "$SITE"; then
  say "nginx: $SITE allaqachon HTTPS bilan — o'zgartirilmadi"
else
  say "nginx: $DOMAIN bloki qo'shilmoqda"
  sed -e "s/sifatlibrary\.uz/${DOMAIN}/g" \
      -e "s/127\.0\.0\.1:4020/127.0.0.1:${BACKEND_PORT}/g" \
      -e "s/127\.0\.0\.1:3020/127.0.0.1:${FRONTEND_PORT}/g" \
      nginx/sifatlibrary.uz.conf > "$SITE"
  ln -sf "$SITE" "/etc/nginx/sites-enabled/${DOMAIN}"
  if ! nginx -t; then
    rm -f "/etc/nginx/sites-enabled/${DOMAIN}"
    die "nginx -t xato — blok olib tashlandi, boshqa saytlar o'zgarmadi"
  fi
  systemctl reload nginx
fi

server_ip=$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
dns_ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
if [ -n "$dns_ip" ] && [ "$dns_ip" = "$server_ip" ]; then
  if ! grep -q "listen 443" "$SITE"; then
    say "HTTPS sertifikat (certbot)"
    certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --non-interactive --keep-until-expiring \
      || warn "certbot muvaffaqiyatsiz — keyinroq qo'lda: certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect"
  fi
else
  warn "DNS hali bu serverga ko'rsatmayapti ($DOMAIN → ${dns_ip:-topilmadi}, server: $server_ip).
   DNS o'zgargach bajaring:  certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect"
fi

docker compose ps
cat <<EOF

────────────────────────────────────────────────────────────────
 O'rnatildi.  Sayt: https://${DOMAIN}

 Keyingi qadam — birinchi super admin:
   sudo bash ${DEPLOY_DIR}/create-admin.sh
────────────────────────────────────────────────────────────────
EOF
