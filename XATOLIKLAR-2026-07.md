# SIFAT LIBRARY — Mustaqil Kod Tekshiruvi

**Sana:** 2026-07-27
**Metod:** Loyiha to'liq o'rnatildi (`npm install`), Prisma klienti generatsiya qilindi, backend + frontend `tsc --noEmit`, 100 ta Jest suite, `npm audit`, hamda schema / migratsiya / docker / nginx / CI konfiguratsiyalari qo'lda o'qib chiqildi.
**Qamrov:** backend 267 TS fayl (~41.5k qator), frontend 124 fayl (~28.3k qator), 19 migratsiya, 4 CI workflow.

> Bu hisobot `AUDIT-REPORT.md` (2026-06-10) dan **keyingi** holatni tekshiradi. O'sha hisobotdagi C1–C11 va H1–H18 topilmalarining aksariyati haqiqatan ham yopilgan (quyida "Tasdiqlangan tuzatishlar" bo'limiga qarang). Quyidagi ro'yxat — **hozir ochiq bo'lgan** muammolar.

---

## 0. AVTOMATIK TEKSHIRUV NATIJALARI

| Tekshiruv | Natija |
|---|---|
| Backend `tsc --noEmit` | ❌ **1 xato** |
| Frontend `tsc --noEmit` | ✅ 0 xato |
| Backend Jest | ❌ **23 test yiqildi / 2171**, 5 suite qizil |
| Frontend testlar | ❌ **0 ta test fayli mavjud emas** |
| `npm audit --omit=dev` | ❌ **47 zaiflik** (13 high, 33 moderate, 1 low) |

Ya'ni CI pipeline'ining kamida 3 ta bosqichi (`typecheck`, `test:cov`, `npm audit --audit-level=high`) hozir qizil holatda.

---

## 1. DEPLOY'NI TO'XTATADIGAN MUAMMOLAR

### D1. `.env.prod.example` bo'yicha to'ldirilgan prod konteyner boot'da yiqiladi

`main.ts:176` production'da `_assertEnvVars(PRODUCTION_REQUIRED_ENV)` chaqiradi va bironta kalit yo'q bo'lsa process'ni o'ldiradi. `docker-compose.prod.yml:49` esa `.env.prod` faylini **o'zgartirmasdan** (`env_file:`) uzatadi.

`PRODUCTION_REQUIRED_ENV` talab qiladigan **12 ta kalit** `.env.prod.example` da yo'q:

| Kod talab qiladi | `.env.prod.example` da |
|---|---|
| `VAULT_TOKEN`, `VAULT_ADDR` | umuman yo'q |
| `PAYME_LOGIN` | umuman yo'q |
| `FCM_SERVICE_ACCOUNT_KEY_PATH` | umuman yo'q |
| `ESKIZ_EMAIL`, `ESKIZ_PASSWORD` | umuman yo'q |
| `SMTP_PASS` | `SMTP_PASSWORD` deb nomlangan |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | `MINIO_USER`, `MINIO_PASSWORD` deb nomlangan |
| `MINIO_BUCKET_DEBATES`, `MINIO_BUCKET_BOOKCORNERS`, `MINIO_BUCKET_READINGHOURS` | faqat bitta `MINIO_BUCKET` bor |

**Oqibat:** hujjatga qat'iy amal qilgan operator birinchi `docker compose up` da 3 ta backend replikasining hammasi crash-loop'ga tushganini ko'radi. Xato xabari faqat konteyner logida.

**Fix:** `.env.prod.example` ni `PRODUCTION_REQUIRED_ENV` ro'yxati bilan sinxronlash + CI'ga oddiy tekshiruv qo'shish (ikkala ro'yxatni taqqoslovchi skript).

---

### D2. `ReadingIndex` partitsiyalarida oyma-oy uzilish → deploydan ~3 oy keyin RI yozuvlari to'xtaydi

- Migratsiya `20260607000002_phase2_ri_partitions` qo'llanilganda `M-13 … M+2` oralig'idagi 16 ta partitsiya yaratadi.
- `reading.service.ts:126` dagi cron har oyning 1-kuni **faqat `M+3`** ni yaratadi.

