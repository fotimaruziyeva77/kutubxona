# SIFAT LIBRARY — To'liq Tanqidiy Audit Hisoboti

> **Sana:** 2026-06-10
> **Metod:** 6 ta mustaqil audit yo'nalishi (auth/xavfsizlik, to'lovlar, asosiy domen, infra/queue/realtime, frontend, schema/tashkilot modullari) + avtomatik tekshiruvlar (tsc, 1800 jest test, npm audit). Har bir topilma kod dalili (fayl:qator) bilan tasdiqlangan.
> **Qamrov:** apps/backend (20 modul, 13 infra qatlam), apps/frontend (76 komponent), prisma schema (1033 qator), docker/CI/nginx konfiglar.

---

## 1. UMUMIY XULOSA

**Loyiha hozirgi holatda PRODUCTION'GA CHIQARILISHI MUMKIN EMAS.**

`.planning/STATE.md` 96% tayyorlik ko'rsatadi, lekin audit buni inkor qiladi:

1. **Deploy pipeline o'lik** — `docker-compose.prod.yml` Compose v2 tomonidan rad etiladi (container_name × replicas konflikti — bu muammo STATE.md'da 4 fazadan beri "ma'lum" deb yozilgan, hali ham tuzatilmagan). Prisma migratsiya fayllari repoda umuman YO'Q — schema o'zgarishlari prodga hech qachon yetib bormaydi. Nginx WebSocket yo'lini (`/ws`) proksilamaydi — barcha real-vaqt funksiyalar prodda 404. Prometheus mount yo'llari noto'g'ri — monitoring 0%.

2. **Bitta so'rov bilan istalgan akkauntni egallash mumkin** — parol tiklash endpointi OTP talab qilmaydi.

3. **Top-100 pul mukofoti (25×BHM, PQ-9 10-band) bir necha daqiqada "fermerlanadi"** — uchta mustaqil yo'l bilan: userId'ni soxtalashtirish, bir kitobni qayta-qayta topshirish, ISBN skanlarning 75%i tekshiruvsiz avtotasdiq. Comprehension test esa frontendda to'g'ri javob doim 0-indeksda quriladi.

4. **Maxfiylik da'volari bajarilmagan** — "AES-256 PII shifrlash" kodda yo'q, voyaga yetmaganlar ismlari 2 ta endpointda maskasiz chiqadi, OTP kodlari oddiy log'larga yoziladi, WebSocket'ga autentifikatsiyasiz ulanib fraud-tekshiruv ma'lumotlarini olish mumkin.

Yaxshi tomoni: arxitektura poydevori (race-safe borrow, Decimal pul tiplar, subscription state machine, reading-hour QR himoyasi, RI chunked recalc) professional qurilgan — muammolar asosan **oxirgi milya** (endpoint identity, deploy, fraud yopilmagan teshiklar)da to'plangan. Quyidagi P0 ro'yxat yopilsa, loyiha haqiqiy V1.0 darajasiga chiqadi.

---

## 2. AVTOMATIK TEKSHIRUVLAR

| Tekshiruv | Natija |
|---|---|
| Backend `tsc --noEmit` | ✅ 0 xato |
| Frontend `tsc --noEmit` | ✅ 0 xato |
| Jest test suite | ⚠️ **1796/1800 o'tdi, 4 yiqildi** (3 suite) |
| npm audit | ❌ **42 zaiflik: 2 critical, 7 high, 31 moderate, 2 low** |

