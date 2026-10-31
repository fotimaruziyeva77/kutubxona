# SIFAT LIBRARY — Pilot rejasi (2026-10-29)

**Maqsad:** 2–4 hafta ichida 1–3 haqiqiy kutubxona bilan jonli pilot.
**Tartib:** 0 → 1 → 2. Mobil ilova (Expo) va taqdimot — pilotdan keyin.
**Holat manbai:** `XATOLIKLAR-2026-07.md` (iyul auditi) + 2026-10-29 tekshiruvi.

Bugungi avtomatik tekshiruv: backend `tsc` ✅ 0 xato · frontend `tsc` ✅ · `npm audit --omit=dev` ❌ 83 zaiflik (3 critical, 38 high, 41 moderate, 1 low) · frontend testlar — 0 ta · git repo — yo'q.

---

## 0-bosqich — Poydevor (1 kun)

- [x] `git init`, `.gitignore` tekshiruvi (`node_modules`, `.env*`, `.next`, `backup/`, `.swc/`, `node-compile-cache/`), birinchi commit — 2026-10-29, `d030e85`, 750 fayl
- [x] GitHub private repo — https://github.com/fotimaruziyeva77/kutubxona ; `main` va `develop` branch'lar push qilingan
- [ ] `main` himoyasi (**siz**, GitHub Settings → Branches): PR majburiy, CI status check majburiy, force-push taqiqlangan
- [x] Sirlar repo'ga tushmasin: `gitleaks` CI job'i (`.github/workflows/ci.yml`); tekshirildi — tarixda faqat `*.example` env fayllar
- [x] `backup/*.zip` — `.gitignore` da, repo'da yo'q
- [x] `.gitattributes` — barcha matn fayllar LF (Linux CI/Docker bilan bir xil)

**Qabul:** repo GitHub'da, CI PR'da ishga tushadi.

## 1-bosqich — Yashil CI, ishonchli yadro (1 hafta)

### Backend
- [x] **FR1** — dedup kaliti `bookId` → `book.isbn` (fallback bookId): `reading-score.util.ts` (`transactionWorkKey`), `top.service.ts`, `reading.service.ts` va `ri-recalc.processor.ts` select'lariga `isbn`; roaming testlari (reading-score + top spec) — 2026-10-29
- [x] **FR2** — `@@unique([libraryId, isbn])` + migratsiya `20261029120000_book_library_isbn_unique` (dublikatlarni birlashtiradi: nusxa sonlari + tranzaksiyalar keep-qatorga, keyin unique); dev DB'ga qo'llandi; `books.service.create` P2002 → 409; import'da `skipped` soni (backend + UI + 4 til)
- [x] **FR3** — `activity` 30 kunda distinct asar (kutubxona + skan bitta Set); `consistency` hafta bo'yicha qoladi (hafta o'zi distinct birlik) — testlar yangilandi
- [x] **D4** — `monthlyPartitionCleanup`: `cache.setNx("cron:ri-partition-monthly:YYYY-MM")`, 2 soat TTL; test
- [x] **D2** — cron endi `M+1…M+3` ni `IF NOT EXISTS` bilan yaratadi (avval faqat M+3); test
- [x] **D1** — `.env.prod.example` 26 kalit to'liq (PAYME_LOGIN, VAULT_*, SMTP_PASS, ESKIZ_*, FCM_*, MINIO_ACCESS/SECRET + 3 bucket); `scripts/check-prod-env.mjs` CI qadami
- [x] **T2** — flaky spec'ga `jest.setTimeout(60_000)` qo'yildi. 2026-10-29 natija (tuzatishdan oldin) — **2203 ✅ / 2 ❌** (2205 test, 102 suite, 7.4 daqiqa); yiqilgan ikkalasi ham `modules/books/__tests__/books-import.processor.spec.ts` da. Alohida yurgizilganda **5/5 o'tadi (16 s)**, to'liq suite'da 80 s → timeout — ya'ni kod regressiyasi emas, **flaky** test (Excel parse parallel yuklamada sekin). Fix: shu spec'ga `jest.setTimeout` / kichikroq workbook, yoki CI'da `--maxWorkers=50%`. Iyuldagi 23 ta yiqilishdan 21 tasi allaqachon yopilgan.
- [x] **npm audit** — 83 → 30 zaiflik (prod deps): ishlatilmaydigan `openai` va backend `zod` olib tashlandi; nodemailer 10, puppeteer-core 25 (`setContent waitUntil: "load"`), sharp 0.35; root `overrides` (multer 2.5, body-parser 1.20.9, lodash 4.18, js-yaml 4.3.2, @grpc/grpc-js, browserslist, basic-ftp); root'dagi tasodifiy deps o'chirildi; lockfile noldan qayta yechildi (2053 paket). Qolgan high/critical — faqat Next 14 (+ next'ga pin qilingan postcss, serwist'ning zod'i) → `audit-ci.jsonc` allowlist, sabab + mitigatsiya bilan: `images.unoptimized`, nginx `/_next/image → 404`. **Next 15.5/16 upgrade — alohida PR (qayta ko'rish 2026-12-01).**