Ketma-ketlik: migratsiya `M` oyida qo'llanadi → partitsiyalar `M+2` gacha. Cron birinchi marta `M+1` ning 1-kunida ishlaydi → `(M+1)+3 = M+4` yaratadi. **`M+3` hech qachon yaratilmaydi.**

**Oqibat:** `M+3` oyi boshlanganda har bir `readingIndex.create()` PostgreSQL'ning `no partition of relation "ReadingIndex" found for row` xatosi bilan yiqiladi. Kechki RI qayta hisoblash (`ri-recalc` navbatining barcha chunk'lari) to'liq ishdan chiqadi — ya'ni Reading Index, Top-100, hududiy indeks, landing statistikasi muzlab qoladi.

**Fix:** cron `M+1 … M+3` oralig'idagi yetishmayotgan barcha partitsiyalarni `CREATE TABLE IF NOT EXISTS` bilan yaratsin (faqat bittasini emas).

---

### D3. `AiAuditLog` partitsiyalari 2028-12 da tugaydi, yaratuvchi cron yo'q

`20260609000000_phase7_privacy_audit` migratsiyasi 2024-01 … 2028-12 oralig'ida 60 ta partitsiya yaratadi. `audit.service.ts:497` dagi cron esa **faqat eskilarini o'chiradi**, yangisini yaratmaydi.

**Oqibat:** 2029-01-01 dan boshlab audit log yozuvi imkonsiz. TZ §VIII.4 "2 yil saqlash + append-only" talabining amal qilish muddati qattiq chegaralangan. D2 dan farqli ravishda bu uzoq muddatli, lekin xuddi shu sinfdagi xato.

---

### D4. `monthlyPartitionCleanup` cron'ida leader-lock yo'q (`replicas: 3`)

`reading.service.ts:126` — `DETACH PARTITION CONCURRENTLY` + `DROP TABLE` DDL'ini uchala replika bir vaqtda bajaradi.

Bu aynan `audit.service.ts:502` da izohlab yozib qo'yilgan muammo: *"DDL (DETACH/DROP PARTITION) from 3 replicas at once would deadlock on the parent-table lock"* — va o'sha faylda `cache.setNx` bilan to'g'ri hal qilingan. `reading.service.ts` da esa o'sha himoya qo'llanmagan.

**Fix:** `audit.service.ts:503-509` dagi `setNx` naqshini `monthlyPartitionCleanup` ga ham ko'chirish.

---

### D5. Grafana dashboard'i prodda hech qachon yuklanmaydi

`infra/monitoring/grafana/provisioning/dashboards/dashboards.yml` provider'ni `/var/lib/grafana/dashboards` yo'liga yo'naltiradi. `docker-compose.prod.yml:414-416` esa faqat `provisioning` papkasini mount qiladi — `infra/monitoring/grafana/dashboards/sifat-overview.json` **umuman mount qilinmagan**, `/var/lib/grafana` esa bo'sh named volume.

**Oqibat:** prod Grafana bo'sh ochiladi, "SIFAT Library" papkasi bo'sh. Monitoring de-fakto 0.

**Fix:** `./infra/monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro` mount qo'shish.

---

## 2. FRONTEND — ISHLAMAYDIGAN ENDPOINTLAR

### F1. Landing page'ning 4 ta API chaqirig'i `/api` prefiksisiz ketadi

`apps/frontend/app/[locale]/page.tsx:28`
```
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";
```
va shu bazadan `${API_BASE}/landing/stats`, `/landing/regions`, `/top?limit=5`, `/donate/stats` (74, 86, 101, 113-qatorlar).

Bu `lib/api/base.ts` da yozilgan shartnomaga zid: `NEXT_PUBLIC_API_URL` — **bo'sh backend origin**, `/api` prefiksini `apiBase()` qo'shadi. Env to'g'ri (hujjatdagidek) sozlanganda chaqiruv `https://api.sifat.uz/landing/stats` ga ketadi — backend esa `main.ts:69` da hamma narsani `/api` ostiga mount qilgan → **404**.