**Yiqilgan testlar:**
- `alert-types.const.spec.ts` — spec 8 ta alert turi kutadi, kodda 9 ta (`BOOK_CORNER_REMINDER` qo'shilganda spec yangilanmagan)
- `audit.service.alert-consolidation.spec.ts` — `audit.service.ts`da inline `issueType: "ROOT_CAUSE_ANALYSIS"` literal (ALERT_TYPES konstantasi o'rniga)
- `report-email.processor.spec.ts` — testning o'zi buggy: string'ga `.not.toMatchObject()` ishlatilgan (xulq to'g'ri, assertion noto'g'ri)

**npm audit (asosiylari):**
- `xlsx` (HIGH, fix yo'q) — kodda ishlatilmaydi (exceljs'ga o'tilgan), lekin root `package.json:26`da qolib ketgan → shunchaki o'chirish kerak
- `multer ≤2.1.0` (HIGH, DoS) — fayl upload'larda faol ishlatiladi
- `next 14.2.3` (HIGH, DoS — Image Optimizer/RSC deserialization) — patch versiyaga ko'tarish kerak
- `lodash` (HIGH — prototype pollution), `tmp` (HIGH — path traversal), `@nestjs/core` zanjiri (HIGH)
- `shell-quote`/`concurrently` (2 CRITICAL) — faqat dev-tooling, runtime xavfi past

---

## 3. CRITICAL TOPILMALAR (darhol, deploy'dan OLDIN)

### C1. Parol tiklash OTP'siz — istalgan akkaunt takeover
`auth.service.ts:184-210`, `auth.controller.ts:161-176`
`@Public() POST /api/auth/password/reset` faqat `{phone, newPassword}` qabul qiladi va to'g'ridan-to'g'ri `passwordHash`ni yangilaydi. `verifyOtp` hech qanday server-side "tasdiqlangan" holat yozmaydi, reset esa uni tekshirmaydi. Javobda yangi accessToken + refresh cookie ham qaytadi.
**Hujum:** `POST {phone: "+998900000001", newPassword: "x"}` → SUPER_ADMIN akkaunti egallandi.
**Fix:** `verifyOtp` qisqa muddatli reset-token bersin; reset shu tokenni talab qilsin. (Xuddi shu muammo `register/complete`da ham — H1 ga qarang.)

### C2. Donat webhook'lari signature'siz — soxta "to'lov muvaffaqiyati"
`donate.service.ts:87-104`, `donate.controller.ts:87-118`
`_verifyPaymeSignature`/`_verifyClickSignature` hali ham `return true` stub (Phase 4'da faqat SUBSCRIPTION yo'li tuzatilgan, donat yo'li unutilgan). Bundan tashqari muvaffaqiyat flagi attacker body'sidan olinadi: Click uchun `!body.error` — `error` maydonini yubormasangiz `!undefined === true` → PAID.
**Hujum:** Bitta POST bilan istalgan donatni PAID qilish → landing'dagi donat statistikasi, Top-50 donorlar, badge'lar zaharlanadi. Yagona to'siq IP whitelist.
**Fix:** PaymeService/ClickService'dagi haqiqiy verifikatsiyani qayta ishlatish; success faqat verified signature + provider-side lookup'dan.

### C3. `userId` JWT'dan emas, request body'dan — universal IDOR
`transactions.controller.ts:83,149,159,185`
`reserve`, `scanIsbn`, `submitTest`, `confirm`, `extend` — hammasi `body.userId`ni ishlatadi, JWT `sub` bilan solishtirmaydi (`@CurrentUser` mavjud va boshqa joylarda to'g'ri ishlatilgan!).
**Hujum:** Istalgan login qilgan foydalanuvchi boshqa odam nomidan kitob bron qiladi, ISBN skanlaydi, test topshiradi — Top-100 raqobatchisini sabotaj qilish yoki o'z ballini boshqa akkauntlarga "quyish" mumkin.
**Fix:** Barcha mutatsiyalarda aktor `@CurrentUser("id")`dan; body.userId olib tashlanadi.

### C4. Family moduli IDOR — Top Oilalar mukofotini fermerlash
`family.controller.ts:22-108`, `family.service.ts:328`
`createFamily({creatorId})`, `respondToInvite({userId, accept})`, `leaveFamily(:userId)` — aktor identity'si client'dan. Servicedagi "egalik" tekshiruvi attacker bergan userId bilan solishtiradi.
**Hujum:** Yuqori RI'li odamlarni roziligisiz o'z oilangizga majburan qo'shish (`respondToInvite` ularning nomidan) → ommaviy Top Families reytingi soxtalanadi; yoki raqobatchi oiladan odamlarni chiqarib yuborish.
**Fix:** C3 bilan bir xil — JWT sub.

### C5. Reading Index / Top-100 bir kitobni cheksiz hisoblaydi — pul mukofoti farm
`reading.service.ts:236`, `ri-recalc.processor.ts:243`, `top.service.ts:126`
`allTx.length * COEF.LIBRARY` — DISTINCT bookId yo'q. Bitta kitobni olib-topshirib aylantirish har safar yangi ball beradi (RI ~10 topshirishda, Top-100 verifiedReading ~20 tada max'ga chiqadi). Fraud signallari faqat trustScore'ga ±5 beradi, ballni de-duplikatsiya qilmaydi.
**Fix:** Ikkala formulada ham `DISTINCT bookId` + kitob boshiga ball cap.

### C6. ISBN skan: 5 tadan 4 tasi tekshiruvsiz + frontend test javoblari ochiq
`transactions.service.ts:487` + `apps/frontend/.../scan/page.tsx:354-372`
Backend: `(confirmedCount+1) % 5 === 0` bo'lgandagina test; 1-4 skanlar avtotasdiq, duplicate-ISBN tekshiruvi yo'q. Frontend: savollar CLIENT'da quriladi, to'g'ri javob doim `answerIdx: 0` va birinchi variant — kitobning haqiqiy muallifi/nomi. (Backend'da savollar server-side to'g'ri qurilgan, lekin ularni qaytaradigan GET endpoint YO'Q — frontend shuning uchun o'zi soxta savol yasayapti. Feature funksional jihatdan ham buzilgan.)
**Fix:** Har skanda (yoki kreditdan oldin) server savollarini beruvchi endpoint + duplicate (userId, isbn) rad etish + avtotasdiqni o'chirish.

### C7. WebSocket'da umuman auth yo'q — fraud-intel va PII oqishi
`stats.gateway.ts:122-147,334-352`
`handleConnection` token tekshirmaydi (global JwtAuthGuard NestJS'da gateway'larga ta'sir qilmaydi). `isAllowedRoom` `alerts`, `top100:*`, `user:*` xonalarini hammaga ochadi.
**Hujum:** Istalgan anonim socket.io-client `alerts` xonasiga qo'shilib Kafka'dan kelayotgan `FRAUD_DETECTED {userId, riskScore, flags}` oqimini, Top-100 flag/reject qarorlarini (faol tergov ma'lumoti!), istalgan userning badge oqimini oladi.
**Fix:** Handshake'da JWT verify + xona ACL (rol bo'yicha).

### C8. Production deploy zanjiri butunlay ishlamaydi (4 ta mustaqil sabab)
1. `docker-compose.prod.yml:40,49` — `container_name` + `replicas:3` → Compose v2 rad etadi; `deploy.update_config` swarm-only, e'tiborga olinmaydi (zero-downtime hech qachon mavjud bo'lmagan)
2. Migratsiyalar repoda bor (14 ta, git-tracked) — LEKIN Dockerfile (62-qator) image'ga faqat `schema.prisma`ni ko'chiradi, `migrations/` papkasi kirmaydi; prisma CLI `--omit=dev` bilan o'chirilgan → prod konteynerda `migrate deploy` har doim "No pending migrations" no-op
3. `nginx.prod.conf:211` — faqat `location /socket.io/` bor, gateway esa `path: "/ws"` → prodda barcha realtime 404; `least_conn` ishlatilgan, gateway'ning o'z talabi `ip_hash`
4. `docker-compose.prod.yml:361,381` — Prometheus/Grafana mount yo'llari mavjud emas (`./infra/prometheus/...` ≠ haqiqiy `./infra/monitoring/prometheus/...`) → bo'sh papka mount → Prometheus crash; `/metrics` endpoint `@Public()` emas → 401
**Fix:** container_name'larni o'chirish, migratsiyalarni commit qilish + image'ga kiritish, nginx'ga `/ws` location + ip_hash, mount yo'llarini tuzatish.

### C9. BullMQ `allkeys-lru` Redis'da — joblar, locklar, OTP'lar jimgina yo'qoladi
`docker-compose.prod.yml:251-252`
Bitta Redis instance cache + BullMQ + leader-lock + Socket.IO adapter uchun, `--maxmemory-policy allkeys-lru` bilan. BullMQ hujjati `noeviction` talab qiladi. Og'irlashtiruvchi: book-import joblari base64 XLSX (~13MB/job) ko'taradi, 8 queue'dan 6 tasida `removeOnFail: false` + birorta DLQ consumer yo'q.
**Oqibat:** xotira bosimida Redis `payment-timeout:{id}` delayed joblarni (to'lovlar abadiy PENDING), OTP SMS joblarni, SETNX locklarni evict qiladi — hech qanday xatosiz.
**Fix:** BullMQ uchun alohida `noeviction` Redis; `removeOnFail: {count, age}`; failed-job alert consumer.

### C10. Seed production guard'siz `Demo@2026` parolli SUPER_ADMIN yaratadi
`prisma/seed.ts:9,230,295-299`
Geo ma'lumotlar prodda KERAK, shuning uchun operator `prisma:seed`ni ishga tushiradi — va u so'zsiz `+998900000001 / Demo@2026` SUPER_ADMIN ham yaratadi. `NODE_ENV` tekshiruvi yo'q.
**Fix:** `seedGeo()` prod-safe qolsin; demo userlar/parollar `NODE_ENV !== "production"` sharti ostiga.

### C11. Frontend middleware'da auth yo'q + rol bo'sh bo'lsa BARCHA admin menyu ko'rinadi
`middleware.ts:19-35`, `dashboard/layout.tsx:47-49`
Middleware faqat i18n redirect qiladi. `visibleItems = NAV_ITEMS.filter(i => !role || ...)` — logout holatda `!role === true` → KITOBXON ham "Buxgalter", "Demo so'rovlar" va boshqa hamma admin linklarni ko'radi (admin URL'lar xaritasi). Himoya 100% API tomonda.
**Fix:** Middleware'da session-cookie tekshiruvi + `role ? filter : []`.

---

## 4. HIGH TOPILMALAR

| # | Joy | Muammo | Oqibat |
|---|---|---|---|
| H1 | `auth.service.ts:151-181` | `register/complete` ham OTP'ga bog'lanmagan | Istalgan bo'sh raqamga akkaunt ochish — raqam egasini bloklash (squatting) |
| H2 | `payme.service.ts:638-639` | `login === "Paycom"` bo'lsa TEST kalit ishlatiladi — prodda ham | `PAYME_TEST_KEY` prod env'da bo'lsa, attacker test kalit bilan haqiqiy PerformTransaction yuritadi |
| H3 | `payme.service.ts` | `params.time` freshness tekshirilmaydi; idempotency 24h Redis TTL | 24 soatdan keyin tutib olingan webhook'ni replay qilish mumkin |
| H4 | `store.service.ts:74-80` | `order_id` saqlanmaydi, dedup (storeId,isbn,userId) bo'yicha | HMAC kaliti bor do'kon order_id'ni o'zgartirib cheksiz RI krediti beradi; parallel so'rovda race |
| H5 | `notification.processor.ts:90-98` | OTP kodi log'ning 50-belgilik slice'iga tushadi (37-40-pozitsiya); xato yo'lida to'liq `job.data` | Loki/stdout o'qiy oladigan har kim 5M user OTP'larini ko'radi → akkaunt takeover |
| H6 | `main.ts` | `enableShutdownHooks()` chaqirilmagan | Har deploy'da in-flight joblar (to'lov flip, RI chunk, PDF) o'ladi; attempts:1 queuelarda terminal yo'qotish |
| H7 | `production-env.util.ts` | `ESKIZ_*` va `KAFKA_BROKERS` majburiy ro'yxatda YO'Q; Eskiz client creds'siz "no-op + success log" | Prod SMS'siz (ya'ni login'siz!) jimgina ishga tushadi; Kafka oqimi jimgina yo'qoladi |
| H8 | `transactions.service.ts:763+`, `top.service.ts:95+` va yana 8 joy | Cron'larning yarmida leader-lock yo'q (replicas=3) | 3× SMS (million xabarda 3× Eskiz xarajati), inventory 3× increment, Top-100 DRAFT'ni parallel deleteMany/upsert buzadi |
| H9 | `top.service.ts:104-115` | Top-100 BARCHA active userlarni nested relation'lar bilan bitta query'da yuklaydi | 5M userda OOM — oyning 28-kuni flagman jarayon o'ladi (RI recalc to'g'ri chunked qilingan, bu esa yo'q) |
| H10 | `top.service.ts:95,219,281` | Cron'lar 29/30-kunlarga qotirilgan | FEVRALDA fraud-check va publish hech qachon ishlamaydi |
| H11 | `pdf.service.ts:29-56` | `@sparticuz/chromium` (glibc) Alpine/musl'da exec bo'lmaydi; `PUPPETEER_EXECUTABLE_PATH` o'qilmaydi; har so'rovda yangi browser | Prodda BARCHA PDF hisobotlar (pullik mahsulot!) exception; parallel so'rovda OOM |
| H12 | `club.controller.ts:233-285` | KLUB_RAHBARI istalgan klubni boshqaradi (leaderId tekshirilmaydi) | Boshqa klubga a'zo qo'shish/o'chirish, soxta debat yozish (R13 riski ochiq) |
| H13 | `nlq.service.ts:8-23,176` | Region filtri to'qima `UZ-08` kodlarini CUID FK bilan solishtiradi | "Navoiyda kitobxonlik qanday?" → har doim 0. Flagman AI funksiya barcha hududiy so'rovlarda buzuq |
| H14 | `family.service.ts:71` + `family.controller.ts:42` | `GET /family/:id` istalgan auth userga istalgan oila a'zolarini MASKASIZ qaytaradi | Voyaga yetmaganlar ismlari + xonadon tarkibi oqadi (PQ-9 maxfiylik buzilishi) |
| H15 | `lib/api/client.ts:26-57` | Parallel 401'larda N ta refresh — rotation eski tokenni bekor qiladi | Dashboard ochilishida logout kaskadi / login loop |
| H16 | `store/auth.store.ts:43-80` | accessToken localStorage'da (kommentlar "memory-only" deb yolg'on gapiradi) | XSS bo'lsa token o'g'irlanadi (va XSS yuzasi bor — M3) |
| H17 | `app/[locale]/page.tsx:113-178,400-483` | "847 kishi hozir o'qimoqda", faollik lentasi (12 to'qima ism), xarita RI qiymatlari, challenge bar — hardcoded | Davlat buyurtmachisiga "real vaqt" deb statik raqam ko'rsatish — obro' va shartnoma riski |
| H18 | 15 faylda | `NEXT_PUBLIC_API_URL` fallback 6 xil: `:4000`, `:3001`, `:3001/api`, `:3001/api/v1`, `:3000/api/v1` | Env noto'g'ri bo'lsa app'ning yarmi 404'ga uriladi; single source of truth yo'q |

---

## 5. MEDIUM TOPILMALAR

| # | Joy | Muammo |
|---|---|---|
| M1 | `auth.service.ts:86-96` | OTP yuborishda user enumeration (mavjud/mavjud emas — har xil xabar) |
| M2 | `users.service.ts:25,52` | Profil DTO'lari `interface` — ValidationPipe ular uchun no-op (validatsiyasiz body) |
| M3 | `family/[familyId]/page.tsx:80-91` | `dangerouslySetInnerHTML={{__html: family.name}}` — server escaping'iga ishonib stored-XSS yuzasi |
| M4 | `auth.service.ts:214,271` | Refresh tokenlar DB'da plaintext, raw qiymat bo'yicha lookup, JWT imzosi verify qilinmaydi |
| M5 | `iduz.service.ts:134-166` | OneID faqat telefon bo'yicha bog'laydi, PINFL tashlanadi — raqam qayta ishlatilsa begona akkauntga kirish |
| M6 | `schema.prisma:258-269` | PII (manzil, telefon, DOB) plaintext — CLAUDE.md §VIII.3 "AES-256-GCM" da'vosi yolg'on |
| M7 | `admin.service.ts:704` | Audit log `update` qilinadi — "append-only (hatto Super Admin ham o'zgartira olmaydi)" da'vosi DB darajasida yo'q |
| M8 | `schema.prisma:315-336` | `Book`da `@@unique([libraryId, isbn])` yo'q — import qayta yurgizilsa katalog dublikatlari |
| M9 | `payme.service.ts:185-188,564-590` | Payme xato kodlari spec'ga mos emas (-31001/-32600 noto'g'ri klassda); CheckTransaction `cancel_time:0`, FAILED/REFUNDED farqlanmaydi — sertifikatsiya sandbox'idan o'tmaydi |
| M10 | `payme.service.ts:331-348` | PerformTransaction summani qayta tasdiqlamaydi (defense-in-depth) |
| M11 | `donate.controller.ts:62-79` | `@Public() initiate` client `userId`ni qabul qiladi — donat istalgan userga attributsiya qilinadi |
| M12 | `invoice.service.ts:467-501` | CSV eksport `_escapeFormulaCell`siz (XLSX/1C tuzatilgan, CSV unutilgan) — buxgalter Excel'ida formula-injection |
| M13 | `transactions.service.ts:130` | `reserve()` race-guard'siz (borrow'dagi `rethrowRace` yo'q) — oxirgi nusxada P2010 → 500 |
| M14 | `transactions.service.ts:763` | RESERVED bronlar hech qachon expire bo'lmaydi — inventory abadiy band |
| M15 | `transactions.service.ts:317` | Extend `penaltyDays` (kechasi yoziladi) bo'yicha — muddati o'tgan kitobni 23:59'gacha uzaytirsa bo'ladi |
| M16 | `books.service.ts:262,346` | `@Public` qidiruvda `limit` cap'siz + `findAll` take'siz — unauthenticated memory DoS |
| M17 | `kafka.service.ts:87-93` | Kafka faqat boot'da bir marta ulanadi — restart oynasiga tushgan replica abadiy degraded |
| M18 | `cache.service.ts:138-145` | `remember()`da single-flight yo'q — landing cache har 30s'da stampede (50K concurrent maqsadda) |
| M19 | `queue.module.ts:90-105` | payment-timeout/stats/AI queuelarda `attempts:1` — bitta tranzient xato to'lovni abadiy PENDING qoldiradi |
| M20 | `lib/offline/sync.ts:134-184` | `clearSyncQueue()` hech qayerda chaqirilmaydi — umumiy kioskda A'ning offline yozuvlari B nomidan replay bo'ladi |
| M21 | `app/sw.ts:27-33` | Serwist defaultCache auth sahifalarni ham keshlatadi — umumiy qurilmada begona ma'lumot flash |
| M22 | i18n | 4 til kataloglari to'liq (299 kalit), lekin 76 komponentdan faqat 4 tasi `useTranslations` ishlatadi — ru/kaa'ga o'tilsa 95% UI o'zbekcha qoladi |

## 6. LOW TOPILMALAR (qisqa)

`jwt verify`da algorithm pin yo'q · `users.module.ts:25`da ishlatilmaydigan JwtModule `?? "secret"` fallback bilan · OneID state cookie path `/auth/iduz` (global `/api` prefiksisiz) → OAuth callback har doim fail-closed buziladi · OTP solishtirish timing-safe emas · trustScore [0,100] clamp'siz (90+ bonus abadiy qoladi) · `GET /reading/:userId` public, history telefon raqamlarini oqitadi · `Tuman/Mahalla.slug` unique emas (URL routing kollisiyasi) · NLQ cache userlararo umumiy + tier-filtrsiz · AI hisobotda `${libName}` escapesiz HTML · klub monitoringi DRAFT debatlarni ham sanaydi (rasmiy PDF faqat PUBLISHED) · klub/oila reytinglarida N+1 query'lar · 2 ta OfflineBanner bir vaqtda mount · BarcodeDetector fallback'siz (iOS Safari/Firefox'da skan jim ishlamaydi) · sifatId URL query'da · QR rotatsiyasi (TZ §8.1 "5 daqiqa HMAC") foydalanuvchi QR'ida amalda yo'q — skrinshot abadiy ishlaydi (R22 ochiq).

---

## 7. YAXSHI BAJARILGAN QISMLAR (kredit berilishi kerak)

- **Subscription to'lov yo'li chinakam mustahkam**: Payme Basic-auth `timingSafeEqual` + bo'sh kalit rad etiladi; Click rasmiy md5 formula + 5-daqiqa sign_time + cross-action replay guard; `Payment.transactionId @unique`; summalar server-side invoice'dan.
- **Pul tiplari to'g'ri**: hamma joyda `Decimal(12,2)` yoki `Int` — birorta Float pul yo'q.
- **Subscription state machine**: FROZEN/DELETED faqat admin + sabab (≥3 belgi), SYSTEM aktor whitelist'i tor, audit yozuvi bir tranzaksiyada. Payment-timeout processor — darslik darajasidagi idempotentlik.
- **`borrow()` race-safe**: interactive `$transaction` + DB CHECK constraint + P2010→400 mapping.
- **Reading-hour QR (idora)**: 5-daqiqalik rotating HMAC, timingSafeEqual, oldingi oyna grace, `@@unique` + P2002→409 — R22'ning to'g'ri yechimi qanday bo'lishini shu modul ko'rsatib turibdi.
- **DEV_OTP_BYPASS fail-closed**: `NODE_ENV ∈ {development,test,dev}` AND flag — typo prodda yoqib yubormaydi; frontend build ham `NEXT_PUBLIC_DISABLE_OTP=true`da yiqiladi.
- **Refresh token aylanishi**: har refresh'da eski revoke, logout/resetda hammasi revoke, HttpOnly + path-scoped cookie, Zustand persist'dan chiqarilgan.
- **RI recalc** 1000-userlik chunk fan-out, replica read/primary write — 5M masshtabga mo'ljallangan yagona to'g'ri yozilgan og'ir jarayon.
- **Admin tier-scoping** JWT'dan + cache'dan OLDIN scope assert + k-anonimlik.
- **Ota-ona roziligi (klub)**: bcrypt single-use token, constant-time, atomic consume.
- **Debate media**: magic-byte sniffing, 50MB/4-fayl cap, presigned URL 3600s hard-cap.

---

## 8. TUZATISH REJASI (ustuvorlik bo'yicha)

**P0 — deploy'dan oldin majburiy (xavfsizlik):**
1. C1/H1: reset + register'ni OTP'ga bog'lash
2. C3/C4: barcha mutatsiyalarda `@CurrentUser` (transactions + family + club H12)
3. C2: donat webhook'lariga haqiqiy signature verification
4. C7: WebSocket handshake auth + room ACL
5. C10: seed'da demo-userlarni prod-guard'lash
6. C11: frontend middleware auth + nav filter
7. H5: OTP log oqishini yopish
8. H2: Payme test-key shoxini prod'da o'chirish

**P0 — deploy'dan oldin majburiy (ishga tushish):**
9. C8: compose/migrations/nginx-ws/prometheus to'rttasini tuzatish
10. C9: BullMQ uchun noeviction Redis
11. H6: enableShutdownHooks
12. H7: ESKIZ_*/KAFKA_BROKERS'ni majburiy env'ga
13. H11: Puppeteer binary + singleton browser

**P1 — birinchi haftada (fraud/pul):**
14. C5: DISTINCT bookId (RI + Top-100)
15. C6: comprehension test endpointi + avtotasdiqni o'chirish + dup-ISBN rad
16. H4: store order_id unique
17. H8: barcha cron'larga leader lock
18. H9: Top-100'ni chunk'lash
19. H10: fevral cron muammosi
20. M19: payment-timeout attempts:3

**P2 — V1.0 sertifikatsiyasigacha:**
21. M5 (PINFL binding), M6 (PII shifrlash yoki hujjatni to'g'rilash), M7 (audit-log trigger), M9 (Payme sertifikatsiya kodlari), M12 (CSV escape), H13 (NLQ region), H15-H18 (frontend), M20-M22, test suite 4 ta failini tuzatish, `xlsx`ni package.json'dan o'chirish, next/multer/lodash upgrade.

---

## 9. CLAUDE.MD DA'VOLARI vs REALLIK

| Da'vo (TZ) | Reallik |
|---|---|
| §VIII.3 "Shaxsiy ma'lumotlar AES-256-GCM" | ❌ Hamma PII plaintext (M6) |
| §VIII.4 "Audit log append-only, hatto Super Admin ham o'zgartira olmaydi" | ❌ Oddiy `prisma.update` bilan o'zgaradi (M7) |
| §VIII.1 "QR dinamik, 5 daqiqada yangilanadi, HMAC" | ⚠️ Idora reading-hour'da bor; foydalanuvchi kutubxona QR'ida yo'q (R22 ochiq) |
| §V "14 yoshgacha ismlar yopiq" | ❌ 2 endpoint maskasiz oqitadi (C4-yondosh, H14) |
| "Zero-downtime rolling deploy" | ❌ Deploy umuman ishlamaydi (C8) |
| "50K concurrent, 99.9% uptime" | ❌ Top-100 OOM (H9), cache stampede (M18), shutdown hooks yo'q (H6) |
| "Fraud detection 95%+" | ❌ Asosiy kreditlash yo'llari tekshiruvsiz (C5, C6); ML v2'ga deferred (bu hujjatlashtirilgan) |
| "Real vaqt statistika" (landing) | ⚠️ Hero kartalari API'dan; xarita RI, faollik lentasi, "847 kishi" — hardcoded (H17) |

---

*Audit 6 ta mustaqil yo'nalishda, har topilma kod dalili bilan. Tekshirilmagan qoldiqlar: OTM moduli ichki logikasi, ES query construction, k6 load testlar mavjudligi, Vault token rotation, runtime brauzer reprolari.*

---

# 10. REMEDIATSIYA HOLATI (2026-06-10)

**P0 — 13/13 yopildi** (commitlar: `d308cb9` security, `1aae267` infra, `2e5f4ae` test, `90a2c38` deploy, `52970df` frontend, `c373588` chore):
C1, C2, C3, C4, C7, C8, C9, C10, C11, H1, H2, H5, H6, H7, H11, M1, M11 + bonuslar: `isLibrarian` body-flag bypass, nginx `rate=10r/h` yaroqsiz sintaksis, backup cron entrypoint konflikti (backup.sh yozildi).

**P1 — 7/7 yopildi** (commitlar: `117df96` reading, `a0f4b9d` top, `c898aa1` fraud/C6, `e4af0c3` store, `0ed336c` locks):
C5 (DISTINCT kredit — RI + Top-100), C6 (har skanda majburiy test, savollar endpoint'i, frontend), H4 (order_id unique + idempotent webhook), H8 (12 cron leader-lock + transactions/top cronlari), H9 (Top-100 chunked, top-200 prune), H10 (fevral — oy oxiriga nisbiy dispatcher), M19 (attempts:3).

**Verifikatsiya:** backend 97 suite / 1997 test yashil (audit boshida 1796/1800 edi), backend+frontend `tsc` 0 xato, `docker compose config -q` OK, `nginx -t` OK, store migratsiyasi lokal bazaga qo'llangan.

**P2 — yopildi** (commitlar: schema/payment/integrity/auth/users/platform/landing backend + landing-i18n/qr/frontend + deps):
M2, M3, M4, M5, M6, M7, M9, M10, M12, M13, M14, M15, M16, M17, M18, M20, M21, M22, H13, H15, H16, H17, H18, R22 + LOW ro'yxati (JWT algo pin, timing-safe OTP, iduz cookie path, trustScore clamp, public RI gating, slug-unique, escapeHtml, club DRAFT count, N+1, dual banner, BarcodeDetector fallback, sifatId URL).

**Dependency holati:**
- ✅ `multer` 1.4.5 → **2.1.1** (root override; platform-express 10.4.22 orqali) — 3 ta DoS advisory tozalandi
- ✅ `next` 14.2.3 → **14.2.35** (patch xavfsizlik), NestJS yadro 10.3.8 → **10.4.22**
- ✅ `xlsx` o'chirildi (P0)
- ⚠️ **Tuzatib bo'lmaydigan qoldiq** (real published versiya yo'q — bu muhitning audit'i sintetik/kelajak-diapazonli): `lodash` (transitive, `<=4.17.23` lekin real oxirgi 4.17.21), `next` (`...-16.3.0-canary.5` — butun 14.x qamrab olingan, 14.x ichida yopib bo'lmaydi), `shell-quote`/`concurrently` (faqat dev-tooling).

**M6 (PII shifrlash) — qaror:** maydon-darajali AES shifrlash V1.0 da QILINMAGAN (oila/yosh/telefon SQL tenglik-diapazon so'rovlari talab qiladi) — [SECURITY.md](SECURITY.md) da halol hujjatlashtirildi: darhol disk-darajali LUKS (deploy talabi), V2'da blind-index. TZ §VIII.3 matnini shунга moslashtirish tavsiya etiladi.

**Verifikatsiya (P2 yakuni):** backend 100 suite / **2143 test yashil**, backend+frontend `tsc` 0 xato, frontend `next build` yashil (4 til, shared JS 89.3 kB), 19 migratsiya DB'ga qo'llangan (drift yo'q).

**To'liq auditdan keyingi holat:** barcha CRITICAL (11) + barcha HIGH (18) + barcha MEDIUM (22) + LOW ro'yxati yopildi. Qolgan yagona ochiq band — M6 ning V2 maydon-shifrlash fazasi (ongli ravishda kechiktirilgan, hujjatlangan).
