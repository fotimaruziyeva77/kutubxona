# SIFAT LIBRARY — Ma'lumotlar Himoyasi Holati (M6)

> Bu hujjat AUDIT-REPORT.md M6 topilmasiga javoban yozilgan: TZ (CLAUDE.md §VIII.3)
> "Shaxsiy ma'lumotlar AES-256-GCM bilan shifrlanadi" deb da'vo qiladi, lekin kodda
> maydon darajasidagi shifrlash YO'Q. Quyida hozirgi haqiqiy holat, nima uchun
> maydon-darajali shifrlash V1.0 da qilinmagani va majburiy yo'l xaritasi.

## 1. Hozirgi haqiqiy holat (2026-06-10)

| Ma'lumot | Himoya | Holat |
|---|---|---|
| Parollar | bcrypt (salt 12) | ✅ Hech qachon plaintext saqlanmaydi |
| Refresh tokenlar | SHA-256 hash (P2 fix) | ✅ DB sizishi tokenni bermaydi |
| OTP kodlari | 2 daqiqa TTL, log'larda maskalangan (P0 fix) | ✅ |
| QR tokenlar | HMAC-SHA256, 5 daqiqa rotatsiya (P2 fix) | ✅ |
| Do'kon HMAC secretlari | DB'da plaintext | ⚠️ Vault'ga ko'chirish — V2 |
| Backup | AES-256-CBC (BACKUP_ENCRYPTION_KEY berilsa) | ⚠️ Kalitsiz — faqat gzip |
| **PII: telefon, ism, DOB, manzil (ko'cha/uy/xonadon), PINFL** | **PostgreSQL'da plaintext** | ❌ Maydon shifrlash yo'q |

## 2. Nima uchun maydon-darajali shifrlash V1.0 da yo'q

Bu texnik qarz emas, ongli arxitektura qarori — quyidagi funksiyalar PII ustunlarida
**SQL darajasida tenglik/diapazon so'rovlari** talab qiladi:

- **Oila moduli**: xonadon aniqlash `viloyat+tuman+mahalla+ko'cha+uy+xonadon` bo'yicha
  EXACT MATCH qiladi (family.service). Randomizatsiyalangan AES-GCM bilan bu so'rov ishlamaydi.
- **Yosh kategoriyalari**: 7-14/15-30/31-60/60+ reytinglari `dob` ustunida diapazon filtri.
- **Telefon**: login kaliti, `findUnique({phone})`.
- **Voyaga yetmaganlarni maskalash**: har so'rovda dob o'qiladi.

Deterministik shifrlash yoki blind-index (HMAC indeks ustunlari) bilan yechiladi,
lekin bu migratsiya + barcha so'rov yo'llarini qayta yozish = alohida faza (pastda).

## 3. Majburiy yo'l xaritasi

**Darhol (deploy talabi) — infratuzilma darajasida shifrlash:**
1. Unicon.uz/TIF DC serverlarida PostgreSQL data volume **LUKS (AES-256-XTS)** bilan
   shifrlanishi SHART — `/srv/sifat/data/postgres` bind-mount shifrlangan diskda bo'lsin.
2. Backuplar uchun `BACKUP_ENCRYPTION_KEY` production'da MAJBURIY o'rnatilsin
   (infra/postgres/backup.sh allaqachon qo'llaydi; kalit Vault'da saqlansin).
3. TLS 1.3 hamma joyda (nginx allaqachon majburlaydi).

Bu kombinatsiya "data at rest AES-256" talabini **disk darajasida** qondiradi va
buyurtmachi oldida halol pozitsiya: "maydon emas, disk darajasida shifrlangan".

**V2 (alohida faza) — maydon-darajali:**
- `pinfl`, `street/house/apartment` → AES-256-GCM + HMAC blind-index ustunlar
  (oila matching blind-index orqali).
- Kalitlar HashiCorp Vault transit engine orqali (kod allaqachon Vault'ga ulangan).
- `dob` → yil granulyatsiyasida ochiq `birthYear` ustun (reyting uchun) + shifrlangan to'liq sana.

## 4. Buyurtmachi bilan kommunikatsiya

TZ §VIII.3 jadvalini quyidagicha tushunish/yangilash tavsiya etiladi:
"Shaxsiy ma'lumotlar — AES-256 (disk darajasida, LUKS) + V2'da maydon darajasiga o'tish".
Hozirgi matn ("PostgreSQL (encrypted)") amaldagi holatga mos kelmaydi va
mustaqil audit/pentest'da e'tiroz keltirib chiqaradi (R9).