Bu aynan `components/landing/LiveStatsRefresher.tsx:35-37` da izoh bilan tuzatilgan xato — client tomoni tuzatilgan, **SSR tomoni tuzatilmagan**.

Fallback ham noto'g'ri: `localhost:3001`, backend esa `main.ts:195` bo'yicha `4000` portda.

**Oqibat:** sahifa "halol bo'sh holat" render qiladi — ya'ni bosh sahifadagi barcha real statistika, hudud xaritasi, Top-5 va donat bloki jimgina bo'sh chiqadi. Xato ko'rinmaydi.

### F2. QR davomat skani hech qachon ishlamaydi (Idora "Kitob o'qish soati")

`apps/frontend/app/[locale]/scan/reading-hour/[id]/page.tsx:19,47`
```
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
... fetch(`${API}/reading-hours/${eventId}/attend`, ...)
```
Haqiqiy route — `reading-hour.controller.ts:240` bo'yicha `POST /api/reading-hours/:eventId/attend`.

**Oqibat:** xodim QR skanerlaganda har doim 404. PQ-9 9b talabidagi "kitob o'qish soati" davomati — pullik Idora modulining asosiy funksiyasi — ishlamaydi.

**Fix (F1+F2):** ikkala faylda ham `lib/api/base.ts` dagi `apiBase()` funksiyasini ishlatish; qo'lda `process.env.NEXT_PUBLIC_API_URL` o'qishni butunlay taqiqlash (ESLint qoidasi bilan).

---

## 3. FRAUD — TOP-100 PUL MUKOFOTI HALI HAM "FERMALANADI"

### FR1. Dedup kaliti `bookId`, `isbn` emas — bir kitob har kutubxonada qayta hisoblanadi

`reading/reading-score.util.ts:131` va `top/top.service.ts:387`:
```
const libDistinct = distinctCount(transactions, (t) => t.bookId);
```

`Book` modeli (`schema.prisma:325-347`) — **kutubxonaga bog'langan nusxa yozuvi**, asar emas: har `Book` qatorida o'z `libraryId` si bor, `isbn` esa unique emas (faqat `@@index([isbn])`).

Ya'ni "Alpomish" 2000 ta kutubxonada = 2000 ta har xil `bookId`. C5 tuzatishi (bitta kitobni qayta-qayta topshirish) yopilgan, lekin:

**Hujum:** platformaning o'zi reklama qiladigan **roaming** (TZ §3.4 — "Navoiylik Toshkentda kitob oladi") orqali bitta kitobni har xil kutubxonalarda olib-qaytarish har safar to'liq yangi kredit beradi. Top-100 `verifiedReading` komponenti (40%) shu bilan to'ldiriladi.

### FR2. `Book` da `@@unique([libraryId, isbn])` yo'q

Tekshirildi: `schema.prisma` da ham, 19 ta migratsiyaning birortasida ham bu unique constraint yo'q (`AUDIT-REPORT.md` M8 "yopildi" deb belgilangan bo'lsa-da).

**Oqibat:** Excel fond importi ikki marta yurgizilsa, bir xil ISBN uchun ikkinchi `Book` qatori (yangi `bookId`) paydo bo'ladi → FR1 orqali bitta jismoniy kitob ikki karra kredit beradi. Bu operator xatosi bilan ham, qasddan ham ishlatilishi mumkin.

### FR3. `activity` va `consistency` komponentlari (jami 40%) dedup qilinmagan

`reading-score.util.ts:168` — `recentTx.length` xom hodisalar soni, 4 ta hodisada 100 ballga to'ladi. Izohda bu "ataylab" deb yozilgan, lekin FR1 bilan birga — bitta kitob + roaming ketma-ketligi RI ning 30% + 20% + 20% = **70% qismini** to'ldiradi.

