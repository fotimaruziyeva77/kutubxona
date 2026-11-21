#!/usr/bin/env bash
# Admin paneldagi "Yangilash" tugmasini ishga tushiradi (bir marta o'rnatiladi).
#   sudo bash /srv/kutubxona/deploy/install-updater.sh
#
# Qanday ishlaydi: backend deploy/control/update-request faylini yozadi →
# systemd uni ko'radi → deploy/update.sh ishga tushadi → natija
# control/update-status va control/update.log ga yoziladi (panel ko'rsatadi).
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTROL="$DEPLOY_DIR/control"

mkdir -p "$CONTROL"
chown 1001:1001 "$CONTROL"   # backend konteyneri (sifat, uid 1001) yoza olsin
chmod 750 "$CONTROL"

cat > /usr/local/bin/kutubxona-update-run <<EOF
#!/usr/bin/env bash
cd "$DEPLOY_DIR"
rm -f control/update-request
echo running > control/update-status
if bash update.sh > control/update.log 2>&1; then
  echo ok > control/update-status
else
  echo failed > control/update-status
fi
chown 1001:1001 control/update-status control/update.log
EOF
chmod 755 /usr/local/bin/kutubxona-update-run

cat > /etc/systemd/system/kutubxona-update.service <<EOF
[Unit]
Description=SIFAT LIBRARY yangilash (admin paneldan)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/kutubxona-update-run
EOF

cat > /etc/systemd/system/kutubxona-update.path <<EOF
[Unit]
Description=SIFAT LIBRARY yangilash so'rovini kuzatish

[Path]
PathExists=$CONTROL/update-request
Unit=kutubxona-update.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now kutubxona-update.path
date -Iseconds > "$CONTROL/updater-installed"
chown 1001:1001 "$CONTROL/updater-installed"
echo "==> Tayyor. Endi admin paneldan (Bosh panel) yangilash mumkin."
