# SIFAT LIBRARY

## What This Is

O'zbekiston Respublikasi Prezidentining PQ-9-son qarori asosida ishlab chiqilayotgan milliy kitobxonlik monitoring, tahlil va boshqaruv platformasi. 2,000+ kutubxona va 5,000,000+ foydalanuvchini qamrab, aholining kitobxonlik darajasini yiliga 10 ta kitobga yetkazish maqsadida barcha kutubxona tizimini raqamlashtiradi, real vaqtda monitoring qiladi va davlat darajasida analitik qaror qabul qilishni ta'minlaydi.

## Core Value

Hududlar kesimida kitobxonlik indeksini real vaqtda hisoblash va shaffof reyting shakllantirib, davlat darajasida analitik qaror qabul qilishni ta'minlash.

## Requirements

### Validated

- ✓ Monorepo tuzilmasi (NestJS backend + Next.js frontend) — existing
- ✓ Docker Compose infratuzilma (PostgreSQL, Redis, Elasticsearch, Kafka, MinIO, Vault, Prometheus, Grafana) — existing
- ✓ Prisma ORM bilan database schema (users, libraries, books, transactions, reading_index, fraud_scores, subscriptions, invoices, payments, ai_audit_logs, risk_log) — existing
- ✓ JWT auth tizimi (access/refresh token, login, logout, OTP send/verify) — existing
- ✓ RBAC permission tizimi (9 rol, NestJS Guards) — existing
- ✓ Geografik ma'lumotlar API (14 viloyat, 200+ tuman, 10,000+ mahalla kaskad) — existing
- ✓ Kutubxona CRUD API (5 tip: GOV, SCH, UNI, ORG, MAH) — existing
- ✓ Kitob fondi CRUD API (ISBN, muallif, janr, til) — existing
- ✓ Kitob tranzaksiyalar API (bron, berish, qaytarish) — existing
- ✓ Landing Page (Hero, statistika, reytinglar, B2B blok, donat, hamkorlar) — existing
- ✓ 5-bosqichli ro'yhatdan o'tish wizard (Telefon → Ma'lumotlar → Manzil → Tur → Tayyor) — existing
- ✓ Login sahifasi (telefon + parol) — existing
- ✓ Admin dashboard (16 sidebar sahifa) — existing
- ✓ Statistika paneli UI (Umumiy, Janrlar, Yetishmovchilik, Viloyat tablari) — existing
- ✓ Smart Alert UI (KRITIK, OGOHLANTIRISH, AXBOROT darajalari) — existing
- ✓ Kitob qidirish (Elasticsearch, janr/til filtrlash, yaqinida) — existing
- ✓ QR/ISBN skaner sahifasi (kamera, manual input) — existing
- ✓ Top-100 sahifasi (yosh/gender filtrlash) — existing
- ✓ Donat moduli UI (summa, maqsad, donatchilar, sarflash tarixi) — existing
- ✓ AI NLP chat interfeysi (savol-javob, Fraud Detection, Model monitoring tablari) — existing
- ✓ Maktab paneli UI (maktab tanlash, statistika) — existing
- ✓ Jadidlar izidan klub UI (Monitoring, 20 kitob, Debatlar, Faolsiz klublar) — existing
- ✓ Oila kitobxonligi UI (profil, reyting, top oilalar, qoidalar) — existing
- ✓ Idora paneli UI — existing
- ✓ OTM paneli UI — existing
- ✓ Buxgalter paneli UI (Umumiy, Fakturalar, Subscriptionlar, oylik trend) — existing
- ✓ Do'kon kabineti UI (telefon + ISBN kiritish) — existing
- ✓ Demo so'rash B2B formi — existing
- ✓ PWA va Service Worker asosi — existing
- ✓ Ko'p tillilik asosi (uz-Latn, uz-Cyrl, ru, kaa) — existing
- ✓ SEO asoslari (sitemap.ts, robots.ts, OpenGraph) — existing
- ✓ 20 ta backend controller (auth, users, libraries, books, transactions, reading, top, admin, ai, school, club, family, idora, otm, store, donate, payment, geo, auth/iduz) — existing

### Active

- [ ] Auth sahifalarni locale prefixsiz ishlashi (middleware redirect)
- [ ] Dashboard stat kartalar backend API bilan bog'lanishi
- [ ] Reading Index engine (5 komponent formulasi, scheduled job)
- [ ] Top-100 Final Score hisoblash va tasdiqlash jarayoni
- [ ] Fraud Detection ML modeli (Random Forest / XGBoost)
- [ ] AI NLP backend (RAG, vector DB, GPT-4 integratsiya)
- [ ] Predictive Analytics (ARIMA/Prophet)
- [ ] Root Cause Analysis moduli
- [ ] Payme to'lov integratsiyasi
- [ ] Click to'lov integratsiyasi
- [ ] Hisob-faktura PDF generatsiya
- [ ] Kutubxona Roaming (inter-library)
- [ ] Comprehension test tizimi
- [ ] Gamification badge tizimi
- [ ] Interaktiv xarita (Leaflet.js)
- [ ] Oylik PDF hisobot generatsiya
- [ ] Excel import to'liq ishlashi (kitob fondi)
- [ ] Push bildirishnomalar (Firebase FCM)
- [ ] SMS OTP integratsiya (Eskiz.uz)
- [ ] ID.UZ PKCE OAuth2.0
- [ ] Offline rejim to'liq (12 soat, 2G optimizatsiya)
- [ ] Qoraqalpoq va Rus tili tarjimalari
- [ ] Load testing (50,000 bir vaqtda foydalanuvchi)
- [ ] Security penetration testing (OWASP Top 10)
- [ ] Accessibility (WCAG 2.1)

### Out of Scope

- Mobil ilova (native iOS/Android) — Web-first, PWA yetarli, V2.0+ da ko'riladi
- Audiokitob moduli — Murakkablik yuqori, asosiy funksionalgaemas
- Real-time chat — Kitobxonlik platformasi uchun kerak emas
- Video streaming — Bandwidth/storage xarajatlari yuqori
- Blockchain/NFT — Texnologik murakkablik, foyda kam

## Context

- **Buyurtmachi:** Yoshlar ishlari agentligi
- **Huquqiy asos:** PQ-9-son qarori (2026-01-15) — 18/23 raqamlashtiriladigan band platformada qoplangan
- **Muddat:** 20 hafta (10 Sprint), hozir Sprint 4-5 darajasida
- **Maqsadli foydalanuvchilar:** 5,000,000+ (barcha yoshdagi kitobxonlar, kutubxonachilar, maktab/OTM/idora adminlari)
- **Hududiy qamrov:** 14 viloyat, 200+ tuman, 10,000+ mahalla
- **Mavjud infratuzilma:** Monorepo ishlayapti, 27 frontend sahifa, 20 backend controller, DB seeded
- **Asosiy muammo:** Frontend UI juda yaxshi, lekin backend biznes logikasi (RI hisoblash, fraud, to'lov, AI) ko'p qismi scaffold darajasida

## Constraints

- **Server lokalizatsiyasi:** O'zbekiston qonuni — barcha shaxsiy ma'lumotlar O'zbekiston serverlarida (Unicon.uz / TIF DC)
- **Tillar:** MVP da uz-Latn/uz-Cyrl majburiy, V1.0 da Qoraqalpoq va Rus
- **Performance:** LCP < 2.5s, API p99 < 500ms, 50K bir vaqtda foydalanuvchi
- **Xavfsizlik:** OWASP Top 10, AES-256, bcrypt(12), audit log append-only
- **Privacy:** 14 yoshgacha bolalar ismlari yashiriladi, o'qish tarixini yashirish opsiyasi
- **Uptime:** 99.9% SLA
- **Internet:** Qishloq joylari uchun 2G/offline PWA majburiy

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| NestJS + Next.js monorepo | TypeScript end-to-end, modulli arxitektura | ✓ Good |
| PostgreSQL + Prisma | Type-safe ORM, relatsional ma'lumotlar | ✓ Good |
| Elasticsearch kitob qidiruvi | Full-text, fuzzy, o'zbek tili | ✓ Good |
| shadcn/ui + Tailwind | Tezkor UI, design system | ✓ Good |
| next-intl ko'p tillilik | App Router bilan yaxshi integratsiya | ✓ Good |
| Apache Kafka event streaming | AI real vaqt audit uchun | — Pending |
| Python FastAPI AI Engine | ML modellar uchun alohida service | — Pending |
| Payme + Click to'lov | O'zbekiston bozori uchun yagona variant | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-06 after initialization (brownfield audit)*