### CI / infra
- [x] **T5** — har job root'dan `npm ci`; `audit` job (`audit-ci`), gitleaks job
- [x] **T4** — `tests/` CI'ga ulandi (2026-10-31). **k6:** ikkala skript eskirgan yo'llarga urardi (`/api/top/leaderboard`, `/api/stats/national` — backendda yo'q, 404) → haqiqiy yo'llar (`/api/top`, `/api/admin/stats/national`), `BASE_URL` default 4000, `VUS`/`DURATION` env, `setup()` da SUPER_ADMIN login (admin endpoint 200 bilan o'lchanadi; tokensiz 401 kutilgan). CI `e2e` job'ida `grafana/setup-k6-action` (Docker Hub'siz), backend `THROTTLE_LIMIT=100000` (bitta IP'dan 100/daqiqa limiti k6'ni 429 bilan to'xtatardi), 5 VU × 20 s. **Lokal k6 yurgizilmadi** (Docker Hub TLS timeout, binar yo'q) — endpoint'lar curl bilan tekshirildi (5/5 kutilgan status), birinchi haqiqiy k6 natijasi CI'da. **axe (JSDOM fixture):** `frontend` job'ida ~10 s sanity (`color-contrast` JSDOM'da o'chirildi — canvas yo'q). **axe (haqiqiy sahifalar, yangi):** `apps/frontend/e2e/a11y.spec.ts` — 9 sahifa (landing, top, login, register, donate, qidiruv, profil, kutubxonachi va muassasa dashboard'lari), critical/serious = qizil, moderate/minor hisobotga. Birinchi yurishda 9/9 qizil edi — tuzatildi (quyida). Hozir 9/9 yashil (lokal).
- [ ] **T6** — coverage'ga controller va guard'lar qo'shiladi
- [x] **D5** — Grafana dashboards mount qo'shildi (`docker-compose.prod.yml`)
- [x] **D6 (yangi, 2026-10-29)** — Dockerfile'lar root-kontekst + `npm ci --workspace=apps/<app>`; `.dockerignore`; `next.config.js` `outputFileTracingRoot` (standalone monorepo); `ci.yml` va `deploy-prod.yml` `context: .` + `file:` — lokal `docker build` sinovi natijasi quyida

### Frontend
- [x] Qidiruv: `?q=` (landing, kitobxon bosh sahifasi, tavsiyalar) va `?libraryId=` (kutubxona sahifasining «To'liq katalog» havolasi) `useSearchParams` bilan o'qiladi; Suspense chegarasi (`loading.tsx` skeleti); kutubxona chipi + «Barcha kutubxonalar» tozalash — 2026-10-31, brauzerda tekshirildi
- [x] Bron qilingandan keyin «keyingi qadam» oynasi (`ReservationNextSteps`): server `reservationExpiresAt` sanasi (Toshkent vaqti, raqamli — `fmtDayMonthTime`), kutubxona nomi/manzili/ish vaqti, «Bronlarim» va «QR kodim» (`/profile#qr` — pasport bo'limi avtomatik ochiladi). Profil «Bronlarim»da PENDING uchun «… gacha tasdiq kutiladi», RESERVED uchun «Kutubxonaga borib QR ko'rsating» + QR havola. Kutubxona sahifasi va kashfiyot blokida ishlaydi — 2026-10-31
- [x] Kutubxona profili: schema'da maydonlar allaqachon bor edi; **muassasa panelida tahrirlash formasi** (MUASSASA_ADMIN / SUPER_ADMIN; `PUT /libraries/:id`); ommaviy sahifada manzil/ish vaqti/telefon HAR DOIM ko'rsatiladi («—» bo'lsa ham), `tel:` havola, OpenStreetMap «Xaritada ochish»; sahifa 4 tilga o'tdi (`LibraryPage`). **Xavfsizlik (yangi):** `PUT /libraries/:id` egalikni tekshirmasdi — istalgan muassasa admini boshqa kutubxonani o'zgartira olardi (IDOR); endi `resolveCallerLibraryId` orqali 403 (4 test; jonli: boshqa kutubxona → 403, o'zi → 200) — 2026-10-31
- [x] Comprehension test: distraktor havzasi 3 → 10 (muallif/asar), to'g'ri javobga teng (apostrof variantlari normallashtirilib) bo'lganlar chiqarib tashlanadi; javob indeks emas, MATN bo'yicha solishtiriladi (eski dublikatli testlar ham adolatli) — 2 test, 2026-10-31
- [x] Landing bo'sh holatlari — tekshirildi: raqam yo'q bo'lsa «—», jonli statistika/reyting/donat bloklari shtrixli «hali yo'q» holatida, soxta raqam yo'q. Qo'shimcha: ishonch qatoridagi 2 ta qattiq o'zbekcha matn 4 tilga o'tdi (`hero.trustData/trustOffline`) — 2026-10-31
- [x] Playwright (`@playwright/test`, `apps/frontend/e2e/smoke.spec.ts`): login → `?q=` qidiruv → kutubxona sahifasi → bron → «keyingi qadam» oynasi → profil «Bronlarim» → bekor (tozalash, idempotent). Lokal: dev serverlar ishlab turganda `npm run e2e` (apps/frontend) — 2 marta ketma-ket o'tdi (41 s / 35 s). CI: `ci.yml` `e2e` job — Postgres/Redis service, `prisma migrate deploy` + seed, backend `dist` + `next start` ni Playwright webServer ko'taradi, ES/Kafka/MinIO siz (no-op) — 2026-10-31
- [x] **WCAG 2.1 AA tuzatishlari (axe haqiqiy sahifalar auditi natijasi, 2026-10-31):** (1) `slate-400/500` tokenlari qoraytirildi (`globals.css @theme`: #5b6980 / #4f5d73; oq va `surface-muted` fonda ≥ 4.5:1; `.dark` da ochroq qiymatlar) — 100+ element bitta joyda; (2) til tugmasi `aria-label` ko'rinadigan matnni o'z ichiga oladi (WCAG 2.5.3); (3) matn ichidagi 5 ta havola doimiy `underline` (login, register, demo-request, muassasa fond, bron oynasi); (4) muassasa panelidagi `<dl>` tuzilmasi; (5) `/top` yashil tugma `info-700`, landing Telegram tugmasi `sky-700`, `text-brand-500` yorliq `brand-700`; (6) qidiruv: `bg-orange-700` chip, faol tab hisoblagichi oq, `text-green-700`, til `<select>` ga `aria-label` (`ReaderSearch.langFilter`, 4 til). **Qo'shimcha topilma — anonim mehmon `/search` va `/library/<code>` dan `/login` ga uloqtirilardi:** `ReaderShell` sessiyasiz ham `/libraries/my-institution` so'rardi, 401 → `client.ts` interceptor refresh → logout + hard redirect. Tuzatish: interceptor faqat sessiya belgisi (token yoki `sl_auth` cookie) bo'lganda refresh qiladi; `ReaderShell` so'rovi `enabled: hasSession`. Tekshirildi: anonim `/search?q=` va kutubxona sahifasi joyida qoladi (faqat ochiq API, 200).

**Qabul:** CI'ning 4 bosqichi yashil; `npm audit --audit-level=high` yashil yoki istisnolar yozilgan; FR1/FR2 testlari bor.

## 2-bosqich — Pilot-ready (2 hafta)

### Server va deploy (**siz**: O'zbekistondagi server kirishi)
- [ ] Staging: `docker-compose.prod.yml`, nginx + TLS (Let's Encrypt), domen (`staging.sifat.uz`)
- [ ] Sirlar: Vault yoki server `.env` (repo'dan tashqarida); `PRODUCTION_REQUIRED_ENV` to'liq
- [ ] Postgres kunlik backup (30 kun), tiklash sinovi (RPO < 1 soat, RTO < 4 soat — TZ §11.4)
- [ ] Monitoring: Prometheus + Grafana (D5 dan keyin) + Loki + Sentry; test alert
- [ ] `deploy-staging.yml` serverga ulanadi; smoke test

### Integratsiyalar (**siz**: hisoblar)
- [ ] Eskiz SMS — haqiqiy OTP
- [ ] Payme / Click sandbox — obuna to'lovi (TRIAL → PENDING → ACTIVE)
- [ ] FCM — service account, push sinovi

### Ma'lumot
- [ ] 1–3 pilot kutubxona: Excel fond importi (ISBN tozalash, dublikatlar), kutubxonachi akkauntlari, manzil / ish vaqti
- [ ] Geo ro'yxat to'liqligi: 14 viloyat, 200+ tuman, mahallalar
- [ ] Landing: faqat real raqamlar; OG rasm (brend asosida, 1200×630)

### Sinov
- [ ] TZ Sprint 4 mezoni: 10 haqiqiy foydalanuvchi, 5 kutubxona — ro'yxat → qidiruv → bron → QR olish → qaytarish → RI yangilanishi
- [ ] k6 smoke (staging), axe audit, Lighthouse

**Qabul:** pilot kutubxonalar jonli; 10 foydalanuvchi oqimni o'tdi; backup va monitoring ishlaydi.

---

## Keyingi bosqichlar (pilotdan keyin)

- **Mobil ilova** — Expo (React Native), kanvasdagi 7 ekran, mavjud API, dinamik QR (HMAC, 5 daqiqa), FCM; TestFlight + Play internal testing. Ikonka/brend aktivlari tayyor: `apps/frontend/public/brand/`.
- **Taqdimot** — deck real raqamlar bilan, demo ssenariy, PQ-9 hisobot PDF'lari real ma'lumotda, AI modullari (NL interfeys, fraud) sifatini jonli baholash.

## Sizdan kerak bo'ladi

| Nima | Qachon |
|---|---|
| GitHub akkaunt/tashkilot | 0-bosqich |
| Server kirishi (SSH), domen DNS | 2-bosqich boshi |
| Eskiz, Payme, Click, FCM hisoblari | 2-bosqich |
| Pilot kutubxonalar ro'yxati va fond fayli (Excel) | 2-bosqich |
| Apple Developer ($99/yil), Google Play ($25) | mobil bosqich |
