#!/usr/bin/env bash
# Birinchi SUPER_ADMIN akkaunti (yoki mavjudining parolini yangilash).
#   sudo bash /srv/kutubxona/deploy/create-admin.sh
# Ma'lumotlar so'raladi; parol ekranda ko'rinmaydi va hech qayerga yozilmaydi.
set -euo pipefail
cd "$(dirname "$0")"

read -rp  "Telefon (+998XXXXXXXXX): " ADMIN_PHONE
read -rp  "Ism Familiya: " ADMIN_NAME
read -rp  "Tug'ilgan sana (YYYY-MM-DD): " ADMIN_DOB
read -rp  "Jins (MALE/FEMALE): " ADMIN_GENDER
read -rsp "Parol (kamida 12 belgi, katta+kichik harf, raqam): " ADMIN_PASSWORD; echo
read -rsp "Parolni takrorlang: " ADMIN_PASSWORD2; echo
[ "$ADMIN_PASSWORD" = "$ADMIN_PASSWORD2" ] || { echo "Parollar mos emas"; exit 1; }

export ADMIN_PHONE ADMIN_NAME ADMIN_DOB ADMIN_GENDER ADMIN_PASSWORD
docker compose run --rm \
  -e ADMIN_PHONE -e ADMIN_NAME -e ADMIN_DOB -e ADMIN_GENDER -e ADMIN_PASSWORD \
  tools node prisma/create-admin.js
