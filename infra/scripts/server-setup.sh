#!/bin/bash
# Server birinchi marta sozlash skripti
# Ishlatish: sudo bash server-setup.sh dev|staging
set -euo pipefail

ENV=${1:-dev}
DOMAIN="${ENV}.sifat.uz"

echo "=== SIFAT LIBRARY server sozlash: $DOMAIN ==="

# Docker o'rnatish
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# Nginx o'rnatish
apt-get update -qq
apt-get install -y nginx certbot python3-certbot-nginx ufw

# Firewall
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Nginx konfiguratsiya
cp "infra/nginx/nginx.conf" /etc/nginx/nginx.conf
cp "infra/nginx/sites/${DOMAIN}.conf" /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# SSL (Let's Encrypt)
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@sifat.uz

# Systemd service — backend
cat > /etc/systemd/system/sifat-backend.service <<EOF
[Unit]
Description=SIFAT Library Backend
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/sifat/apps/backend
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Systemd service — frontend
cat > /etc/systemd/system/sifat-frontend.service <<EOF
[Unit]
Description=SIFAT Library Frontend
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/sifat/apps/frontend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production PORT=3000

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sifat-backend sifat-frontend

echo "=== Sozlash tugadi: https://$DOMAIN ==="
