# SIFAT LIBRARY — O'zgarishlar Tarixi

Barcha muhim o'zgarishlar shu yerda qayd etiladi.  
Format: [Semantic Versioning](https://semver.org) asosida.

---

## [1.0.0] — 2026-05-08 🎉 V1.0 Production Release

### Qo'shildi (Sprint 10)
- **Do'kon API** — HMAC-SHA256 imzo bilan kitob do'koni webhook integratsiyasi
  - `POST /api/v1/store/purchases` — xarid qabul qilish
  - `POST /api/v1/store/confirm/:scanId` — kitobxon tasdiqlashi
  - `POST /api/v1/store/register` — yangi do'kon ro'yxatdan o'tkazish
  - Do'kon statistika paneli (top kitoblar, oylik trend)
- **OTM moduli** — Oliy ta'lim muassasalari uchun to'liq panel
  - Talabalar ro'yhati, tasdiqlash, kurs bo'yicha filtrlash
  - Ilmiy adabiyotlar boshqaruvi
  - Akkreditatsiya hisoboti PDF
  - OTM reytingi
- **ID.UZ integratsiya** — PKCE OAuth2.0 flow
  - `GET /api/v1/auth/iduz/authorize` — authorization URL
  - `POST /api/v1/auth/iduz/callback` — token almashtirish + avtomatik ro'yhat
- **Ko'p tillilik** — Rus va Qoraqalpoq tili qo'shildi (`ru.json`, `kaa.json`)
- **SEO** — `sitemap.xml`, `robots.txt`, OpenGraph meta teglar, Twitter Card
- **Docker Production** — `docker-compose.prod.yml` + Nginx production config
  - Zero-downtime rolling update
  - Rate limiting, security headers
  - Gzip kompressiya, proxy caching
- **k6 Load Test** — 50,000 foydalanuvchi yuklamasi testi (`k6/load-test.js`)

### O'zgartirildi
- `i18n.ts` — `locales` massiviga `"ru"` va `"kaa"` qo'shildi
- Layout metadata — `generateMetadata()` funksiyasi qo'shildi (4 tilli)
- `AuthModule` — `IduzController` va `IduzService` qo'shildi

---

## [0.9.0] — 2026-04-25 (Sprint 9 — Idora va To'lov)

### Qo'shildi
- **Idora admin moduli** — Xodimlar, bo'limlar, oylik ichki reyting
  - `GET /api/v1/idora/:id/employees` — xodimlar ro'yhati
  - `POST /api/v1/idora/:id/rating/compute` — reyting hisoblash
  - `GET /api/v1/idora/:id/report/pq9` — PQ-9 hisoboti PDF
- **Kitob o'qish soati** — Tadbir yaratish, QR attendance
- **Kitob burchagi** — Foto tasdiqlash, 90 kunlik eslatma
- **Kasb adabiyotlar** — Bo'lim bo'yicha tavsiya kitoblar
- **Payme integratsiya** — JSON-RPC 2.0 Merchant API webhook
- **Click integratsiya** — Prepare + Complete flow
- **Hisob-faktura generatsiya** — PDF faktura (Puppeteer)
- **Buxgalter paneli** — To'lovlar, fakturalar, CSV export
- **To'lov eslatma** — 30/15/7/1 kun oldin email + SMS

### Database
- Yangi modellar: `Department`, `BookCorner`, `ReadingHour`, `ReadingHourAttendee`, `ProfBook`, `OrgRating`

---

## [0.8.0] — 2026-04-11 (Sprint 8 — AI tizimi)

### Qo'shildi
- **Fraud Detection** — Random Forest modeli, Risk Score 0-100
- **Real Vaqt Audit Engine** — Kafka → Python FastAPI → dashboard
- **NL Interface** — O'zbek tilida savollar, RAG arxitektura
- **Predictive Analytics** — ARIMA/Prophet, 1 oylik bashorat
- **Root Cause Analysis** — Avtomatik sabab tahlili
- **AI kitob tavsiyalari** — Collaborative + Content-based filtering
- **Top-100 AI tekshiruvi** — Oyning 29-kunida avtomatik fraud scan

---

## [0.7.0] — 2026-03-28 (Sprint 7 — Maktab, Klub, Oila)

### Qo'shildi
- **Maktab admin moduli** — O'quvchilar, sinf filtri, tasdiqlash
- **Maktab statistika** — Qamrov %, RI taqsimoti, 10 kitob maqsadi
- **Jadidlar izidan klublari** — Klub CRUD, a'zolik, debat qayd
- **20 kitob maqsadi monitoring** — Choraklik progress
- **Oila moduli** — Yaratish, taklif, oiladan chiqish
- **Oila reytingi** — Top oilalar, oylik hisoblash
- **Maktab reytingi** — Respublika bo'yicha Top-100 maktab
- **PQ-9 hisoboti** — PDF (Jadidlar izidan + RI + klub holati)

---

## [0.6.0] — 2026-03-14 (Sprint 6 — Statistika va Landing Page)

### Qo'shildi
- **4 darajali statistika** — Mahalla → Tuman → Viloyat → Respublika
- **Interaktiv xarita** — Leaflet.js, RI bo'yicha ranglangan
- **Kitob yetishmovchiligi tahlili** — Top-5 so'ralgan lekin yo'q kitoblar
- **Smart Alert tizimi** — Email + SMS + push ogohlantirishlar
- **Landing Page** — Hero, statistika, reyting, B2B, do'konlar, donat bloki
- **Oylik PDF hisobot** — Avtomatik generatsiya, emailga yuborish
- **Performance** — Lighthouse 90+, Bundle < 200KB

---

## [0.5.0] — 2026-02-28 (Sprint 5 — Reading Index va Top-100)

### Qo'shildi
- **Reading Index Engine** — 5 komponentli formula, har kecha 00:00 hisoblash
- **Mutolaa API** — O'qilgan sahifalar sinxronlash (0.85x koeffitsient)
- **Top-100 Final Score** — 6 komponentli formula, oylik jarayon
- **Ochiq reyting sahifasi** — 15 ta reyting kategoriyasi
- **Donat moduli** — Payme + Click, shaffof sarflash
- **Badge tizimi** — 15+ badge
- **Real vaqt reyting** — WebSocket, jonli yangilanish
- **Top-100 tasdiqlash** — 4 bosqichli jarayon

---

## [0.4.0] — 2026-02-14 (Sprint 4 — Kitob Jarayonlari)

### Qo'shildi ⭐ MVP
- **Bron → Olish → Qaytarish** — To'liq kitob jarayoni
- **Kutubxona Roaming** — Boshqa viloyatda kitob olish, inter-library return
- **Kitob limitlari** — Foydalanuvchi turi bo'yicha, Trust Score bonus
- **Muddati o'tgan kitoblar** — SMS eslatma, blok
- **ISBN scan** — Sotib olingan kitob + comprehension test
- **Comprehension test** — Random savollar, 3 urinish
- **Push bildirishnomalar** — Firebase FCM

---

## [0.3.0] — 2026-01-31 (Sprint 3 — Kutubxona)

### Qo'shildi
- **Kutubxona CRUD** — 5 tip, ierarxik ID
- **Fond yuklanishi** — Excel import (500+ kitob)
- **ISBN validatsiya** — Open Library / Google Books avtoto'ldirish
- **Kitob qidiruv** — Elasticsearch full-text + fuzzy
- **Joylashuvga asoslangan qidiruv** — Yaqin kutubxona + do'kon
- **QR skan (PWA)** — Kamera bilan foydalanuvchi QR
- **Offline rejim** — Service Worker, IndexedDB, 12 soat

---

## [0.2.0] — 2026-01-17 (Sprint 2 — Auth)

### Qo'shildi
- **SMS OTP** — Eskiz.uz API, 2 daqiqa muddati, rate limiting
- **JWT Auth** — Access (15min) + Refresh (30 kun), token rotation
- **Ro'yhat jarayoni** — 5 qadam: telefon, shaxsiy, manzil, tip, tasdiq
- **Unikal ID** — `SL-UZ-[V]-[T]-[M]-[N]` format, QR kod
- **RBAC** — 9 rol, NestJS Guard lar
- **Profil sahifasi** — QR yuklab olish, statistika

---

## [0.1.0] — 2026-01-03 (Sprint 1 — Infratuzilma)

### Qo'shildi
- Monorepo tuzilmasi (NestJS backend + Next.js 14 frontend)
- Docker Compose — PostgreSQL, Redis, Elasticsearch, Kafka, MinIO
- PostgreSQL schema — 11 ta jadval, Prisma ORM
- GitHub Actions CI/CD pipeline
- Dev + Staging server (dev.sifat.uz, staging.sifat.uz)
- HashiCorp Vault — secrets management
- Prometheus + Grafana + Sentry monitoring
- Redis + BullMQ queue tizimi
- Elasticsearch indekslar — o'zbek tili analyzer

---

*SIFAT LIBRARY — O'zbekiston Respublikasi Yoshlar ishlari agentligi uchun*  
*PQ-9-son qaror asosida ishlab chiqilgan | 2026*
