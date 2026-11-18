#!/usr/bin/env bash
# Kutubxonachi yoki muassasa admini yaratish va kutubxonaga bog'lash.
#   sudo bash /srv/kutubxona/deploy/create-staff.sh
# Parolni bo'sh qoldirsangiz — tasodifiy parol yaratiladi va bir marta ko'rsatiladi.
set -euo pipefail
cd "$(dirname "$0")"

echo "Rol: 1) Kutubxonachi  2) Muassasa admini"
read -rp "Tanlang [1]: " R
case "${R:-1}" in
  1) STAFF_ROLE=KUTUBXONACHI ;;
  2) STAFF_ROLE=MUASSASA_ADMIN ;;
  *) echo "1 yoki 2 ni tanlang"; exit 1 ;;
esac

read -rp  "Kutubxona kodi (bo'sh qoldirsangiz — ro'yxat chiqadi): " LIBRARY_CODE
read -rp  "Telefon (+998XXXXXXXXX): " STAFF_PHONE
read -rp  "Ism Familiya: " STAFF_NAME
read -rp  "Jins (MALE/FEMALE) [FEMALE]: " STAFF_GENDER
read -rsp "Parol (bo'sh = avtomatik yaratish): " STAFF_PASSWORD; echo

export STAFF_ROLE LIBRARY_CODE STAFF_PHONE STAFF_NAME STAFF_PASSWORD
export STAFF_GENDER="${STAFF_GENDER:-FEMALE}"
docker compose run --rm \
  -e STAFF_ROLE -e LIBRARY_CODE -e STAFF_PHONE -e STAFF_NAME -e STAFF_GENDER -e STAFF_PASSWORD \
  tools node prisma/create-staff.js
