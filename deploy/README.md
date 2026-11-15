# SIFAT LIBRARY — serverga o'rnatish (pilot)

Domen: `sifatlibrary.uz`. Server: boshqa saytlar bilan umumiy (nginx + certbot allaqachon ishlab turibdi).

Qanday ishlaydi:

- Docker image'lar **GitHub Actions**'da yig'iladi (`pilot-images` workflow) va `ghcr.io` ga yuklanadi. Serverda build qilinmaydi, chunki RAM tanqis. Server image'larni faqat yuklab oladi.
- Ilova `127.0.0.1:3020` (frontend) va `127.0.0.1:4020` (backend) portlarida ishlaydi. Tashqaridan kirish mavjud nginx orqali bo'ladi: unga `sifatlibrary.uz` uchun alohida blok qo'shiladi, boshqa saytlarga tegilmaydi.
- Baza, Redis, MinIO, Vault va Kafka faqat Docker'ning ichki tarmog'ida ishlaydi, hech qanday port tashqariga ochilmaydi.
- Ishlab turgan holatda taxminan **600 MB RAM** sarflaydi (lokal sinov natijasi).

## 1. DNS (domen panelida)

| Yozuv | Tur | Qiymat |
|---|---|---|
| `@` | A | `100.42.190.208` (eski `185.196.212.52` o'rniga) |
| `www` | CNAME | `sifatlibrary.uz` (o'zgarmaydi) |

Tekshirish: `dig +short sifatlibrary.uz @1.1.1.1` buyrug'i `100.42.190.208` ni ko'rsatishi kerak.
DNS hali o'zgarmagan bo'lsa ham o'rnatishni boshlash mumkin. Bu holda HTTPS sertifikat keyin, 3-qadamdagi buyruq bilan olinadi.

## 2. O'rnatish

```bash
cd /srv/kutubxona && git fetch origin feature/frontend-fixes && git checkout feature/frontend-fixes
sudo bash deploy/install.sh
```

Skript quyidagilarni bajaradi:

1. `deploy/.env` faylini tasodifiy sirlar bilan yaratadi.
2. Image'larni yuklab oladi.
3. Migratsiya qiladi va geo ma'lumotlarni yuklaydi (demo akkauntlar yaratilmaydi).
4. Ilovani ishga tushiradi.
5. nginx blokini qo'shadi. Agar `nginx -t` xato bersa, blok darhol olib tashlanadi.
6. DNS tayyor bo'lsa, certbot orqali HTTPS sertifikat oladi.

## 3. HTTPS (agar 2-qadamda DNS hali tayyor bo'lmagan bo'lsa)

```bash
sudo certbot --nginx -d sifatlibrary.uz -d www.sifatlibrary.uz --redirect
```

## 4. Birinchi super admin

```bash
sudo bash /srv/kutubxona/deploy/create-admin.sh
```

Keyin `https://sifatlibrary.uz/uz-Latn/login` sahifasidan kiring.

## Kundalik buyruqlar (`/srv/kutubxona/deploy` ichida)

| Vazifa | Buyruq |
|---|---|
| Holat | `docker compose ps` |
| Loglar | `docker compose logs -f --tail 100 backend` |
| Yangilash (GitHub'da `pilot-images` yashil bo'lgach) | `sudo bash update.sh` |
| Zaxira nusxa | `sudo bash backup.sh` |
| Xotira sarfi | `docker stats --no-stream \| grep kutubxona` |

Har kuni avtomatik zaxira olish uchun `sudo crontab -e` buyrug'ini bering va quyidagi qatorni qo'shing:
`0 3 * * * cd /srv/kutubxona/deploy && bash backup.sh >/dev/null 2>&1`

## Image yuklanmasa

`docker compose pull` "denied" yoki "unauthorized" xatosini bersa, ghcr.io dagi paket yopiq bo'lishi mumkin. Ikki yechim bor:

- **GitHub orqali paketni ochish:** profil → Packages → `kutubxona-backend`, `kutubxona-frontend`, `kutubxona-tools` → Package settings → Change visibility → Public.
- **Serverda kirish:** `docker login ghcr.io -u fotimaruziyeva77` buyrug'ini bering. Parol o'rnida `read:packages` huquqli Personal Access Token kiritiladi.

## Integratsiya kalitlari

Kalitlar `deploy/.env` faylida turadi va hozir ularning o'rnida `not-configured` yozilgan. Kalit kelganda faylni tahrirlang va backendni qayta ishga tushiring:

```bash
sudo nano /srv/kutubxona/deploy/.env
cd /srv/kutubxona/deploy && docker compose up -d backend
```

| Kalit | Usiz ishlamaydigan funksiya |
|---|---|
| `TELEGRAM_GATEWAY_TOKEN` | **Ro'yhatdan o'tish va parol tiklash kodi** (`OTP_CHANNEL=telegram`) |
| `ESKIZ_*` | SMS eslatmalar (va `OTP_CHANNEL=sms` bo'lsa ro'yhat kodi) |
| `PAYME_*`, `CLICK_*` | Obuna va donat to'lovlari |
| `SMTP_*` | Email bildirishnomalar, PDF hisobotlarni yuborish |
| `FCM_SERVICE_ACCOUNT_KEY_PATH` | Push bildirishnomalar. Hozir `disabled`. Kalit kelganda faylni `deploy/secrets/fcm.json` ga qo'ying va qiymatni `/app/apps/backend/secrets/fcm.json` ga o'zgartiring |
| `IDUZ_*` | ID.UZ (OneID) orqali kirish |

> **Muhim:** `TELEGRAM_GATEWAY_TOKEN` qo'yilmaguncha kitobxonlar ro'yhatdan o'ta olmaydi, chunki ro'yhat tasdiqlash kodi bilan ishlaydi.
> Token olish: https://gateway.telegram.org → Telegram raqamingiz bilan kiring → balansni to'ldiring → **API** bo'limidan tokenni nusxalang.
> Kod faqat Telegram'da ro'yhatdan o'tgan raqamlarga keladi. Admin panel esa faqat xodimlarni yaratadi: viloyat, tuman va muassasa adminlari hamda kutubxonachilar.

## Hozircha cheklovlar

- **Vault** dev rejimida ishlaydi. Sirlar `.env` faylida (`chmod 600`) saqlanadi.
- **Elasticsearch** o'chiq. Qidiruv PostgreSQL orqali ishlaydi.
- **MinIO**: rasmiy image Docker Hub'dan olib tashlangan, shuning uchun `pgsty/minio` (jamoa fork'i) ishlatiladi.
- **Monitoring** (Grafana/Prometheus) o'rnatilmagan.
- Debat va kitob burchagi rasmlari MinIO'da saqlanadi, lekin ularni brauzerda ko'rsatish hali sozlanmagan.
- `.github/workflows/deploy-*.yml` fayllari `sifat.uz` uchun yozilgan va `main` branch'ga push bo'lganda ishga tushadi. Merge qilishdan oldin ularni o'chirish yoki o'zgartirish kerak.
