#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SIFAT LIBRARY — serverga birinchi o'rnatish (Ubuntu 22.04/24.04, Debian 12)
#
#   curl -fsSL https://raw.githubusercontent.com/fotimaruziyeva77/kutubxona/feature/frontend-fixes/deploy/install.sh -o install.sh
#   sudo bash install.sh
#
# Nima qiladi:
#   1) RAM kam bo'lsa swap qo'shadi (build uchun)   4) deploy/.env yaratadi (sirlar)
#   2) Docker o'rnatadi (yo'q bo'lsa)                5) build + ishga tushirish
#   3) Kodni /srv/sifat ga yuklaydi                  6) migratsiya + geo/badge seed
# Demo akkauntlar YARATILMAYDI (NODE_ENV=production).
# Qayta ishga tushirish xavfsiz: mavjud .env va ma'lumotlar saqlanadi.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/fotimaruziyeva77/kutubxona.git}"
BRANCH="${BRANCH:-feature/frontend-fixes}"
APP_DIR="${APP_DIR:-/srv/sifat}"
DOMAIN="${DOMAIN:-sifatlibrary.uz}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mXATO: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root sifatida ishga tushiring: sudo bash install.sh"

# ── 1. Swap ──────────────────────────────────────────────────────────────────
mem_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
swap_mb=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
say "RAM: ${mem_mb} MB, swap: ${swap_mb} MB"
if [ "$mem_mb" -lt 6000 ] && [ "$swap_mb" -lt 2000 ]; then
  say "Swap 4 GB qo'shilmoqda (/swapfile)"
  fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 2. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Docker o'rnatilmoqda"
  apt-get update -y
  apt-get install -y ca-certificates curl git openssl
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || { apt-get update -y; apt-get install -y git; }
command -v openssl >/dev/null || { apt-get update -y; apt-get install -y openssl; }
docker compose version >/dev/null 2>&1 || die "docker compose plagini topilmadi"
systemctl enable --now docker >/dev/null 2>&1 || true

# ── 3. Kod ───────────────────────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  say "Kod yangilanmoqda ($BRANCH)"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" FETCH_HEAD
else
  say "Kod yuklanmoqda: $REPO_URL ($BRANCH)"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR/deploy"

# ── 4. .env ──────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  say ".env yaratilmoqda (tasodifiy sirlar)"
  cp .env.example .env
  while grep -q 'CHANGE_ME' .env; do
    sed -i "0,/CHANGE_ME/s//$(openssl rand -hex 32)/" .env
  done
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://${DOMAIN}#; s#^SITE_ADDRESS=.*#SITE_ADDRESS=${DOMAIN}#; s#^WWW_ADDRESS=.*#WWW_ADDRESS=www.${DOMAIN}#" .env
  chmod 600 .env
else
  say ".env mavjud — o'zgartirilmadi"
fi
mkdir -p backups

# ── 5. Firewall (ufw bo'lsa) ─────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
fi

# ── 6. Build va ishga tushirish ──────────────────────────────────────────────
say "Image'lar yig'ilmoqda (birinchi marta 10–20 daqiqa)"
docker compose build tools
docker compose build backend
docker compose build frontend

say "Baza va servislar ishga tushmoqda"
docker compose up -d postgres redis vault minio kafka

say "Migratsiya"
docker compose run --rm tools npx prisma migrate deploy

say "Seed: faqat geo (viloyat/tuman/mahalla) + badge katalogi"
docker compose run --rm tools npx ts-node --transpile-only prisma/seed.ts

say "Ilova ishga tushmoqda"
docker compose up -d

say "Backend tayyor bo'lishini kutish"
for i in $(seq 1 40); do
  if docker compose exec -T backend wget -qO- http://127.0.0.1:4000/health >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 5
done
[ "${ok:-0}" = 1 ] || { docker compose logs --tail 80 backend; die "backend ishga tushmadi (log yuqorida)"; }

docker compose ps
cat <<EOF

────────────────────────────────────────────────────────────────
 O'rnatildi.  Sayt: https://${DOMAIN}
 (DNS yangi IP ga o'tgan bo'lsa, HTTPS sertifikat 1–2 daqiqada olinadi)

 Keyingi qadam — birinchi super admin:
   cd ${APP_DIR}/deploy && sudo bash create-admin.sh
────────────────────────────────────────────────────────────────
EOF
