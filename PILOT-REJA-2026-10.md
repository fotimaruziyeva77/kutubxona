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
- [ ] **FR1** — dedup kaliti `bookId` → `book.isbn` (`modules/reading/reading-score.util.ts:131`, `modules/top/top.service.ts`), testlar
- [ ] **FR2** — `Book` ga `@@unique([libraryId, isbn])` migratsiya; Excel importda upsert; mavjud dublikatlarni tozalash skripti
- [ ] **FR3** — `activity` / `consistency` ham distinct-asar bo'yicha
- [ ] **D4** — `monthlyPartitionCleanup` ga `cache.setNx` leader-lock (`audit.service.ts` naqshi)
- [ ] **D2** — partitsiya cron `M+1…M+3` oralig'ini yopishini tekshirish
- [ ] **D1** — `.env.prod.example` ga `PAYME_LOGIN`, `VAULT_ADDR`, `VAULT_TOKEN`; CI'da `PRODUCTION_REQUIRED_ENV` bilan taqqoslash skripti
- [ ] **T2** — yiqilgan Jest testlari: 2026-10-29 natija — **2203 ✅ / 2 ❌** (2205 test, 102 suite, 7.4 daqiqa); yiqilgan ikkalasi ham `modules/books/__tests__/books-import.processor.spec.ts` da. Alohida yurgizilganda **5/5 o'tadi (16 s)**, to'liq suite'da 80 s → timeout — ya'ni kod regressiyasi emas, **flaky** test (Excel parse parallel yuklamada sekin). Fix: shu spec'ga `jest.setTimeout` / kichikroq workbook, yoki CI'da `--maxWorkers=50%`. Iyuldagi 23 ta yiqilishdan 21 tasi allaqachon yopilgan.
- [ ] **npm audit** — `npm audit fix` (buzmaydigan), `next` 14.2.x oxirgi patch, `multer` / `nodemailer` / `sharp` ko'tarish; qolgan istisnolar hujjatlashtiriladi

### CI / infra
- [ ] **T5** — `npm ci` root'dan (workspace ichida `npm install` emas)
- [ ] **T4** — `tests/` (axe audit, k6 smoke) CI'ga ulanadi
- [ ] **T6** — coverage'ga controller va guard'lar qo'shiladi
- [ ] **D5** — Grafana: `./infra/monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro` mount

### Frontend
- [ ] Qidiruv: landing'dan kelgan `?q=` `search/page.tsx` da `useSearchParams` bilan o'qilsin
- [ ] Bron qilingandan keyingi «keyingi qadam» ekrani (muddat, kutubxona, QR'ga o'tish)
- [ ] Kutubxona profili: manzil, telefon, ish vaqti — schema + admin forma + ommaviy sahifa
- [ ] Comprehension test: takrorlanuvchi javob variantlari
- [ ] Landing bo'sh holatlari (ma'lumot yo'q bloklar yashirilsin yoki «—»)
- [ ] Playwright o'rnatish + 1 ta smoke E2E (login → qidiruv → bron), CI'da

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
