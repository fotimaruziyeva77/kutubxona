# SIFAT LIBRARY — serverga o'rnatish (pilot)

Bitta server, `sifatlibrary.uz`, Docker. Tavsiya: **4 GB RAM, 2 CPU, 40 GB disk**, Ubuntu 22.04/24.04.

## 0. Server holatini ko'rish

```bash
cat /etc/os-release | head -2; nproc; free -h; df -h /; docker --version
```

## 1. DNS (domen panelida)

| Yozuv | Tur | Qiymat |
|---|---|---|
| `@` | A | `100.42.190.208` (eski `185.196.212.52` o'rniga) |
| `www` | CNAME | `sifatlibrary.uz` (o'zgarmaydi) |

`mail`, `ftp`, MX, SPF, DKIM yozuvlari kerak emas (email ishlatilmaydi) — o'chirsa ham bo'ladi.
TTL 14400 bo'lsa, yangi IP bir necha soatgacha tarqaladi. Tekshirish:

```bash
dig +short sifatlibrary.uz @1.1.1.1
```

`100.42.190.208` chiqmaguncha 2-qadamni boshlamang. Aks holda HTTPS sertifikat olinmaydi.

## 2. O'rnatish

Serverga SSH orqali kiring va bajaring:

```bash
curl -fsSL https://raw.githubusercontent.com/fotimaruziyeva77/kutubxona/feature/frontend-fixes/deploy/install.sh -o install.sh
sudo bash install.sh
```

Skript swap qo'shadi, Docker o'rnatadi, kodni `/srv/sifat` ga yuklaydi va `deploy/.env` ni tasodifiy sirlar bilan yaratadi. So'ng build qiladi (birinchi marta 10–20 daqiqa), migratsiya va geo seed'ni bajaradi va saytni ishga tushiradi.
**Demo akkauntlar yaratilmaydi.**

## 3. Birinchi super admin

```bash
cd /srv/sifat/deploy && sudo bash create-admin.sh
```

Telefon, ism, sana, jins va parol so'raladi. Keyin `https://sifatlibrary.uz/uz-Latn/login` orqali kiring. Qolgan adminlar, kutubxonalar va kutubxonachilar panel ichidan yaratiladi.

## Kundalik buyruqlar (`/srv/sifat/deploy` ichida)

| Vazifa | Buyruq |
|---|---|
| Holat | `docker compose ps` |
| Loglar | `docker compose logs -f --tail 100 backend` |
| Yangilash | `sudo bash update.sh` |
| Zaxira nusxa | `sudo bash backup.sh` |
| Qayta ishga tushirish | `docker compose restart backend frontend` |
| Xotira | `docker stats --no-stream` |

Har kuni avtomatik zaxira olish uchun: `sudo crontab -e` va qator qo'shing:
`0 3 * * * cd /srv/sifat/deploy && bash backup.sh >/dev/null 2>&1`

## Integratsiya kalitlari

Kalitlar `deploy/.env` faylida turadi. Hozir ularning o'rnida `not-configured` yozilgan. Kalit kelganda:

```bash
sudo nano /srv/sifat/deploy/.env
docker compose up -d backend
```

| Kalit | Usiz ishlamaydigan funksiya |
|---|---|
| `ESKIZ_*` | **SMS: telefon orqali ro'yhatdan o'tish (OTP)**, eslatmalar |
| `PAYME_*`, `CLICK_*` | Obuna va donat to'lovlari |
| `SMTP_*` | Email bildirishnomalar, PDF hisobotlarni yuborish |
| `FCM_SERVICE_ACCOUNT_KEY_PATH` | Push bildirishnomalar (hozir `disabled`; kalit faylini `deploy/secrets/fcm.json` ga qo'yib, qiymatni `/app/apps/backend/secrets/fcm.json` qiling) |
| `IDUZ_*` | ID.UZ (OneID) orqali kirish |

> **Muhim:** Eskiz kaliti kelmaguncha kitobxonlar ro'yhatdan o'ta olmaydi. Ro'yhat faqat SMS kod bilan ishlaydi, admin panel esa faqat xodim akkauntlarini yaratadi (viloyat/tuman/muassasa admini, kutubxonachi). Kitobxonlar bilan pilot boshlashdan oldin Eskiz kalitini oling.

## Hozircha cheklovlar

- **Vault** dev rejimida ishlaydi. Sirlar `.env` da (`chmod 600`) turadi.
- **Elasticsearch** o'chiq. Qidiruv PostgreSQL orqali ishlaydi.
- **MinIO** rasmiy image Docker Hub'dan olib tashlangan — `pgsty/minio` (jamoa fork'i) ishlatiladi.
- **Monitoring** (Grafana/Prometheus) o'rnatilmagan. Holatni `docker compose ps` va loglar orqali kuzating.
- Yuklangan fayllar (debat va kitob burchagi rasmlari) MinIO'da saqlanadi. MinIO tashqariga ochiq emas, shuning uchun bu fayllarni brauzerda ko'rsatish hali sozlanmagan.
- `.github/workflows/deploy-*.yml` `sifat.uz` uchun yozilgan va `main` ga push bo'lganda ishga tushadi. Bu serverga ular tegmaydi.