**Fix (FR1-3):** dedup kalitini `bookId` dan `book.isbn` ga o'tkazish (ikkala hisoblagichda ham: `reading-score.util.ts` va `top.service.ts`), `Book` ga `@@unique([libraryId, isbn])` migratsiyasi, `activity`/`consistency` ni ham distinct-asar bo'yicha sanash.

---

## 4. MAXFIYLIK VA RUXSATLAR

### P1. `DOKON_OPERATOR` kitobxonning ismi va o'qiyotgan kitoblarini ko'ra oladi

`users/users.controller.ts:99`
```
@Roles(UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN, UserRole.DOKON_OPERATOR)
```
Shu endpoint ustidagi izoh (`users.controller.ts:94`) esa: *"Rollar /books/scan bilan aynan bir xil"* — `books.controller.ts:71` da esa `DOKON_OPERATOR` YO'Q. Test ham buni ushlaydi (`users.controller.spec.ts:236` — 3 kutgan, 4 topgan).

Qaytadigan ma'lumot (`books.service.ts:587-605`): `name`, `sifatId`, `type`, `trustScore` va **hozir olingan/bron qilingan barcha kitoblar ro'yxati (nom, muallif, ISBN)**. Ism `maskNameIfMinor` orqali o'tkazilmaydi.

**Oqibat:** hamkor kitob do'koni operatori (uchinchi tomon tijorat sub'ekti) mijoz QR'ini skanerlab uning shaxsini va o'qish tarixini oladi. Bu TZ §V ("o'qish tarixi yopiq", "14 yoshgacha ismlar yopiq") va R5 riski ("davlat kuzatyapti" — foydalanuvchi ishonchi) ga bevosita zid.

**Fix:** `DOKON_OPERATOR` ni olib tashlash; do'kon uchun kerak bo'lsa — faqat `{sifatId, valid: true}` qaytaradigan alohida tor endpoint.

### P2. Admin endpointlari `User` qatorini xom holda qaytaradi (`passwordHash` bilan)

Loyihada global serialization interceptor (`ClassSerializerInterceptor` yoki `@Exclude`) yo'q — `common/interceptors/` da faqat `logging.interceptor.ts` bor. Quyidagi joylarda `select` yo'q:

- `admin.service.ts:117` → `GET /admin/users/pending` (`admin.controller.ts:118`)
- `admin.service.ts:173,219` → `approveUser` / `rejectUser` javoblari
- `users.service.ts:427` → `GET /users` (`users.controller.ts:204`)

Javobga `passwordHash` (bcrypt), `pinfl`, `phone`, `dob`, to'liq manzil tushadi.

**Oqibat:** `MUASSASA_ADMIN` / `TUMAN_ADMIN` darajasidagi har bir hisob (minglab maktab/idora administratorlari) o'z ko'rish doirasidagi foydalanuvchilarning bcrypt hash'larini oladi — offline parol buzish uchun tayyor material. PINFL esa TZ §VIII.3 bo'yicha eng himoyalangan maydon.

**Fix:** bu 4 ta so'rovga aniq `select` qo'yish yoki global `ClassSerializerInterceptor` + `User` DTO'sida `@Exclude()`.

---

## 5. TESTLAR VA CI SIFATI

### T1. Backend'da 1 ta TypeScript xatosi

`payment/__tests__/subscription.service.spec.ts:78` — `Expected 7 arguments, but got 6`.
`SubscriptionService` konstruktoriga 7-argument (`config: ConfigService`, `subscription.service.ts:130`) qo'shilgan, spec yangilanmagan. CI'ning `typecheck` bosqichi shu bitta xato tufayli qizil.

### T2. 23 ta test yiqilgan (5 suite)

Barchasi tekshirildi — **kod regressiyasi emas, eskirgan mock/kutuvlar**, lekin ular real qamrovni yo'q qilgan:

