#!/usr/bin/env bash
# SUPER_ADMIN akkaunti yaratish (yoki mavjudining parolini yangilash).
#   sudo bash /srv/kutubxona/deploy/create-admin.sh
# Parolni bo'sh qoldirsangiz — server kuchli parol yaratadi va BIR MARTA ko'rsatadi.
# Parol hech qayerga yozilmaydi (fayl, log, tarix).
set -euo pipefail
cd "$(dirname "$0")"

read -rp  "Telefon (+998XXXXXXXXX): " ADMIN_PHONE
read -rp  "Ism Familiya: " ADMIN_NAME
read -rp  "Tug'ilgan sana (YYYY-MM-DD) [1990-01-01]: " ADMIN_DOB
read -rp  "Jins (MALE/FEMALE) [MALE]: " ADMIN_GENDER
read -rsp "Parol (bo'sh = avtomatik; aks holda kamida 12 belgi, katta+kichik harf, raqam): " ADMIN_PASSWORD; echo

GENERATED=0
if [ -z "$ADMIN_PASSWORD" ]; then
  # 14 ta harf/raqam + kafolatli katta harf, kichik harf va raqam
  ADMIN_PASSWORD="$(openssl rand -base64 32 | tr -dc 'A-HJ-NP-Za-km-z2-9' | head -c 14)Kp7"
  GENERATED=1
else
  read -rsp "Parolni takrorlang: " ADMIN_PASSWORD2; echo
  [ "$ADMIN_PASSWORD" = "$ADMIN_PASSWORD2" ] || { echo "Parollar mos emas"; exit 1; }
fi

export ADMIN_PHONE ADMIN_NAME ADMIN_PASSWORD
export ADMIN_DOB="${ADMIN_DOB:-1990-01-01}"
export ADMIN_GENDER="${ADMIN_GENDER:-MALE}"
docker compose run --rm \
  -e ADMIN_PHONE -e ADMIN_NAME -e ADMIN_DOB -e ADMIN_GENDER -e ADMIN_PASSWORD \
  tools node prisma/create-admin.js

echo ""
echo "  Kirish:  https://sifatlibrary.uz/uz-Latn/login"
echo "  Login:   $ADMIN_PHONE"
if [ "$GENERATED" = 1 ]; then
  echo "  Parol:   $ADMIN_PASSWORD"
  echo "  Parol faqat hozir ko'rsatildi — xavfsiz joyga saqlang (masalan, parol menejeriga)."
fi