| Suite | Yiqilgan | Sabab |
|---|---|---|
| `libraries.service.spec.ts` | 12 | mock `prisma` da `institution` modeli yo'q — `findOne` dagi yangi `institution.findFirst` (`libraries.service.ts:139`) ga urilib qoladi |
| `store-search.spec.ts` | 6 | mock'da `search.isEnabled` o'rnatilmagan → `store.service.ts:864` doim Prisma fallback'ga tushadi. **Ya'ni butun Elasticsearch qidiruv yo'li hozir umuman test qilinmayapti** |
| `transactions.service.spec.ts` | 3 | mock'da `institution` yo'q (yuqoridagi bilan bir xil sabab) |
| `users.controller.spec.ts` | 1 | **haqiqiy topilma** — P1 ga qarang |
| `transactions.controller.spec.ts` | 1 | `borrow()` ga `dueDate` 4-argumenti qo'shilgan, spec eski |

`users.controller.spec.ts` dagi yiqilish — test to'g'ri ishlayapti, kod noto'g'ri. Qolganlari mock'ni yangilashni talab qiladi.

### T3. Frontend'da bitta ham test yo'q

`apps/frontend` da `*.spec.*` / `*.test.*` fayllari **0 ta**, `jest.config` ham yo'q — `package.json:10` dagi `"test": "jest"` skripti ishlamaydi. Shu sababli `ci.yml` frontend job'ida test bosqichi umuman yo'q (faqat lint / typecheck / build).

TZ §9.1 "Jest + Playwright (Unit + E2E)" talabidan: Playwright loyihada umuman yo'q, frontend unit testlari yo'q.

### T4. `tests/` papkasi CI'da hech qachon ishlamaydi

Mavjud: `tests/accessibility/axe-audit.spec.ts`, `tests/k6/load-test.js`, `tests/k6/smoke-test.js`, `tests/security/owasp-zap-config.yaml`.
Bu papka root `package.json` ning `workspaces` ro'yxatida yo'q va birorta workflow'da chaqirilmaydi. Ya'ni TZ Sprint 10 ning 5 (pentest), 6 (50K load test), 9 (WCAG) tasklari uchun fayllar yozilgan, lekin ular hech qachon bajarilmaydi.

### T5. CI reproducible emas — workspace ichida `npm install`

`ci.yml:18,27` — `working-directory: apps/backend` + `run: npm install`. Lockfile faqat root'da (`package-lock.json`), `apps/backend` va `apps/frontend` da yo'q. Ya'ni CI har safar versiyalarni **qaytadan yechadi**, commit qilingan lockfile'ni e'tiborsiz qoldiradi.

**Oqibat:** CI'da yashil bo'lgan build prod image'idagi versiyalar bilan mos kelmasligi mumkin. `npm ci` root'dan ishlatilishi kerak.

### T6. Coverage o'lchovidan barcha controller'lar chiqarilgan

`jest.config.ts:21-22` — `collectCoverageFrom` dan `**/*.controller.ts`, `**/infra/**`, `**/common/guards/**` istisno qilingan. 80% threshold shu qisqartirilgan bazadan hisoblanadi.

Bu ayni IDOR tuzatishlari (`@CurrentUser` vs `body.userId`) va RBAC guard'lari joylashgan qatlam — ya'ni eng xavfli kod coverage hisobidan tashqarida.

---

## 6. BOG'LIQLIKLAR (npm audit)

`npm audit --omit=dev`: **47 zaiflik (13 high, 33 moderate, 1 low)** — faqat production bog'liqliklarida.

`npm audit fix` bilan (breaking change'siz) yopiladiganlari: `ws`, `form-data`, `brace-expansion`.
Breaking change talab qiladiganlari: `nodemailer` → 9.x, `sharp` → 0.35.x, `multer`.
Yopib bo'lmaydiganlari: `next` (14.x butun diapazoni qamrab olingan), `lodash` (transitive).

> Eslatma: advisory bazasida kelajak sanali (CVE-2026-*) yozuvlar bor — bu muhitning o'ziga xosligi, `AUDIT-REPORT.md:260` da ham qayd etilgan. Shunga qaramay CI'dagi `npm audit --audit-level=high` bosqichi hozir qizil.

---

## 7. TASDIQLANGAN TUZATISHLAR (kredit berilishi kerak)

Quyidagilar mustaqil tekshirildi va haqiqatan yopilgan:

- **C3/C4 (IDOR)** — `transactions.controller.ts` da barcha kitobxon mutatsiyalari `@CurrentUser("id")` dan aktor oladi; `body.userId` tip darajasida olib tashlangan. Kutubxonachi oqimlari (`borrow`) esa ataylab body'dan oladi va `@Roles(...LIBRARIAN_ROLES)` bilan himoyalangan — to'g'ri qaror.
- **C2 (donat webhook)** — Payme Basic-auth `timingSafeEqual` bilan, muvaffaqiyat faqat `PerformTransaction` method'idan; Click rasmiy md5 formulasi + `service_id` + 5-daqiqalik `sign_time` oynasi + cross-action replay guard. Stub yo'li faqat `NODE_ENV ∈ {development,test,dev}` da.
- **C7 (WebSocket)** — `stats.gateway.ts:174` handshake JWT'ni tekshiradi, `canJoinRoom` ACL himoyalangan xonalarni rol bo'yicha yopadi.
- **C8 (deploy)** — `container_name` scale qilinadigan servislardan olib tashlangan, `nginx.prod.conf:78` da `ip_hash`, `:240` da `/ws/` location, Prometheus mount yo'llari to'g'rilangan.
- **C9 (Redis)** — BullMQ uchun alohida `redis-queue` servisi `--maxmemory-policy noeviction` bilan (`docker-compose.prod.yml:284`).
- **C6 (comprehension test)** — savollar server tomonda Fisher-Yates bilan aralashtiriladi (`transactions.service.ts:1176`), `GET /transactions/isbn-scan/:id/test` javob indekslarini qaytarmaydi.
- **H6** — `main.ts:193` da `enableShutdownHooks()` mavjud.
- **H18 (qisman)** — `lib/api/base.ts` yagona manba sifatida yozilgan (lekin 2 ta fayl uni chetlab o'tadi — F1/F2).
- **Migratsiyalar** — 19 ta migratsiya repoda, `directUrl` PgBouncer uchun to'g'ri sozlangan.
- **Frontend `tsc`** — 0 xato.

---

## 8. USTUVORLIK

**P0 — prodga chiqishdan oldin:**
1. D1 — `.env.prod.example` ni `PRODUCTION_REQUIRED_ENV` bilan sinxronlash
2. D2 — `ReadingIndex` partitsiya bo'shlig'i (deploydan 3 oy keyingi qattiq to'xtash)
3. F1, F2 — frontend `/api` prefiksi (landing statistikasi + QR davomat)
4. P1 — `DOKON_OPERATOR` ni QR resolve'dan olib tashlash
5. P2 — admin javoblaridan `passwordHash` / `pinfl` ni chiqarish
6. T1 — `tsc` xatosi (CI'ni yashil qilish uchun)

**P1 — birinchi hafta:**
7. FR1, FR2 — dedup kalitini `isbn` ga o'tkazish + `Book` unique constraint
8. D4 — partitsiya cron'iga leader-lock
9. T2 — 23 ta yiqilgan testni tuzatish (ayniqsa ES qidiruv qamrovini tiklash)
10. D5 — Grafana dashboard mount

**P2 — V1.0 gacha:**
11. FR3 — `activity`/`consistency` dedup
12. D3 — `AiAuditLog` partitsiya yaratuvchi cron
13. T3, T4, T5, T6 — frontend testlari, `tests/` ni CI'ga ulash, `npm ci`, coverage qamrovini kengaytirish
14. `npm audit fix` (breaking bo'lmagan qismi)

---

*Tekshirilmagan qoldiqlar: runtime brauzer reprolari (dev server ko'tarilmadi), haqiqiy PostgreSQL'ga migratsiya qo'llash, Payme/Click sandbox sertifikatsiyasi, Kafka/Elasticsearch integratsiyasining jonli xulqi, AI modullarining javob sifati.*
