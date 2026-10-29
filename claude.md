# SIFAT LIBRARY — Milliy Kitobxonlik Indeksi Platformasi
## To'liq Texnik Topshiriq (TZ) va Sprint Rejasi

> **Versiya:** 6.0 Final  
> **Huquqiy asos:** O'zbekiston Respublikasi Prezidentining 2026 yil 15 yanvardagi PQ-9-son qarori  
> **Buyurtmachi:** Yoshlar ishlari agentligi  
> **Muddat:** 20 hafta (10 Sprint)  
> **Maxfiylik:** Ichki foydalanish uchun  

---

## MUNDARIJA

1. [Umumiy ma'lumot](#i-umumiy-malumot)
2. [Foydalanuvchilar va rollar](#ii-foydalanuvchilar-va-rollar)
3. [Ierarxik tuzilma va URL](#iii-ierarxik-tuzilma-va-url)
4. [Kitobxon jarayonlari](#iv-kitobxon-jarayonlari)
5. [Reading Index va reyting](#v-reading-index-va-reyting)
6. [Statistika va Landing Page](#vi-statistika-va-landing-page)
7. [AI tizimi](#vii-ai-tizimi)
8. [Xavfsizlik](#viii-xavfsizlik)
9. [Frontend arxitekturasi](#ix-frontend-arxitekturasi)
10. [Backend arxitekturasi](#x-backend-arxitekturasi)
11. [CI/CD va DevOps](#xi-cicd-va-devops)
12. [Roadmap va muvofiqlik](#xii-roadmap-va-muvofiqlik)
13. [Subscription Management](#xiii-subscription-management)
14. [Biznes model](#xiv-biznes-model)
15. [Risk Management](#xv-risk-management)
16. [Sprint 1 — Infratuzilma](#sprint-1--infratuzilma-va-loyiha-asosi)
17. [Sprint 2 — Auth tizimi](#sprint-2--autentifikatsiya-va-foydalanuvchi-tizimi)
18. [Sprint 3 — Kutubxona](#sprint-3--kutubxona-va-fond-boshqaruvi)
19. [Sprint 4 — Kitob jarayonlari](#sprint-4--kitob-jarayonlari-bron-berish-qaytarish)
20. [Sprint 5 — Reading Index](#sprint-5--reading-index-top-100-va-reytinglar)
21. [Sprint 6 — Statistika](#sprint-6--statistika-panellari-va-landing-page)
22. [Sprint 7 — Maktab va Klub](#sprint-7--maktab-moduli-jadidlar-izidan-va-oila)
23. [Sprint 8 — AI tizimi](#sprint-8--ai-tizimi-va-fraud-detection)
24. [Sprint 9 — Idora va To'lov](#sprint-9--idora-moduli-subscription-va-buxgalter)
25. [Sprint 10 — Release](#sprint-10--integratsiyalar-va-v10-release)
26. [Yakuniy xulosa](#yakuniy-xulosa)

---

# I. UMUMIY MA'LUMOT

## 1.1 Loyiha tavsifi

**SIFAT LIBRARY** — O'zbekiston Respublikasi Prezidentining 2026 yil 15 yanvardagi **PQ-9-son** qarori asosida ishlab chiqiladigan sun'iy intellekt asosidagi milliy kitobxonlik monitoring, tahlil va boshqaruv platformasidir.

## 1.2 Asosiy maqsad

2026–2030 yillarda aholining kitobxonlik darajasini yiliga o'rtacha **10 ta kitobga** yetkazish maqsadida:
- Barcha kutubxona tizimini raqamlashtirish
- Real vaqt rejimida monitoring qilish
- Davlat darajasida analitik qaror qabul qilishni ta'minlash
- Hududlar kesimida kitobxonlik indeksini hisoblash va reyting shakllantirish

## 1.3 PQ-9 qaroriga to'liq muvofiqlik

| Qaror bandi | Talab | Platforma yechimi | Holat |
|---|---|---|---|
| 7b(a) | Kitobxonlik indeksi shakllantirish | Reading Index + hududiy reyting | ✅ |
| 7b(v) | Mutolaa platformasi integratsiya | Mutolaa API moduli | ✅ |
| 8b | Jadidlar izidan klublari | Klub + maktab moduli | ✅ |
| 9b(a-d) | Idora reytingi, kitob burchagi | Tashkilot moduli | ✅ |
| 9b(d) | Eng ko'p o'qigan xodimga mukofot | Avtomatik mukofot taklifi | ✅ |
| 10b | Top-100 kitobxonlar | Top-100 + fraud detection | ✅ |
| 11b | 330 mahalla kutubxonasi | Mahalla kutubxona tipi | ✅ |
| 12b | Barcha kutubxonalarni xatlov | Fond boshqaruvi + statistika | ✅ |

## 1.4 Loyiha qamrovi

| Ko'rsatkich | Hajm |
|---|---|
| Kutubxonalar (boshlang'ich) | 2,000+ |
| Foydalanuvchilar (mo'ljal) | 5,000,000+ |
| Hududiy qamrov | 14 viloyat, 200+ tuman, 10,000+ mahalla |
| Kutubxona tipi | 5 (Davlat, Maktab, OTM, Idora, Mahalla) |
| Tillar | O'zbek lotin/kirill, Qoraqalpoq, Rus |
| AI modullari | 6 ta asosiy modul |

---

# II. FOYDALANUVCHILAR VA ROLLAR

## 2.1 Ro'yhatdan o'tish — To'liq jarayon

Barcha foydalanuvchilar **BIR xil boshlang'ich sahifadan** o'tadi, lekin 4-qadamda yo'llar ajraladi.

### Qadam 1 — Telefon tasdiqlash (Hammaga bir xil)
- `sifat.uz` ga kiradi → `Ro'yhatdan o'tish` tugmasi
- Telefon raqam kiritiladi: `+998 XX XXX XX XX`
- SMS kod (4 raqam, 2 daqiqa muddati) yuboriladi
- Kod kiritiladi → Tasdiqlandi

### Qadam 2 — Shaxsiy ma'lumotlar (Hammaga bir xil)
- **Ism, Familiya** — majburiy (real shaxsni aniqlash)
- **Tug'ilgan sana** — majburiy (yosh kategoriyasi reytingi uchun)
- **Jins** — majburiy (gender bo'yicha alohida reyting uchun)

### Qadam 3 — Manzil (Hammaga bir xil)
- **Viloyat → Tuman → Mahalla** — kaskad tanlash (DB dan)
- **Ko'cha nomi, Uy raqami, Xonadon raqami** — oila aniqlash uchun muhim

### Qadam 4 — Kim ekansiz? (Yo'llar ajraladi)

| Tur | Qo'shimcha maydon | Tasdiqlovchi | Muddat | Natija |
|---|---|---|---|---|
| Oddiy fuqaro | Yo'q | Avtomatik | Darhol | ACTIVE |
| Maktab o'quvchisi | Viloyat→Tuman→Maktab, Sinf | Maktab admin | 1 kun | PENDING→ACTIVE |
| Talaba | OTM, Fakultet, Yo'nalish, Kurs | OTM admin | 1 kun | PENDING→ACTIVE |
| Davlat xizmatchisi | Vazirlik/Idora, Bo'lim, Lavozim | Idora HR admin | 2 kun | PENDING→ACTIVE |
| O'qituvchi | Muassasa tanlash | Muassasa admin | 1 kun | PENDING→ACTIVE |

### Qadam 5 — Unikal ID beriladi
- **Format:** `SL-UZ-[Viloyat]-[Tuman]-[Mahalla]-[Tartib]`
- **Misol:** `SL-UZ-08-012-0045-00847`
- QR kod shaklida ilovaga yuklanadi
- Bu ID = kutubxona pasporti, hamma joyda ishlatiladi

### PENDING holat qoidalari
- 14 kun ichida tasdiqlanmasa → avtomatik `Oddiy fuqaro` ga tushadi
- Bildirishnoma: *"Tashkilotingiz 14 kun ichida tasdiqlamadi, oddiy kitobxon sifatida davom etasiz"*
- Idora platformaga ulanmagan bo'lsa: *"Oddiy kitobxon sifatida davom etasizmi?"* taklifi ko'rsatiladi

## 2.2 To'liq rol tizimi va ruxsatlar

| Rol | Daraja | Asosiy vakolatlar | Cheklov |
|---|---|---|---|
| SUPER ADMIN | Milliy | Barcha tizim, konfiguratsiya, AI boshqaruvi, audit log, reyting tasdiqlash | Yo'q |
| BUXGALTER | Moliyaviy | To'lovlar, fakturalar, hisobotlar, Export (Excel/1C/PDF) | Faqat moliyaviy ma'lumot |
| VILOYAT ADMIN | Viloyat | Viloyat statistika va reytingi, tuman nazorati | Faqat o'z viloyati |
| TUMAN ADMIN | Tuman | Kutubxonalar, maktab, OTM, idora, mahalla monitoringi | Faqat o'z tumani |
| MUASSASA ADMIN | Muassasa | Foydalanuvchilar, kutubxona, statistika | Faqat o'z muassasasi |
| KUTUBXONACHI | Kutubxona | Kitob berish/qaytarish, fond boshqaruvi, bron tasdiqlash | Faqat o'z kutubxonasi |
| KLUB RAHBARI | Klub | A'zolar, kitoblar, debatlar, faollik monitoring | Faqat o'z klubi |
| DO'KON OPERATORI | Do'kon | Sotuv ma'lumotlari kiritish, ISBN tasdiqlash | Faqat o'z do'koni |
| KITOBXON | Shaxsiy | Profil, qidirish, bron, reading index, reyting ko'rish | Faqat o'z ma'lumoti |

---

# III. IERARXIK TUZILMA VA URL

## 3.1 Geografik ID tizimi

| Daraja | ID formati | Misol |
|---|---|---|
| Mamlakat | UZ | UZ |
| Viloyat | UZ-[XX] | UZ-08 (Navoiy) |
| Tuman | UZ-[XX]-[YYY] | UZ-08-012 (Karmana) |
| Mahalla | UZ-[XX]-[YYY]-[ZZZZ] | UZ-08-012-0045 |
| Kitobxon ID | SL-UZ-[V]-[T]-[M]-[NNNNN] | SL-UZ-08-012-0045-00847 |
| Kutubxona (Davlat) | LIB-GOV-[tuman]-[NNN] | LIB-GOV-08012-001 |
| Kutubxona (Maktab) | LIB-SCH-[tuman]-[NNN] | LIB-SCH-08012-008 |
| Kutubxona (OTM) | LIB-UNI-[tuman]-[NNN] | LIB-UNI-08012-001 |
| Kutubxona (Idora) | LIB-ORG-[tuman]-[NNN] | LIB-ORG-08012-003 |
| Kutubxona (Mahalla) | LIB-MAH-[mahalla_id] | LIB-MAH-08012-0045 |

## 3.2 URL slug tizimi

| URL | Sahifa | Misol |
|---|---|---|
| `sifat.uz` | Bosh sahifa (Landing Page) | — |
| `sifat.uz/[viloyat]` | Viloyat paneli | `sifat.uz/navoiy` |
| `sifat.uz/[v]/[t]` | Tuman paneli | `sifat.uz/navoiy/karmana` |
| `sifat.uz/[v]/[t]/maktab-[N]` | Maktab sahifasi | `sifat.uz/navoiy/karmana/maktab-8` |
| `sifat.uz/[v]/[t]/maktab-[N]/library` | Maktab kutubxonasi | `sifat.uz/navoiy/karmana/maktab-8/library` |
| `sifat.uz/[v]/[t]/otm-[slug]` | OTM sahifasi | `sifat.uz/navoiy/karmana/nuu` |
| `sifat.uz/[v]/[t]/mahalla-[slug]` | Mahalla sahifasi | `sifat.uz/navoiy/karmana/yangiobod` |
| `sifat.uz/top` | Ochiq reytinglar | — |
| `sifat.uz/donate` | Donat sahifasi | — |

> **MISOL:** Navoiy viloyati, Karmana tumani, 8-maktab o'quvchisi → `sifat.uz` ga kiradi → "O'quvchi" tanlaydi → Navoiy → Karmana → 8-maktab → Telefon + SMS → Maktab admin tasdiqlagach → ID: `SL-UZ-08-012-0045-00847` → o'z maktab kutubxonasi ko'rinadi.

## 3.3 Kutubxona tipi

| Tip | Kod | Admin | Maxsus funksiyalar |
|---|---|---|---|
| Davlat kutubxonasi | GOV | Tuman admin | Umumiy foydalanuvchi, katta fond |
| Maktab kutubxonasi | SCH | Maktab admin | O'quvchilar, Jadidlar izidan klub |
| OTM kutubxonasi | UNI | OTM admin | Talabalar, ilmiy adabiyotlar |
| Idora kutubxonasi | ORG | Idora admin | Xodimlar, Kitob o'qish soati |
| Mahalla kutubxonasi | MAH | Mahalla admin | Barcha yoshlar, oila reytingi |

## 3.4 Kutubxona Roaming (Boshqa viloyatda kitob olish)

```
Navoiylik kitobxon Toshkent kutubxonasiga keladi
  ↓
Kutubxonachi QR skan qiladi → Tizim ID ni taniydi
  ↓
Ko'rsatadi: asosiy kutubxona: Navoiy, Karmana
            hozirgi kitoblar: 1 ta (Navoiyda)
            muddati: 10 kun qolgan
  ↓
Kutubxonachi kitob beradi → BORROWED (Toshkent)
  ↓
Qaytarish variantlari:
  A) Toshkentda qaytaradi → avtomatik RETURNED
  B) Navoiyda qaytaradi → "Inter-library return"
     Navoiy kutubxonachi tasdiqlaydi
     Toshkent kutubxonasiga bildirishnoma ketadi
```

## 3.5 Bir kitobxonga kitob limiti

| Foydalanuvchi turi | Standart | Trust Score 90+ | Muddati o'tganda |
|---|---|---|---|
| Oddiy fuqaro | 2 ta | 3 ta | Yangi kitob berilmaydi (blok) |
| Maktab o'quvchisi | 3 ta | 4 ta | Blok |
| Talaba | 5 ta | 6 ta | Blok |
| Davlat xizmatchisi | 3 ta | 4 ta | Blok |

- Har kutubxona o'z limitini sozlashi mumkin (Admin panelda: Min 1, Max 10)
- Kitob muddati: standart **14 kun**, uzaytirish **1 marta (7 kun)**

---

# IV. KITOBXON JARAYONLARI

## 4.1 Kitob qidirish — Joylashuvga asoslangan

Kitobxon kitob qidirganda platforma nafaqat natijalarni, balki QAYERDA topish mumkinligini ko'rsatadi:

```
Kitobxon "Alpomish" qidiradi
  ↓
Tizim joylashuvini aniqlab:

📚 Yaqin kutubxonalar:
   1. Karmana tuman kutubxonasi — 1.2 km | Mavjud: 3 nusxa | Bron mumkin
   2. 8-maktab kutubxonasi — 800 m | Mavjud: 1 nusxa | Bo'sh
   3. Yangiobod mahalla — 2.1 km | Mavjud: 2 nusxa

🛒 Yaqin kitob do'konlari:
   1. Bookmart — 500 m | Narx: 45,000 so'm | Mavjud
   2. Yangi nashr — 1.8 km | Narx: 42,000 so'm | Mavjud

📱 Mutolaa platformasi:
   Elektron versiya mavjud → Mutolaa da o'qish
```

## 4.2 Bron va kitob olish jarayoni

| Qadam | Kim | Harakat | Status |
|---|---|---|---|
| 1 | Kitobxon | Kitobni bron qiladi | PENDING |
| 2 | Kutubxonachi | Bronni tasdiqlaydi, rezerv | RESERVED |
| 3 | Kitobxon | Kutubxonaga keladi, QR ko'rsatadi | — |
| 4 | Kutubxonachi | QR skan, kitob biriktiriladi | BORROWED |
| 5 | Kitobxon | Kitobni o'qib qaytaradi | — |
| 6 | Kutubxonachi | Qaytarishni qayd qiladi | RETURNED |
| 7 | Tizim | Reading Index yangilanadi, fraud tekshiruvi | COMPLETED |

## 4.3 Kutubxonadan tashqari o'qishni hisoblash

| Manba | Tasdiq usuli | Fraud himoya | Koeffitsient |
|---|---|---|---|
| Kutubxona kitobi | Avtomatik (QR) | Kutubxonachi tasdiqlaydi | 1.0x |
| Sotib olingan (ISBN scan) | Foydalanuvchi skan | Comprehension test | 0.9x |
| Kitob do'koni (API) | Do'kon API + telefon | Order ID tasdiq | 0.9x |
| Mutolaa platformasi | API real vaqt sinxron | Sahifa progressi | 0.85x |
| Elektron kitob (boshqa) | Progress + sahifa soni | O'qish tezligi AI tahlili | 0.8x |

## 4.4 Oila moduli

**Oilani aniqlash:**
- Ro'yhatda: Viloyat → Tuman → Mahalla → Ko'cha → Uy → **Xonadon raqami**
- Tizim bir xil xonadondan boshqa foydalanuvchilarni topib taklif ko'rsatadi
- Oila boshlig'i ID/telefon orqali ham qo'lda taklif yuborishi mumkin

**Himoya qoidalari:**
- Bir xil manzil + xonadon raqami majburiy
- Bir foydalanuvchi faqat **bitta** oilada
- Oilaga qo'shilgandan **30 kun** o'tgach reyting hisoblanadi
- Manzil o'zgarishi tuman admin tasdiqlovi talab qiladi

## 4.5 Kitob do'konlari integratsiyasi

**1-bosqich: Manual kabinet (MVP)**
- Do'kon kabinentidan `telefon + ISBN` kiritadi
- Kitobxon tasdiqlaydi → Reading Indexga qo'shiladi

**2-bosqich: To'liq API (V2.0)**

```json
POST /api/v1/purchases
{
  "phone": "+998901234567",
  "isbn": "9789943452787",
  "order_id": "ORD-2026-001",
  "purchase_date": "2026-03-15T10:30:00Z",
  "store_id": "STORE-001",
  "signature": "HMAC-SHA256-hash"
}
```

> **DO'KON UCHUN FOYDA:** 5M+ foydalanuvchi bazasidan yo'naltirish, bepul reklama, oylik traffic hisoboti. Do'kon TO'LAMAYDI — hamkorlik asosida.

---

# V. READING INDEX VA REYTING TIZIMI

## 5.1 Reading Index formulasi

```
Reading Index = (Kitoblar soni    × 30%)
              + (Muntazamlik      × 20%)
              + (Janr xilma-xilligi × 15%)
              + (Qaytarish intizomi × 15%)
              + (Faollik           × 20%)

Natija: 0 – 100 ball
Hisoblash: Har kecha 00:00 da (scheduled job)
```

## 5.2 Top-100 Final Score formulasi

```
Final Score = (Verified Reading × 40%)
            + (Consistency      × 15%)
            + (Diversity        × 10%)
            + (Comprehension    × 15%)
            + (Discipline       × 10%)
            + (Trust Score      × 10%)

Davra: Oylik | Fraud tekshiruvi | Admin tasdiqlovi
```

## 5.3 Barcha ochiq reytinglar (sifat.uz/top)

| Reyting | Yangilanish | Maqsad |
|---|---|---|
| Top-100 kitobxon (umumiy) | Oylik | PQ-9 10-band mukofoti |
| Top-100 erkaklar | Oylik | Gender tenglik |
| Top-100 ayollar | Oylik | Gender tenglik |
| Top-100 o'quvchilar (14-18 yosh) | Oylik | Ta'lim monitoring |
| Top-100 talabalar | Oylik | OTM raqobati |
| Top oilalar | Oylik | Oilaviy kitobxonlik |
| Top mahallalar | Oylik | Hududiy raqobat |
| Top maktablar | Haftalik | Ta'lim sifati |
| Top OTMlar | Oylik | OTM obro'si |
| Top idoralar/vazirliklar | Oylik | PQ-9 9-band |
| Top tumanlar | Kunlik | Hududiy raqobat |
| Top viloyatlar | Kunlik | Milliy monitoring |
| Donat qilganlar (Top-50) | Real vaqt | Ijtimoiy mas'uliyat |
| Eng ko'p o'qilgan kitoblar | Kunlik | Fond shakllantirish |
| Kitobxonlik indeksi xaritasi | Kunlik | Visual monitoring |

## 5.4 Top-100 tanlash bosqichlari

| Bosqich | Jarayon | Muddat |
|---|---|---|
| 1 | Avtomatik ranking — Final Score formulasi | Oyning 28-kuni |
| 2 | AI fraud tekshiruvi — shubhali akkauntlar flaglanadi | 29-kun |
| 3 | Tuman admin flaglangan holatlarni tekshiradi | 30-kun |
| 4 | Super admin tasdiqlaydi, rasmiy Top-100 e'lon | 1-kuni |
| 5 | Mukofot taklifi Jamg'armaga avtomatik yuboriladi | 1-kun |

> **YOPIQ bo'lishi kerak:** 14 yoshgacha bolalar ismlari (faqat `A.K., 12 yosh, Toshkent`), shaxsning aniq manzili, telefon raqami, oila tarkibi, idora xodimlarining individual reytingi.

---

# VI. STATISTIKA VA LANDING PAGE

## 6.1 4 darajali statistika ierarxiyasi

```
RESPUBLIKA (Super admin) — 100+ ko'rsatkich, real vaqt
  └── VILOYAT (Viloyat admin) — 50+ ko'rsatkich, real vaqt
        └── TUMAN (Tuman admin) — 35+ ko'rsatkich, kunlik
              └── MAHALLA (Mahalla admin) — 15+ ko'rsatkich, kunlik
                    └── KUTUBXONA (5 tip)
```

## 6.2 Asosiy ko'rsatkichlar

| Ko'rsatkich | Tavsif | Vizualizatsiya |
|---|---|---|
| Kitobxonlik indeksi | O'sish/pasayish %, 12 oylik trend | Chiziqli grafik |
| Faol kitobxonlar | Jami / Faol (30 kun) / Nofaol | Donut diagramma |
| O'qilgan kitoblar | Kutubxona / Sotib / Elektron | Ustunli grafik |
| Kitob yetishmovchiligi | Ko'p so'ralgan lekin mavjud emas | Jadval + alert |
| Janr tahlili | Eng ko'p va kam o'qilgan janrlar | Gorizontal bar |
| Gender tahlili | Erkak vs Ayol kitobxonlik darajasi | Juft ustun |
| Yosh guruhi | 7-14, 15-30, 31-60, 60+ bo'yicha | Ustunli grafik |
| Xarita | Hududlar bo'yicha rang xarita | Interaktiv (Leaflet.js) |

## 6.3 Landing Page tuzilmasi

```
sifat.uz — Landing Page bloklar (yuqoridan pastga):

┌─────────────────────────────────────────────┐
│ 1. HERO + QIDIRUV                           │
│    "Milliy kutubxonlik platformasi"          │
│    [Kitob qidirish — joylashuvga asoslangan] │
│    Statistika: 11,000+ kutubxona | 5M+ kishi│
├─────────────────────────────────────────────┤
│ 2. REAL VAQT STATISTIKA                     │
│    Bugun o'qilgan: 45,231                   │
│    Faol kutubxona: 2,847                    │
├─────────────────────────────────────────────┤
│ 3. OCHIQ REYTINGLAR                         │
│    Top kitobxonlar | Top mahallalar          │
│    Top maktablar | Donat ro'yhati           │
├─────────────────────────────────────────────┤
│ 4. ROLLAR BO'YICHA KIRISH                   │
│    [Kitobxon] [Maktab] [OTM] [Idora]        │
├─────────────────────────────────────────────┤
│ 5. QANDAY ISHLAYDI (3 qadam)                │
│    Ro'yhat → Kutubxona top → O'qi va ball   │
├─────────────────────────────────────────────┤
│ 6. MUASSASALAR UCHUN (B2B)                  │
│    PQ-9 majburiyatlarini avtomatik bajaring  │
│    [Demo so'rash] [Narxlar]                 │
├─────────────────────────────────────────────┤
│ 7. DONAT BLOKI                              │
│    Jami: 125M so'm | Sarflangan: 98M so'm   │
├─────────────────────────────────────────────┤
│ 8. HAMKOR DO'KONLAR                         │
│    Logo carousel + "Hamkor bo'lish"          │
├─────────────────────────────────────────────┤
│ 9. MOBIL ILOVA                              │
│    App Store | Play Market | QR             │
└─────────────────────────────────────────────┘
```

## 6.4 Smart Alert tizimi

| Daraja | Trigger sharti | Kimga | Harakat |
|---|---|---|---|
| 🔴 KRITIK | Tuman 2 hafta 0 faol kitobxon | Tuman + Viloyat admin | Darhol push + email |
| 🔴 KRITIK | Tizim ishlamayapti | Super admin | SMS + call |
| 🟡 OGOHLANTIRISH | Indeks 10%+ pasaydi | Tuman admin | Shu kuni email |
| 🟡 OGOHLANTIRISH | Kitob 50+ marta so'raldi, fond yo'q | Kutubxonachi | Bildirishnoma |
| 🟡 OGOHLANTIRISH | Klub 30 kun debat o'tkazmadi | Klub rahbari | Push |
| 🟢 AXBOROT | Indeks 15%+ o'sdi | Viloyat admin | Haftalik hisobot |

---

# VII. AI TIZIMI

## 7.1 AI Arxitekturasi

```
Ma'lumot oqimi:

PostgreSQL + Redis
      ↓
Apache Kafka (real vaqt event streaming)
      ↓
Python FastAPI — AI Engine
  ├── Modul 1: Real Vaqt Audit Engine
  ├── Modul 2: Natural Language Interface (RAG + LLM)
  ├── Modul 3: Predictive Analytics (ARIMA/Prophet)
  ├── Modul 4: Root Cause Analysis
  ├── Modul 5: Avtomatik Hisobot Generatsiyasi
  └── Modul 6: Kitob Tavsiya Tizimi
      ↓
API Gateway → Admin Panel / Hokim Dashboard
```

| Qatlam | Texnologiya | Vazifasi |
|---|---|---|
| Event streaming | Apache Kafka | Har bir harakatni real vaqtda uzatish |
| AI Engine | Python 3.11 + FastAPI | Barcha AI modellarni boshqarish |
| ML | scikit-learn + PyTorch | Fraud detection, predictive models |
| LLM | GPT-4 / Mistral (o'zbek fine-tuned) | O'zbek tilida savol-javob |
| Vector DB | Pinecone / Weaviate | RAG uchun semantic qidiruv |
| Cache | Redis | Real vaqt hisoblash natijalari |

## 7.2 Modul 1: Real Vaqt Audit Engine

| Monitoring ob'ekti | Muammo belgisi | AI harakati | Alert |
|---|---|---|---|
| Tuman kitobxonlik indeksi | 2 hafta ketma-ket pasayish | Sabab tahlili + tavsiya | 🔴 KRITIK |
| Kutubxona fond | 50+ so'rov, kitob yo'q | Yaqin kutubxona tekshiruv | 🟡 |
| Kutubxona faolligi | 30 kun faol kitobxon yo'q | Sabab: vaqt/joylashuv/fond | 🟡 |
| Jadidlar izidan klubi | 45 kun debat yo'q | Klub rahbariga xabar | 🟡 |
| Idora kitob o'qish soati | Bir oy o'tkazilmagan | Idora adminga xabar | 🟡 |

## 7.3 Modul 2: Natural Language Interface

**RAG arxitektura:** Admin o'zbek tilida savol yozadi → AI real ma'lumotdan oladi → Javob + grafik

| Savol misoli | AI javobi (qisqacha) | Vizualizatsiya |
|---|---|---|
| "Navoiyda bu oy kitobxonlik qanday?" | Indeks 67.3 ball, +4.2% o'sdi. Eng faol: Karmana (78.1). Eng kam: Tomdi (41.2). | Grafik + xarita |
| "Qaysi maktablarda klub faoliyatsiz?" | 12 ta maktab 45+ kun debat o'tkazmagan. Ro'yhat va kun soni. | Jadval + xarita |
| "Qaysi kitob ko'p so'ralmoqda, lekin yo'q?" | Top-5 yetishmayotgan kitob, so'rovlar soni, narx taklifi. | Jadval |
| "Toshkentda kitobxonlik nima uchun pasaydi?" | 3 sabab: 2 kutubxona ta'mirda, 15-25 yosh -18%, elektron +34%. | Pie + trend |
| "Yillik maqsadga erishamizmi?" | Hozirgi trendda 78% ehtimol. | Bashorat grafigi |

## 7.4 Modul 3: Predictive Analytics

| Bashorat | Vaqt oralig'i | Aniqlik maqsadi |
|---|---|---|
| Tuman kitobxonlik indeksi | 1 oy | ±5% |
| Yillik maqsadga erishish | Yil oxirigacha | ±8% |
| Fond yetishmovchiligi | 2 hafta | ±10% |
| Klub faollik pasayishi | 3 hafta | ±12% |

## 7.5 Modul 4: Root Cause Analysis

```
MISOL:
Karmana tumani indeksi 15% pasaydi
  ↓
AI tekshiradi:
  ├── Kutubxona ta'miridami?     → Ha (2 ta)
  ├── Xodim almashdimi?          → Ha (1 ta)
  ├── Fond yangilandimi?         → Yo'q (8 oy)
  └── Mavsumiy ta'sir?           → Ha (yoz ta'tili)
  ↓
XULOSA: Asosiy sabab — yoz ta'tili + 2 kutubxona ta'mirda
TAVSIYA: Ta'mir muddatini qisqartirish, onlayn kutubxonani faollashtirish
```

## 7.6 Modul 6: Kitob Tavsiya Tizimi

| Tavsiya turi | Algoritm | Kimga |
|---|---|---|
| Yoshga mos kitoblar | Content-based filtering | Barcha |
| O'xshash kitobxonlar o'qigan | Collaborative filtering | Barcha |
| Hududda mashhur | Geographical popularity | Mahalla/tuman |
| Klub debatiga mos | NLP tema tahlili | Klub a'zolari |
| Kasb bo'yicha | Foydalanuvchi turi filtri | Davlat xizmatchilari |

---

# VIII. XAVFSIZLIK ARXITEKTURASI

## 8.1 Autentifikatsiya

| Mexanizm | Tavsif | Sozlama |
|---|---|---|
| JWT Access Token | Qisqa muddatli kirish | 15 daqiqa, HS256 |
| JWT Refresh Token | Uzoq muddatli yangilash | 30 kun, HttpOnly Cookie |
| Token Rotation | Har yangilashda yangi token | Eski token darhol bekor |
| RBAC | Rol asosida ruxsat | Har endpoint uchun permission |
| ID.UZ integratsiya | Davlat foydalanuvchilari | PKCE OAuth2.0 flow |
| QR kod dinamik | Soxtalikka qarshi | Har 5 daqiqada yangilanadi, HMAC imzo |

## 8.2 OWASP Top 10 himoya

| OWASP tahdid | Yechim | Holat |
|---|---|---|
| A01: Broken Access Control | RBAC + middleware | ✅ |
| A02: Cryptographic Failures | AES-256, TLS 1.3, bcrypt(12) | ✅ |
| A03: Injection | Parameterized queries, ORM, Zod | ✅ |
| A04: Insecure Design | Threat modeling | ✅ |
| A05: Misconfiguration | IaC (Terraform), hardening | ✅ |
| A06: Vulnerable Components | Dependabot, haftalik audit | ✅ |
| A07: Auth Failures | Rate limiting, token rotation | ✅ |
| A08: Data Integrity | HMAC imzo, integrity check | ✅ |
| A09: Logging Failures | Audit log (append-only) | ✅ |
| A10: SSRF | URL whitelist, egress filtering | ✅ |

## 8.3 Ma'lumotlar himoyasi

| Ma'lumot | Himoya | Saqlash joyi |
|---|---|---|
| Foydalanuvchi paroli | bcrypt (salt 12) | PostgreSQL (faqat hash) |
| Shaxsiy ma'lumotlar | AES-256-GCM | PostgreSQL (encrypted) |
| API kalitlar | HashiCorp Vault | Secrets Manager |
| Barcha ma'lumotlar | O'zbekiston serverlarida (qonun) | Unicon.uz / TIF DC |
| Backup | AES-256, 3 joy | S3 + kunlik, 30 kun |

> ⚠️ **SERVER LOKALIZATSIYASI:** O'zbekiston qonuni bo'yicha barcha shaxsiy ma'lumotlar O'zbekiston serverlarida saqlanishi majburiy. Cloudflare faqat CDN uchun.

## 8.4 Audit log qoidalari

- **Append-only** — hech kim (hatto Super Admin) o'zgartira olmaydi
- Saqlanadigan: `kim | qachon | nima | qayerdan | natija`
- Saqlash muddati: **2 yil** + alohida arxiv serveriga ko'chirish
- Real vaqt SIEM integratsiya — shubhali harakatlar darhol aniqlanadi

---

# IX. FRONTEND ARXITEKTURASI

## 9.1 Texnologiyalar

| Kategoriya | Texnologiya | Sababi |
|---|---|---|
| Framework | Next.js 14 (App Router) | SSR, SEO, ko'p tilli, performance |
| Styling | Tailwind CSS + shadcn/ui | Tezkor UI, design system |
| State Management | Zustand + React Query | Server + client state |
| Grafiklar | Recharts + D3.js | Statistika panellari |
| Xarita | Leaflet.js | Hududiy reyting vizualizatsiyasi |
| Real vaqt | WebSocket (Socket.IO) | Dashboard live yangilanish |
| PWA | next-pwa | Offline rejim, qishloq joylari |
| Test | Jest + Playwright | Unit + E2E testlar |

## 9.2 Ko'p tillilik

| Til | Kod | Bosqich |
|---|---|---|
| O'zbek lotin | uz-Latn | MVP — asosiy til |
| O'zbek kirill | uz-Cyrl | MVP |
| Qoraqalpoq | kaa | V1.0 |
| Rus | ru | V1.0 |

## 9.3 Performance maqsadlar (Core Web Vitals)

| Metrika | Maqsad |
|---|---|
| LCP (Largest Contentful Paint) | < 2.5 soniya |
| FID (First Input Delay) | < 100 ms |
| CLS (Cumulative Layout Shift) | < 0.1 |
| Sahifa yuklanishi (3G) | < 4 soniya |
| Bundle hajmi (gzip) | < 200 KB |

## 9.4 Offline rejim (Qishloq maktablari uchun)

- **PWA** — internetisiz asosiy funksiyalar 12 soat ishlaydi
- Kutubxonachi telefoni = terminal (smartfon yetarli)
- Internet kelganda avtomatik sinxronlash
- **2G** uchun yengil versiya (rasmlar yuklanmaydi, text-only)

---

# X. BACKEND ARXITEKTURASI

## 10.1 Texnologiyalar

| Kategoriya | Texnologiya | Maqsadi |
|---|---|---|
| Runtime | Node.js 20 LTS | Asosiy server |
| Framework | NestJS 10 | Modulli arxitektura, TypeScript |
| ORM | Prisma | Type-safe DB so'rovlar |
| Asosiy DB | PostgreSQL 15 | Relatsional ma'lumotlar |
| Cache | Redis 7 | Session, rate limit, hot data |
| Qidiruv | Elasticsearch 8 | Full-text qidiruv |
| Message Queue | BullMQ | Email, hisobot, AI (async) |
| Event Streaming | Apache Kafka | Real vaqt AI audit |
| Fayl saqlash | MinIO (O'zbekistonda) | Rasmlar, hujjatlar |

## 10.2 Asosiy jadvallar (Database Schema)

```sql
-- Asosiy jadvallar

users (id, phone, name, dob, gender, type, address_id,
       family_id, trust_score, status, created_at)

addresses (id, viloyat_id, tuman_id, mahalla_id,
           street, house, apartment)

libraries (id, type[GOV|SCH|UNI|ORG|MAH], institution_id,
           name, region_id, fund_count, status)

books (id, isbn, title, author, genre, lang,
       pages, year, library_id, available_count)

book_transactions (id, user_id, book_id, type, status,
                   borrowed_at, returned_at, return_library_id)

reading_index (id, user_id, score, components JSONB,
               calculated_at)

fraud_scores (id, user_id, risk_score, flags JSONB,
              action, checked_at)

subscriptions (id, library_id, plan_type, status,
               start_date, end_date, trial_end)

invoices (id, subscription_id, amount, due_date,
          paid_date, payment_method, status)

ai_audit_logs (id, scope, scope_id, issue_type,
               severity, analysis, recommendation, resolved)

risk_log (id, risk_type, severity, description,
          mitigation_status, created_at)
```

## 10.3 Caching strategiyasi

| Ma'lumot | Cache muddati | Strategiya |
|---|---|---|
| Hududiy statistika | 5 daqiqa | Redis write-through |
| Top-100 reyting | 1 soat | Redis scheduled refresh |
| Kitob qidiruv | 10 daqiqa | Redis + Elasticsearch |
| AI tavsiyalar | 30 daqiqa | Redis user-specific |
| Statik ma'lumotlar | 24 soat | Redis + CDN |

---

# XI. CI/CD VA DEVOPS

## 11.1 Git branching (GitFlow)

| Branch | Maqsad | Himoya | Deploy |
|---|---|---|---|
| `main` | Production — doim stable | 2 review + CI majburiy | Production avtomatik |
| `develop` | Integratsiya | 1 review + CI majburiy | Staging avtomatik |
| `feature/[nomi]` | Yangi funksiya | CI majburiy | Dev avtomatik |
| `hotfix/[nomi]` | Tezkor tuzatish | 2 review + CI | Production + develop |

## 11.2 CI/CD Pipeline

```yaml
# PR ochilganda:
steps:
  1. Lint + TypeScript check
  2. Unit testlar (coverage > 80% majburiy)
  3. Integration testlar
  4. Security scan (Snyk + npm audit)
  5. Docker build tekshiruvi
  6. Code review (1+ senior developer)

# Develop ga merge:
  + E2E testlar (Playwright)
  + Lighthouse CI (performance maqsadlar)
  + Staging ga avtomatik deploy
  + Smoke test

# Main ga merge (Production):
  + PM va Tech Lead tasdiq MAJBURIY
  + Database migration (backward-compatible)
  + Zero-downtime deploy (Rolling update)
  + Production smoke test
  + Monitoring alertlar yoqilishi
```

## 11.3 Muhitlar (Environments)

| Muhit | URL | Ma'lumot | Deploy |
|---|---|---|---|
| Development | localhost | Seed ma'lumot | Qo'lda |
| Dev server | dev.sifat.uz | Anonymized copy | Feature merge |
| Staging | staging.sifat.uz | Production nusxasi | Develop merge |
| Production | sifat.uz | Haqiqiy | Main + tasdiq |

## 11.4 SLA ko'rsatkichlari

| Ko'rsatkich | Maqsad |
|---|---|
| API javob vaqti (p50) | < 150 ms |
| API javob vaqti (p99) | < 500 ms |
| Sahifa yuklanishi (LCP) | < 2.5 s |
| Tizim uptime | 99.9% |
| Bir vaqtda foydalanuvchilar | 50,000+ |
| RPO (ma'lumot yo'qotish) | < 1 soat |
| RTO (tiklash vaqti) | < 4 soat |
| Fraud detection aniqligi | 95%+ |

---

# XII. ROADMAP VA MUVOFIQLIK

## 12.1 Loyiha Roadmap

| Bosqich | Muddat | Asosiy yetkazilmalar | Muvaffaqiyat mezoni |
|---|---|---|---|
| MVP | 1-8 hafta | Kutubxona, foydalanuvchi, kitob olish/qaytarish, Reading Index | 100 kutubxona, 1,000 foydalanuvchi |
| Beta | 9-14 hafta | Maktab, Jadidlar izidan, Oila, Top-100, Fraud, Mutolaa | 500 maktab, 10,000 foydalanuvchi |
| V1.0 | 15-20 hafta | Idora, Do'kon, AI Audit, NL Interface, To'lov | 1,000,000 foydalanuvchi |
| V2.0 | 21-28 hafta | Do'kon API, Predictive, OTM, Ko'p tilli | 5,000,000 foydalanuvchi |
| Kelajak | 28+ hafta | Mobil ilova, Audiokitob, AI yordamchi | Milliy ekotizim |

---

# XIII. SUBSCRIPTION MANAGEMENT

## 13.1 Tarif rejalari

| Tip | Kod | To'lov usuli | Tasdiq |
|---|---|---|---|
| Davlat kutubxonasi | GOV | Davlat byudjeti (markazlashgan) | Avtomatik |
| Mahalla kutubxonasi | MAH | Davlat byudjeti | Avtomatik |
| Maktab kutubxonasi | EDU-SCH | Davlat byudjeti yoki maktab | Admin tasdiq |
| OTM kutubxonasi | EDU-UNI | OTM o'zi (Payme/Click/Bank) | To'lov orqali |
| Idora kutubxonasi | ORG | Idora o'zi (Payme/Click/Bank) | To'lov orqali |

## 13.2 Abonent holatlari

| Holat | Kod | Tavsif | Kirish | Kim o'zgartiradi |
|---|---|---|---|---|
| Trial | TRIAL | 30 kun bepul sinov | To'liq | Tizim (boshlanadi) |
| Faol | ACTIVE | To'lov amalga oshirilgan | To'liq | To'lov orqali avtomatik |
| Kutilmoqda | PENDING | Faktura yuborilgan | Saqlanadi (15 kun) | Tizim (eslatmalar) |
| Muzlatilgan | FROZEN | Admin to'xtatgan | Yo'q, data saqlanadi | **Faqat admin qo'lda** |
| O'chirilgan | DELETED | Admin o'chirgan | Yo'q, 90 kun arxivda | **Faqat Super Admin** |

> ⚠️ **ASOSIY QOIDA:** Muzlatish va o'chirish HECH QACHON avtomatik bo'lmaydi. Faqat admin qaror qiladi va sabab ko'rsatadi.

## 13.3 Trial davri jarayoni

```
0-kun   → Admin kutubxona qo'shadi → Trial 30 kun boshlanadi
20-kun  → Ogohlantirish 1: "10 kun qoldi" (email)
27-kun  → Ogohlantirish 2: "3 kun qoldi" (email + SMS)
30-kun  → Trial tugadi → PENDING holat → Faktura yaratiladi
30-45   → To'lov muhlati (kirish saqlanadi)
45-kun+ → Admin qaror: ACTIVE yoki FROZEN
```

---

# XIV. BIZNES MODEL

## 14.1 Asosiy daromad manbalari

| Manba | Model | Taxminiy ulush |
|---|---|---|
| Davlat kontrakt (Yoshlar ishlari agentligi) | Yillik shartnoma | 40-50% |
| Maktab abonent to'lovi | Yillik SaaS (o'quvchilar soni bo'yicha) | 25-30% |
| OTM abonent to'lovi | Yillik SaaS (talabalar soni bo'yicha) | 10-15% |
| Idora abonent to'lovi | Yillik SaaS (xodimlar soni bo'yicha) | 10-15% |
| Kitob do'koni premium badge | Ixtiyoriy hamkorlik | 5-10% |

## 14.2 Kitob do'konlari — Hamkorlik (TO'LOVCHI EMAS)

> **MUHIM:** Kitob do'konlari platformaga TO'LAMAYDI. Biz ularga 5M+ foydalanuvchi bazasidan mijoz yuboramiz. Kelajakda Revenue share (tushumdan 3-5%) modeli kiritilishi mumkin.

## 14.3 Nima uchun to'laydilar?

**Maktablar:**
- Har chorak qog'oz hisobot → Avtomatik 1 tugma PDF
- Jadidlar izidan isboti → Klub monitoring, hujjat tayyor
- Kim o'qiyapti? → Har o'quvchi Reading Index
- Respublika reytingi → Real vaqt maktab reytingi

**OTMlar:**
- Akkreditatsiyada raqamlashuv talab qilinadi → To'liq raqamli kutubxona
- Talabalar kitob topa olmaydi → 5 ta yaqin kutubxona birlashtiriladi

**Idoralar (MAJBURIY — PQ-9):**
- Kitob burchagi (1 aprelga qadar majburiy)
- Kitob o'qish soati (har oy majburiy)
- Ichki reyting tizimi (majburiy)
- Eng faol xodimga mukofot (majburiy)

> **ASOSIY ARGUMENT:** Platformasiz — qo'lda hujjat, xatolik, nazoratdan qolish. Platforma bilan — avtomatik, hujjat tayyor, tinch ish. Narxi = bitta xodim oyligidan arzon.

## 14.4 Taxminiy daromad modeli

| Senariy | Maktablar | OTMlar | Idoralar | Mahalla | JAMI |
|---|---|---|---|---|---|
| Konservativ (1-yil) | 2,000 × 2.5M = 5 mlrd | 80 × 15M = 1.2 mlrd | 300 × 6M = 1.8 mlrd | 500 × 1.5M = 750M | ~8.75 mlrd so'm |
| Optimistik (2-3-yil) | 5,000 × 3M = 15 mlrd | 150 × 20M = 3 mlrd | 1,000 × 8M = 8 mlrd | 2,000 × 2M = 4 mlrd | ~30 mlrd so'm |

---

# XV. RISK MANAGEMENT

## 15.1 KRITIK risklar — Darhol yechim kerak

| # | Risk | Oqibat | Oldini olish |
|---|---|---|---|
| R1 | Serverlar O'zbekistonda bo'lishi qonun talabi | Platforma yopilishi, jarima | Asosiy serverlar Unicon.uz/TIF DC. Xorijiy faqat CDN. Lokalizatsiya sertifikati |
| R2 | Davlat byudjeti kechikishi/bekor qilinishi | Asosiy daromad to'xtaydi | Kontrakt MVP oldidan. 6 oylik zaxira fond. Parallel maktab/OTM abonentlari |
| R3 | Soxta kitobxonlar (25x BHM mukofot uchun) | Top-100 noto'g'ri, ishonch yo'qoladi | AI Fraud Detection. Comprehension test. Joylashuv tekshiruvi. Top-100 interview |
| R4 | Kutubxonachi malakasi past | Platforma ishlatilmaydi | UI juda oddiy (3 tugma). Video darslik. Bepul support. USSD versiya |
| R5 | Maxfiylik muammosi — "davlat kuzatyapti" | Foydalanuvchi kelmaydi | O'qish tarixini yashirish opsiyasi. Mustaqil audit. Ma'lumotni o'chira oladi |

## 15.2 YUQORI risklar — MVP dan oldin yechim

| # | Risk | Oqibat | Oldini olish |
|---|---|---|---|
| R6 | Internet infratuzilmasi zaif (qishloq, 2G) | Platforma ishlamaydi | PWA offline 12 soat. SMS/USSD. Lokal server (Raspberry Pi). 2G versiya |
| R7 | AI o'zbek tilini yaxshi tushunmaydi | Admin ishonmaydi | GPT-4 + o'zbek fine-tuning. Dastlab shablon. Oyda qayta o'qitish |
| R8 | Maktablar to'lashdan bosh tortadi | Asosiy segment yo'qoladi | 6 oy bepul trial. Vazirlik buyrug'i. Subsidiya modeli. Pilot muvaffaqiyati |
| R9 | Ma'lumotlar sizintisi (hacker) | Qonuniy javobgarlik, obro' halok | Pentest (6 oyda). Bug bounty. AES-256. Incident Response Plan |
| R10 | Raqobatchi paydo bo'lishi | Bozordan siqib chiqarilish | PQ-9 rasmiy hamkorlik. Ma'lumotlar bazasi monopoliyasi. Tezkor MVP (3 oy) |

## 15.3 O'RTA risklar — V1.0 dan oldin yechim

| # | Risk | Oldini olish |
|---|---|---|
| R11 | Kitob do'koni integratsiyadan bosh tortadi | Ma'lumotlar anonim. Do'konga traffic report. ISBN scan fallback |
| R12 | OTM va idoralar passiv (tick the box) | Faollik minimumi. 3 oy faolsiz = ogohlantirish. Vazirlik reytingida pastga |
| R13 | Jadidlar izidan klubi soxta qayd | Comprehension test. Debat videosi majburiy. Tuman admin tekshiruvi |
| R14 | Siyosiy o'zgarish (yangi vazir/hukumat) | Ko'p vazirlik integratsiya. Foydalanuvchi bazasi = himoya. UNESCO/UNICEF |
| R15 | Til muammosi (Qoraqalpoq, Rus) | MVP: O'zbek. V1.0: + Qoraqalpoq + Rus |

## 15.4 Ko'zda tutilmagan risklar

| # | Risk | Yechim |
|---|---|---|
| R16 | Elektr uzilishi (qishloq) | Offline 12 soat. Telefon = terminal. Qog'oz zaxira log |
| R17 | Telefon raqam o'zgarishi | PINFL bog'lash (ixtiyoriy). Zaxira email. Admin orqali o'zgartirish |
| R18 | Kutubxona ta'mirga yopilsa | 2 hafta oldin bildirishnoma. Muddatni avtomatik uzaytirish |
| R19 | Kitob yo'qolsa/buzilsa | Sug'urta depoziti (ixtiyoriy). Jarima: narx × 2. Ko'p marta = blok |
| R20 | Kutubxonachi tizimni chetlab beradi | Faqat QR orqali majburiy. Oylik fond inventarizatsiya. 5%+ farq = alert |
| R21 | 5M foydalanuvchi yuklamasi | Auto-scaling. Load testing. CDN. DB read replicas. Queue tizimi |
| R22 | QR skrinshot soxtalash | QR dinamik (5 daqiqa). HMAC imzo. Joylashuv tekshiruvi |
| R23 | Platforma muvaffaqiyatli — hajm muammosi | 6 oyda capacity planning. Cold/warm/hot storage. Microservices |

---

---

# SPRINT REJASI

## Umumiy ko'rinish

| Sprint | Nomi | Muddat | Tasklar | Story Points | Asosiy natija |
|---|---|---|---|---|---|
| Sprint 1 | Infratuzilma va loyiha asosi | 1-2 hafta | 12 | 89 SP | Dev muhit, CI/CD, DB schema tayyor |
| Sprint 2 | Auth va foydalanuvchi tizimi | 3-4 hafta | 11 | 84 SP | Ro'yhat, login, unikal ID, QR |
| Sprint 3 | Kutubxona va fond boshqaruvi | 5-6 hafta | 13 | 97 SP | Kutubxona CRUD, fond, QR skan |
| Sprint 4 | Kitob jarayonlari | 7-8 hafta | 12 | 91 SP | ⭐ MVP: Bron→Olish→Qaytarish |
| Sprint 5 | Reading Index va reyting | 9-10 hafta | 11 | 86 SP | Reading Index, Top-100, ochiq reyting |
| Sprint 6 | Statistika va Landing Page | 11-12 hafta | 12 | 88 SP | Dashboard, xarita, landing page |
| Sprint 7 | Maktab, Klub va Oila | 13-14 hafta | 13 | 95 SP | ⭐ BETA: Maktab, Jadidlar izidan |
| Sprint 8 | AI tizimi va Fraud Detection | 15-16 hafta | 12 | 102 SP | AI Audit, NL Interface, fraud |
| Sprint 9 | Idora, Subscription, Buxgalter | 17-18 hafta | 11 | 87 SP | Idora moduli, Payme/Click |
| Sprint 10 | Integratsiyalar va V1.0 Release | 19-20 hafta | 11 | 83 SP | ⭐ V1.0: Production release |
| **JAMI** | | **20 hafta** | **118 task** | **902 SP** | |

---

# SPRINT 1 — Infratuzilma va Loyiha Asosi

**Muddat:** 1-2 hafta (14 kun)  
**Jamoa:** DevOps + Backend Lead + DBA  
**Maqsad:** Barcha dasturchilar ishlashi uchun asos yaratish. Bu sprint tugaguncha hech qanday biznes logika yo'q, faqat texnik poydevor tayyor bo'ladi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **Monorepo tuzilmasi** | Git repo, papka tuzilmasi, .gitignore, branch qoidalari, commit convention | DevOps | 5 | Git repo mavjud, main/develop/feature branchlar sozlangan, PR template tayyor |
| 2 | **Docker Compose sozlash** | PostgreSQL, Redis, Elasticsearch, Kafka, MinIO lokalda ishlasin | DevOps | 8 | `docker-compose up` bilan barcha servislar 5 daqiqada ko'tariladi |
| 3 | **PostgreSQL schema** | Barcha 11 ta jadval: users, libraries, books, transactions, reading_index, fraud_scores, subscriptions, invoices, payments, ai_audit_logs, risk_log | DBA | 13 | Prisma migration ishlaydi, seed ma'lumotlar yuklanadi, barcha foreign key'lar to'g'ri |
| 4 | **NestJS loyiha skeleti** | Modullar: Auth, Users, Libraries, Books, Transactions, Reading, Admin, AI. Swagger sozlash | Backend | 8 | `npm run start:dev` ishga tushadi, Swagger `/api/docs` ochiladi |
| 5 | **Next.js loyiha skeleti** | App Router, Tailwind, shadcn/ui, i18n (uz-Latn/uz-Cyrl), tematizatsiya, papka tuzilmasi | Frontend | 8 | `localhost:3000` ochiladi, til almashtirish ishlaydi |
| 6 | **GitHub Actions CI pipeline** | Lint → TypeScript → Unit test → Docker build har PR da avtomatik | DevOps | 8 | PR ochilganda pipeline avtomatik ishlaydi (< 10 daqiqa) |
| 7 | **Dev va Staging server** | `dev.sifat.uz` va `staging.sifat.uz`, Nginx, SSL (Let's Encrypt), firewall | DevOps | 8 | Brauzarda ochiladi, HTTPS ishlaydi, HTTP → HTTPS redirect |
| 8 | **Avtomatik deploy** | develop → dev.sifat.uz, main → staging.sifat.uz avtomatik deploy | DevOps | 5 | Develop ga push = 3 daqiqada dev serverda ko'rinadi |
| 9 | **HashiCorp Vault** | DB parollar, JWT secret, API kalitlar Vault da. .env dan o'chirish | DevOps | 8 | Barcha secretlar `.env` da emas, Vault dan o'qiladi, rotate ishlaydi |
| 10 | **Monitoring asosi** | Prometheus + Grafana + Loki + Sentry (frontend va backend). Alert qoidalari | DevOps | 8 | Grafana dashboardda server metrics ko'rinadi, test alert ishlaydi |
| 11 | **Redis va BullMQ** | Email va bildirishnomalar uchun queue tizimi, retry logika, dead letter queue | Backend | 5 | Test job queue orqali ishlaydi, muvaffaqiyatsiz job qayta urinadi |
| 12 | **Elasticsearch indekslar** | Kitob (title, author, isbn, genre, lang) va foydalanuvchi uchun index mapping, analyzer | DBA | 5 | Test qidiruv so'rovi 100ms da javob beradi, o'zbek tilida fuzzy qidiruv |

**✅ Sprint 1 natijasi:** Dev muhit to'liq ishlamoqda. CI/CD pipeline sozlangan. DB schema tayyor (11 jadval). Barcha dasturchilar loyihaga qo'shilishi va ishlashi mumkin.

---

# SPRINT 2 — Autentifikatsiya va Foydalanuvchi Tizimi

**Muddat:** 3-4 hafta (14 kun)  
**Jamoa:** Backend + Frontend + Mobile (SMS)  
**Maqsad:** Foydalanuvchi ro'yhatdan o'ta oladi, kirishi mumkin, unikal ID oladi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **SMS OTP tizimi** | Eskiz.uz yoki SMS.uz API integratsiya, OTP yaratish, 2 daqiqa muddati, rate limiting (5 urinish/soat) | Backend | 8 | Telefonga SMS keladi, noto'g'ri kod 3 marta = 15 daqiqa blok |
| 2 | **JWT auth tizimi** | Access (15 min) + Refresh (30 kun) tokenlar, HttpOnly cookie, token rotation, blacklist | Backend | 8 | Login → token → `/me` endpoint ishlaydi, token rotatsiya ishlaydi |
| 3 | **Ro'yhat: Telefon qadam** | Telefon kiritish sahifasi, SMS yuborish, OTP kod tasdiqlash UI, resend timer | Frontend | 5 | Telefon + SMS kod bilan ro'yhat boshlanadi, 60 soniya resend timer |
| 4 | **Ro'yhat: Shaxsiy ma'lumotlar** | Ism, familiya, tug'ilgan sana (datepicker), jins (radio), Zod validatsiya | Frontend | 5 | Noto'g'ri sana kiritilsa xato ko'rsatiladi |
| 5 | **Ro'yhat: Manzil kaskad** | Viloyat→Tuman→Mahalla kaskad select (DB dan), ko'cha, uy, xonadon. 14 viloyat, 200+ tuman | Frontend + Backend | 8 | 14 viloyat, 200+ tuman, 10000+ mahalla tanlash ishlaydi, xonadon raqami majburiy |
| 6 | **Ro'yhat: Foydalanuvchi tipi** | Oddiy fuqaro / O'quvchi / Talaba / Xizmatchi / O'qituvchi — har biri uchun qo'shimcha form | Frontend | 8 | Har tip uchun to'g'ri maydonlar ko'rinadi, validatsiya ishlaydi |
| 7 | **Unikal ID generatsiya** | `SL-UZ-[V]-[T]-[M]-[N]` format, QR kod generatsiya (qrcode.js), profil sahifada ko'rish | Backend | 5 | Har foydalanuvchi o'ziga xos ID va QR oladi, QR skan qilinsa ma'lumot ko'rinadi |
| 8 | **PENDING → ACTIVE tasdiqlash** | Admin panelda yangi arizalar ro'yhati, tasdiqlash/rad tugmalari, sabab kiritish, bildirishnoma | Backend + Frontend | 8 | Admin tasdiqlasa ACTIVE, rad etsa sabab bilan xabar ketadi, 14 kun o'tsa fuqaro |
| 9 | **RBAC permission tizimi** | Har rol uchun permission ro'yhati, NestJS Guard larida tekshiruv, unauthorized response | Backend | 8 | Kutubxonachi admin panelga kira olmaydi, noto'g'ri rol = 403 |
| 10 | **Profil sahifasi** | Ko'rish: QR, ID, statistika (o'qilgan kitoblar, Reading Index). Tahrirlash: ism, manzil | Frontend | 5 | Profil sahifasi to'liq ishlaydi, QR yuklab olish mumkin |
| 11 | **Kirish tiklash** | Telefon → SMS OTP → yangi session. Eski sessionlar bekor qilinadi | Backend + Frontend | 5 | Kirish yo'qotilsa telefon orqali tiklash ishlaydi, eski tokenlar bekor |

**✅ Sprint 2 natijasi:** 5 tip foydalanuvchi ro'yhatdan o'ta oladi. Unikal `SL-UZ-...` ID va QR kod beriladi. Admin tasdiqlash ishlaydi. JWT auth ishonchli ishlaydi.

---

# SPRINT 3 — Kutubxona va Fond Boshqaruvi

**Muddat:** 5-6 hafta (14 kun)  
**Jamoa:** Backend + Frontend + DBA  
**Maqsad:** Kutubxona tizimga ulanadi, fond yuklanadi, kutubxonachi ishlash boshlaydi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **Kutubxona CRUD API** | POST/GET/PUT/DELETE `/libraries`, 5 tip, ierarxik ID generatsiya, holat boshqaruvi | Backend | 8 | Kutubxona yaratiladi, ID `LIB-SCH-08012-008` shaklida, CRUD ishlaydi |
| 2 | **Kutubxona ro'yhat va tasdiq** | Muassasa ariza yuboradi → tuman admin → super admin → ACTIVE. 3 bosqichli | Backend + Frontend | 8 | Har bosqichda bildirishnoma ketadi, tasdiqlanmasa 30 kunda avtomatik xabar |
| 3 | **Muassasa admin paneli** | Fond, statistika, subscription holati, foydalanuvchilar, kutubxonachi boshqaruvi | Frontend | 8 | Maktab admin o'z kutubxonasini, o'z o'quvchilarini boshqara oladi |
| 4 | **Kitob fond yuklanishi** | Excel import (XLSX parse, 500+ kitob), manual kiritish formi, atributlar, progress indicator | Backend + Frontend | 13 | 500 kitobni Excel dan 2 daqiqada yuklash mumkin, xatoli qatorlar ko'rsatiladi |
| 5 | **ISBN validatsiya va avtoto'ldirish** | ISBN-13 format tekshiruvi, Open Library API / Google Books orqali muallif, nom, muqova avtoto'ldirish | Backend | 5 | ISBN kiritilsa muallif va nom avtomatik to'ldiriladi |
| 6 | **Kitob qidiruv (Elasticsearch)** | Full-text: muallif, nom, janr, til, yosh kategoriyasi filtrlash, relevance scoring | Backend | 8 | "Alpomish" yozsam 100ms da natijalar, typo-tolerant ishlaydi |
| 7 | **Joylashuvga asoslangan qidiruv** | Kitobxon joylashuviga (GPS yoki manzil) qarab yaqin kutubxonalar + mavjud nusxalar + do'konlar | Backend | 8 | "Alpomish" qidirsam: 3 yaqin kutubxona + 2 do'kon ko'rinadi, masofalar bilan |
| 8 | **Kutubxona profil sahifasi** | Ommaviy: manzil, ish vaqti, fond soni, mavjud kitoblar, reyting. SEO friendly URL | Frontend | 5 | URL bo'yicha kutubxona sahifasi ochiladi, xaritada ko'rinadi |
| 9 | **QR kod skan (PWA)** | Kutubxonachi kamerasi bilan QR skan (PWA camera API), foydalanuvchi ma'lumoti ko'rsatish | Frontend | 8 | Kutubxonachi telefoni bilan QR skan qiladi, 2 soniyada ma'lumot ko'rinadi |
| 10 | **Offline rejim asosi (PWA)** | Service Worker, IndexedDB, katalog va fond keshlanadi, offline bildirish banner | Frontend | 8 | Internet o'chsa kutubxona katalogi 12 soat ko'rinadi, offline banner ko'rsatiladi |
| 11 | **Kutubxona tipi dashboard** | GOV, SCH, UNI, ORG, MAH uchun har xil dashboard template va statistika ko'rsatkichlari | Frontend | 5 | Maktab admini ko'rgan panel idora adminiidan farq qiladi |
| 12 | **Kutubxona holat boshqaruvi** | ACTIVE/FROZEN/DELETED. Muzlatish: sabab majburiy. O'chirish: 2 bosqichli tasdiq, backup | Backend + Frontend | 8 | Muzlatish: sabab so'raladi → bildirishnoma → holat o'zgaradi. O'chirish: "ROZIMAN" yoziladi |
| 13 | **Fond inventarizatsiya hisoboti** | Tizim vs jismoniy fond taqqoslash. 5%+ farqda alert. Oylik avtomatik hisobot | Backend | 5 | Kutubxona 100 kitob deydi, tizimda 94 ta = ogohlantirish |

**✅ Sprint 3 natijasi:** Birinchi kutubxona platformaga ulangan. Fond yuklanган. Kutubxonachi QR skan qila oladi. Kitob qidiruv joylashuvga asosida ishlaydi.

---

# SPRINT 4 — Kitob Jarayonlari: Bron, Berish, Qaytarish

**Muddat:** 7-8 hafta (14 kun)  
**Jamoa:** Backend + Frontend  
**Maqsad:** ⭐ **MVP** — Kitobxon kitob bron qiladi, oladi, qaytaradi. Roaming ishlaydi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **Kitob bron qilish** | POST `/bookings`, PENDING→RESERVED, 24 soat muhlat, bildirishnoma, bron bekor qilish | Backend | 8 | Kitobxon bron qilsa kutubxonachi bildirishnoma oladi, 24 soat o'tsa avtomatik bekor |
| 2 | **Kitob berish (QR)** | Kutubxonachi QR skan → foydalanuvchi ma'lumoti → kitob tanlash → BORROWED. Limit tekshiruv | Backend + Frontend | 8 | QR skan → 3 ta tap → kitob berildi. Limit oshsa xato ko'rsatiladi |
| 3 | **Kitob qaytarish** | RETURNED holat, muddatni tekshirish, intizom balli hisoblash, fond yangilash | Backend | 5 | Kitob qaytarilsa status o'zgaradi, intizom balli yangilanadi |
| 4 | **Kutubxona Roaming** | Boshqa viloyat kutubxonasida kitob berish, inter-library return, bildirishnomalar, transfer log | Backend | 13 | Navoiylik Toshkentda kitob ola oladi, Navoiyda qaytara oladi |
| 5 | **Kitob limiti qoidalari** | Tip bo'yicha limit (fuqaro:2, o'quvchi:3, talaba:5), Trust Score bonus (+1), muddati o'tganda blok | Backend | 5 | Talaba 5 ta kitob ola oladi, 6-chida xato. Muddati o'tganda yangi kitob berilmaydi |
| 6 | **Muddati o'tgan kitoblar** | Qaytarish muddatidan 3, 1 kun oldin SMS+push. O'tganda blok + jarima hisoblash | Backend | 8 | 1 kun oldin SMS keladi. O'tgandan keyin yangi kitob olish bloklangan |
| 7 | **ISBN scan (sotib olingan)** | Kitobxon ISBN skan → bazada tekshiruv → Comprehension test → Reading Index | Backend + Frontend | 8 | ISBN skan → 3 savol → to'g'ri javob → ball qo'shildi. Noto'g'ri → qo'shilmadi |
| 8 | **Kitob do'koni manual kabinet** | Do'kon operatori `telefon + ISBN` kiritadi → kitobxon tasdiqlaydi → Reading Index | Backend + Frontend | 8 | Do'kon operatori kiritadi → kitobxon 24 soat ichida tasdiqlaydi |
| 9 | **Comprehension test tizimi** | Kitob haqida random savollar (AI yordamida), 3 urinish, muvaffaqiyatsizda ball qo'shilmaydi | Backend | 8 | Har 5-kitobda 1 ta test. 3 marta muvaffaqiyatsiz = kitob hisoblanmaydi |
| 10 | **Kitobxon faoliyat tarixi** | O'qilgan kitoblar ro'yhati, muddatlar, qaytarish tarixi, ISBN scan tarixi, olib bo'linmagan bronlar | Frontend | 5 | Profilda barcha o'qilgan kitoblar, statuslar ko'rinadi |
| 11 | **Push bildirishnomalar** | Firebase FCM, bron tasdiq/rad, muddati eslatma, Top-100 xabar, klub xabarlari | Backend | 8 | Mobil va veb browserda push bildirishnoma ishlaydi |
| 12 | **MVP smoke test va bug fix** | Asosiy flow: ro'yhat→kutubxona top→bron→QR olish→qaytarish to'liq sinov. Bug fix | QA | 8 | 10 ta haqiqiy foydalanuvchi 5 ta kutubxonada muvaffaqiyatli ishlaydi |

**✅ Sprint 4 natijasi:** ⭐ **MVP tayyor!** Kitobxon: ro'yhat → kutubxona top → bron → QR bilan olish → qaytarish. Roaming ishlaydi. Birinchi DEMO Yoshlar ishlari agentligiga ko'rsatiladi.

---

# SPRINT 5 — Reading Index, Top-100 va Ochiq Reytinglar

**Muddat:** 9-10 hafta (14 kun)  
**Jamoa:** Backend + Frontend + Data Engineer  
**Maqsad:** Reading Index ishlaydi, Top-100 tizimi ishga tushadi, ochiq reytinglar (`sifat.uz/top`) hammaga ko'rinadi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **Reading Index engine** | Formula hisoblash (5 komponent), scheduled job (har kecha 00:00), tarixni saqlash, delta tracking | Backend | 13 | Har kecha barcha foydalanuvchilar RI qayta hisoblanadi, tarix ko'rinadi |
| 2 | **Mutolaa API integratsiya** | Mutolaa API bog'lanish, o'qilgan sahifalar sinxronlash, koeffitsient (0.85x), duplicate prevention | Backend | 8 | Mutolaa da o'qilsa platformada ko'rinadi, duplicate qo'shilmaydi |
| 3 | **Top-100 Final Score** | Formula hisoblash, manba weighting, oylik scheduled job, versiyalangan natijalar | Backend | 8 | Oylik Top-100 formulaga asosida to'g'ri hisoblanadi, o'tgan oylar ko'rinadi |
| 4 | **Ochiq reyting sahifasi** | Top-100 (umumiy, erkak, ayol, o'quvchi, talaba), oilalar, mahallalar, maktablar, idoralar. Filter, pagination | Frontend | 13 | `sifat.uz/top` da barcha reytinglar ko'rinadi, filter + pagination ishlaydi |
| 5 | **Donat moduli** | Payme + Click integratsiya, donat maqsadi tanlash, donatchilar ochiq ro'yhati, shaffof sarflash | Backend + Frontend | 8 | Donat qilish ishlaydi, `sifat.uz/donate` da donatchilar ko'rinadi |
| 6 | **Gamification: badge tizimi** | 15+ badge: "Birinchi 10 kitob", "Top-100 da", "Faol oy", "30 kun streak" va boshqalar | Backend + Frontend | 5 | Kitobxon profilda badge ko'radi, yangi badge kelganda bildirishnoma |
| 7 | **Real vaqt reyting** | WebSocket orqali Top-100 o'zgarishi jonli yangilanishi | Backend | 5 | Top-100 sahifasida yangi o'rin o'zgarsa sahifa refresh kerak emas |
| 8 | **Gender va yosh filtrlari** | Top-100 erkaklar/ayollar, 7-14, 15-30, 31-60, 60+ yosh guruhlari bo'yicha alohida reyting | Backend + Frontend | 5 | Har yosh guruhi uchun alohida Top-100 ishlaydi |
| 9 | **Donat taqsimoti monitoring** | Admin panelda: jami yig'ilgan, sarflangan, qolgan, kimga sarflangan (shaffof, ommaviy) | Frontend | 5 | Har donat qayerga ketgani ommaviy ko'rinadi (kutubxona/mahalla nomi) |
| 10 | **Top-100 tasdiqlash jarayoni** | 28-kuni ranking, 29-kuni AI fraud, 30-kuni admin tasdiq, 1-kuni e'lon. Workflow tizimi | Backend | 5 | Har oyda avtomatik jarayon ishlaydi, admin faqat tasdiqlash tugmasini bosadi |
| 11 | **Reyting sahifasi SEO** | Server-side render, meta teglar, OpenGraph, Twitter Card — ijtimoiy tarmoqda chiroyli ko'rinish | Frontend | 5 | Facebook/Telegram da ulashganda Top-100 kartasi chiroyli ko'rinadi |

**✅ Sprint 5 natijasi:** Reading Index barcha foydalanuvchilar uchun hisoblanmoqda. `sifat.uz/top` da ochiq reytinglar ko'rinadi. Donat tizimi ishlaydi. Gamification boshlanди. Platforma viral bo'lish imkoniyatiga ega.

---

# SPRINT 6 — Statistika Panellari va Landing Page

**Muddat:** 11-12 hafta (14 kun)  
**Jamoa:** Frontend + Backend + UX  
**Maqsad:** Admin panellar statistika bilan to'ldiriladi. Landing Page tayyor bo'ladi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **4 darajali statistika paneli** | Mahalla/Tuman/Viloyat/Respublika: RI trend, faol kitobxonlar, janr tahlili, yosh, gender. Real vaqt | Backend + Frontend | 13 | Tuman admin o'z tumani statistikasini real vaqtda ko'radi |
| 2 | **Interaktiv xarita (Leaflet.js)** | O'zbekiston xaritasida RI ranglarda: yashil→sariq→qizil. Tuman bosish = batafsil panel | Frontend | 8 | Xarita ranglar bilan ko'rinadi, tuman bosilsa statistika paneli ochiladi |
| 3 | **Kitob yetishmovchiligi tahlili** | Eng ko'p so'ralgan lekin mavjud bo'lmagan kitoblar, tuman/viloyat filtrlash, buyurtma taklifi | Backend + Frontend | 5 | Admin qaysi kitob yo'qligini ko'radi, "Buyurtma berish" tugmasi ishlaydi |
| 4 | **Smart Alert backend** | Trigger qoidalari: RI -10%, 50+ so'rov fond yo'q, 2 hafta 0 faol. Email + SMS + push | Backend | 8 | Karmana tumani pasaysa tuman admin emailga alert keladi |
| 5 | **Janr va mavzu tahlili** | Eng ko'p va kam o'qilgan janrlar, mavsumiy trend grafigi, tarixiy taqqoslash | Backend + Frontend | 5 | Janr bo'yicha pie chart va 12 oylik trend grafigi ko'rinadi |
| 6 | **Landing Page — HERO + qidiruv** | Asosiy sahifa: sarlavha, joylashuvga asoslangan kitob qidiruv bloki, statistika animatsiya | Frontend | 8 | `sifat.uz` da birinchi ko'rinadigan narsa: qidiruv maydoni va real statistika |
| 7 | **Landing Page — Reyting bloki** | Real vaqt: bugun o'qilgan kitoblar, faol kutubxonalar, top mintaqa, yangi rekordlar tasmasi | Frontend | 5 | Landing pageda jonli raqamlar ko'rinadi, har 30 soniyada yangilanadi |
| 8 | **Landing Page — B2B blok** | Maktab/OTM/Idora uchun qiymat taklifi, PQ-9 argumentlari, demo so'rash formi | Frontend | 5 | "Demo so'rash" tugmasi bosilsa forma ochiladi, yuborilsa admin emailga tushadi |
| 9 | **Landing Page — Hamkor do'konlar** | Do'konlar logo carousel, "Hamkor bo'lish" tugmasi, hamkorlik shartlari | Frontend | 3 | Do'konlar logolari ko'rinadi, hamkorlik arizasi yuborish mumkin |
| 10 | **Demo so'rov CRM tizimi** | B2B lead: tashkilot, telefon, tur → admin emailga → Google Sheets / oddiy CRM | Backend + Frontend | 5 | Maktab direktori demo so'rasa admin bildirishnoma oladi, ro'yhatga tushadi |
| 11 | **Oylik PDF hisobot** | Tuman/viloyat/respublika uchun PDF generatsiya (puppeteer), emailga yuborish | Backend | 5 | Har oy 1-da adminlar emailida professional PDF hisobot |
| 12 | **Performance optimizatsiya** | Lighthouse 90+, LCP < 2.5s, Bundle < 200KB, lazy loading, image optimization, CDN | Frontend | 8 | Lighthouse audit: Performance 90+, Accessibility 90+, SEO 95+ |

**✅ Sprint 6 natijasi:** 4 darajali statistika paneli ishlaydi. Interaktiv xarita ko'rinadi. Smart Alert ogohlantirishlar yubormoqda. `sifat.uz` professional ko'rinishda tayyor.

---

# SPRINT 7 — Maktab Moduli, Jadidlar Izidan va Oila

**Muddat:** 13-14 hafta (14 kun)  
**Jamoa:** Backend + Frontend  
**Maqsad:** ⭐ **BETA** — PQ-9 ning maktablarga oid barcha talablari ishlaydi. Oila reytingi ishga tushadi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **Maktab admin moduli** | Sinf bo'yicha o'quvchilar ro'yhati, faollik monitoring, o'quvchi tasdiqlash, limitlar | Backend + Frontend | 8 | Maktab admin barcha o'quvchilarni sinf bo'yicha ko'radi, faollik filtri ishlaydi |
| 2 | **Maktab statistika paneli** | O'quvchi qamrovi %, sinf bo'yicha RI, 10 kitob maqsadi progress bar, Reading Index taqsimoti | Frontend | 8 | "450 o'quvchidan 234 si (52%) faol" ko'rinadi, progress grafigi ishlaydi |
| 3 | **Jadidlar izidan klub yaratish** | Klub CRUD: nom, mas'ul o'qituvchi, sinflar, maqsadlar, faollik darajasi | Backend + Frontend | 8 | Maktab admin klub yaratadi, o'qituvchi klub rahbari bo'ladi |
| 4 | **Klub a'zolik tizimi** | O'qituvchi qo'shadi / o'quvchi ariza → o'qituvchi tasdiqlaydi. 18 yoshgacha ota-ona SMS rozilik | Backend | 8 | Ota-ona SMS dan "HA" yozsa o'quvchi klubga qo'shiladi |
| 5 | **Klub monitoring paneli** | A'zolar o'qilgan kitoblari, debatlar, faollik reytingi, choraklik eng faol a'zo | Frontend | 5 | Klub rahbari a'zolar faolligini ko'radi, 20 kitob maqsadi progressi |
| 6 | **Debat qayd etish** | Debat yaratish: sana, mavzu, ishtirokchilar, video/foto ilova (majburiy), natijalar | Backend + Frontend | 5 | Debat kiritiladi, foto/video yuklanadi, tuman admin ko'rishi mumkin |
| 7 | **20 kitob maqsadi monitoring** | Har a'zo uchun progress, choraklik hisobot, orqada qolganlar uchun alert | Backend + Frontend | 5 | A'zo 15 ta o'qisa: "20 tadan 15 ta — 75%" ko'rinadi |
| 8 | **Oila yaratish va boshqarish** | Xonadon asosida aniqlash, taklif tizimi (tizim + qo'lda), o'rtacha RI hisoblash | Backend + Frontend | 13 | Bir xonadondan 2 kishi ro'yhat = oila taklifi. Tasdiqlash ishlaydi |
| 9 | **Oila reytingi** | Top oilalar ro'yhati (ommaviy), oila profili, a'zolar faolligi, oylik dinamika | Frontend | 5 | `sifat.uz/top` da Top-50 oilalar ko'rinadi, oila profili sahifasi ochiladi |
| 10 | **Oila himoya qoidalari** | 30 kun kutish, bitta oilada bo'lish, manzil o'zgarishida admin tasdiq | Backend | 5 | Oilaga qo'shilgandan 30 kun o'tmasdan reyting hisoblanmaydi |
| 11 | **Maktab reytingi** | O'quvchi qamrovi + klub faolligi + RI o'rtachasi formulasi, respublika bo'yicha Top-100 | Backend | 5 | `sifat.uz/top/maktablar` da respublika bo'yicha Top-100 maktab ko'rinadi |
| 12 | **BETA test va bug fix** | 10 ta maktab, 50 ta foydalanuvchi bilan BETA test. Feedback to'plash va ustuvor bug'larni tuzatish | QA + PM | 8 | 50 ta haqiqiy foydalanuvchi BETA ni sinab, 3/5 yulduz va undan yuqori baho beradi |
| 13 | **Maktab PQ-9 hisoboti** | Jadidlar izidan holati, o'quvchilar RI, klub debatlar — bir tugma PDF | Backend | 5 | Maktab admin 1 tugma bosib to'liq PQ-9 hisoboti PDF oladi |

**✅ Sprint 7 natijasi:** ⭐ **BETA tayyor!** Maktab moduli to'liq. Jadidlar izidan klublari monitoring qilinmoqda. Oila reytingi ishlamoqda. 50+ haqiqiy foydalanuvchi testdan o'tdi.

---

# SPRINT 8 — AI Tizimi va Fraud Detection

**Muddat:** 15-16 hafta (14 kun)  
**Jamoa:** AI Engineer + Backend + Data Engineer  
**Maqsad:** Platformaning eng murakkab qismi — AI tizimi ishga tushadi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **Apache Kafka sozlash** | Barcha harakatlar (bron, berish, qaytarish, o'qish, ro'yhat) Kafka topic larga. Consumer groups | DevOps + Backend | 13 | Har bir foydalanuvchi harakati 100ms da Kafka da ko'rinadi |
| 2 | **AI Fraud Detection modeli** | Random Forest / XGBoost: bir kunda ko'p kitob, bir IP ko'p akkaunt, tez o'qish, test muvaffaqiyatsiz | AI Engineer | 13 | 95%+ aniqlik. Precision 93%+, Recall 96%+. F1 score > 0.94 |
| 3 | **Fraud Risk Score tizimi** | 0-24 (xavfsiz), 25-49 (past), 50-69 (tekshiruv), 70-100 (blok). Real vaqt yangilanish | Backend + AI | 8 | Shubhali harakat = darhol Risk Score oshadi, 70+ da avtomatik blok |
| 4 | **Real Vaqt Audit Engine** | Kafka event → Python FastAPI → tahlil → muammo aniqlash → alert → dashboard | AI Engineer + Backend | 13 | Tuman RI 10% pasaysa 5 daqiqa ichida admin alert oladi |
| 5 | **NL Interface backend (RAG)** | Pinecone/Weaviate vector DB, GPT-4 API, o'zbek tili prompt engineering, context window boshqaruvi | AI Engineer | 13 | "Navoiyda bu oy qanday?" so'roviga 3 soniyada aniq javob + grafik |
| 6 | **NL Interface UI** | Admin panelda chat interfeysi: savol yozish, javob + grafik, savol tarixi, "noto'g'ri" tugmasi | Frontend | 8 | Admin chat oynasida savol-javob ishlaydi, grafik va jadval ko'rinadi |
| 7 | **Predictive Analytics modeli** | ARIMA/Prophet modeli, 1 oylik RI bashorati, confidence interval, model validation | AI Engineer | 8 | Bashorat grafigi ko'rsatadi, ±5% aniqlik maqsadiga erishilgan |
| 8 | **Root Cause Analysis** | Muammo aniqlananda sabablarni tekshirish: ta'mir, xodim, fond, mavsumiy, qo'shni tuman | AI Engineer | 8 | "Nima uchun pasaydi?" ga 3 asosiy sabab + dalil bilan javob |
| 9 | **AI kitob tavsiya tizimi** | Collaborative + Content-based filtering: yosh, janr, o'qish tarixi, hudud asosida | AI Engineer | 5 | Kitobxon profilida "5 ta tavsiya kitob" ko'rinadi, relevantlik 80%+ |
| 10 | **Avtomatik hisobot AI** | Haftalik/oylik hisobotlar AI yozadi: raqamlar + tahlil + tavsiyalar. PDF format | AI Engineer + Backend | 8 | Oylik hisobotda faqat raqamlar emas, AI tahlili ham bor |
| 11 | **AI model monitoring** | Model drift detection, aniqlikni kuzatish, oyda 1 marta qayta o'qitish trigger | AI Engineer | 5 | Fraud model 93% dan pastga tushsa avtomatik qayta o'qitish boshlanadi |
| 12 | **Top-100 AI tekshiruvi** | Oyning 29-kuni barcha Top-100 da'vogarlarini fraud score bo'yicha avtomatik tekshirish | AI Engineer + Backend | 5 | Fraud score 50+ = avtomatik flaglanadi, admin ko'radi |

**✅ Sprint 8 natijasi:** AI tizimi to'liq: Fraud Detection 95%+, Real Vaqt Audit, NL Interface o'zbek tilida, Predictive Analytics, Avtomatik hisobotlar. Platforma aqlli tizimga aylandi.

---

# SPRINT 9 — Idora Moduli, Subscription va Buxgalter

**Muddat:** 17-18 hafta (14 kun)  
**Jamoa:** Backend + Frontend  
**Maqsad:** PQ-9 ning idora talablari ishlaydi. To'lov tizimi ishga tushadi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **Idora admin moduli** | Xodimlar ro'yhati, HR admin tasdiqlash, bo'lim tuzilmasi, lavozimlar, xodim profili | Backend + Frontend | 8 | Idora HR admin xodimlarni qo'shadi, bo'lim bo'yicha filtrlash ishlaydi |
| 2 | **Idora ichki reyting** | Xodimlar RI asosida oylik reyting, bo'lim bo'yicha filtrlash, dinamika grafigi, mukofot taklifi | Backend + Frontend | 8 | Idora admini bo'lim bo'yicha kimning ko'p o'qiyotganini ko'radi |
| 3 | **Kitob o'qish soati moduli** | Tadbir yaratish: sana, joy, QR attendance, ishtirokchilar soni, foto/video, oylik monitoring | Backend + Frontend | 5 | Tadbir yaratiladi, xodimlar QR bilan belgilanadi, oylik hisobot tayyor |
| 4 | **Kitob burchagi moduli** | Fizik kitob burchagi tasdiq: foto yuklash, joylashuv, monitoring, eslatma (har 90 kunda yangilash) | Backend + Frontend | 3 | Admin foto yuklaydi, tizim tasdiqlaydi, monitoring ko'rinadi |
| 5 | **Idora PQ-9 hisoboti** | Kitob burchagi, o'qish soati, kasb ro'yhati, eng faol xodim — bir PDF. Avtomatik choraklik | Backend | 5 | Idora rahbari 1 tugma → PQ-9 barcha talablari bajarilgan PDF oladi |
| 6 | **Kasb adabiyotlar ro'yhati** | Idora bo'yicha tavsiya etiladigan kitoblar, bo'lim admini yuklaydi, xodimlarga ko'rinadi | Backend + Frontend | 3 | Idora admini soha bo'yicha kitoblar ro'yhatini yuklaydi |
| 7 | **Payme integratsiyasi** | Merchant API, to'lov webhook, avtomatik ACTIVE faollashtirish, chek emailga | Backend | 8 | Payme orqali to'lov → 30 soniyada subscription ACTIVE bo'ladi |
| 8 | **Click integratsiyasi** | Click API, webhook, avtomatik faollashtirish, chek emailga yuborish | Backend | 5 | Click orqali to'lov ishlaydi, chek emailga keladi |
| 9 | **Hisob-faktura generatsiya** | PDF faktura: tashkilot ma'lumotlari, xizmat, muddat, bank rekvizitlari, QR to'lov kodi | Backend | 5 | Subscription boshlananda PDF faktura emailga keladi |
| 10 | **Buxgalter paneli** | Alohida rol: barcha to'lovlar, fakturalar, oylik/yillik tushum, Export Excel/PDF/1C | Backend + Frontend | 8 | Buxgalter barcha to'lovlarni ko'radi, 1C ga eksport qiladi |
| 11 | **To'lov eslatma tizimi** | 30, 15, 7, 1 kun oldin email + SMS. PENDING holat. Muddati o'tganda admin bildirishnoma | Backend | 5 | To'lov muddatiga 30 kun qolganda birinchi eslatma ketadi |

**✅ Sprint 9 natijasi:** Idora moduli to'liq: xodimlar reytingi, kitob o'qish soati, kitob burchagi, PQ-9 hisoboti. Payme/Click ishlaydi. Buxgalter paneli tayyor.

---

# SPRINT 10 — Integratsiyalar va V1.0 Release

**Muddat:** 19-20 hafta (14 kun)  
**Jamoa:** Barcha jamoa  
**Maqsad:** ⭐ **V1.0** — Barcha integratsiyalar tugallanadi. Production ga deploy qilinadi.

| # | Task nomi | Tavsif | Mas'ul | SP | Qabul qilish mezoni |
|---|---|---|---|---|---|
| 1 | **Do'kon to'liq API integratsiya** | HMAC imzo, webhook handler, order_id unikal tekshiruv, do'kon statistika dashboard | Backend | 8 | Do'kon kassasi → API → 30 soniyada kitobxon hisobida ko'rinadi |
| 2 | **OTM moduli** | Talaba tasdiqlash, fakultet statistika, ilmiy adabiyotlar bo'limi, akkreditatsiya hisoboti PDF | Backend + Frontend | 8 | OTM admin fakultet bo'yicha talabalar faolligini ko'radi, akkreditatsiya PDF oladi |
| 3 | **Qoraqalpoq va Rus tili** | i18n barcha UI matnlar tarjima, DB da ko'p tilli kitob ma'lumotlari, til saqlash | Frontend | 8 | Til almashtirish tugmasi bosilsa interfeys to'liq o'zgaradi |
| 4 | **ID.UZ integratsiya** | PKCE OAuth2.0, PINFL asosida foydalanuvchi aniqlash, avtomatik davlat xizmatchisi tasdiq | Backend | 8 | Davlat xizmatchisi ID.UZ bilan kirsa avtomatik tasdiqlanadi |
| 5 | **Security penetration testing** | OWASP Top 10 tekshiruvi, SQL injection, XSS, CSRF, rate limiting, auth bypass urinishlari | Security | 8 | Pentest hisoboti: kritik (P1) zaiflik topilmadi. O'rta (P2) zaifliklar tuzatilgan |
| 6 | **Load testing (k6)** | 50,000 bir vaqtda foydalanuvchi simulatsiya, API javob vaqti tekshiruvi, bottleneck aniqlash | DevOps | 5 | 50K foydalanuvchi: API 95-percentil < 200ms, uptime 100%, xato < 0.1% |
| 7 | **PWA offline to'liq** | Service Worker to'liq, IndexedDB sinxronlash, 12 soat offline ishlash, 2G optimizatsiya | Frontend | 8 | Internet o'chsa 12 soat asosiy funksiyalar ishlaydi, sync ko'rsatkichi |
| 8 | **SEO to'liq** | Har sahifa meta teglar, OpenGraph, Twitter Card, sitemap.xml, robots.txt, canonical URL | Frontend | 3 | Google Search Console: barcha muhim sahifalar indexed |
| 9 | **Accessibility (WCAG 2.1)** | Keyboard navigation to'liq, screen reader, rang kontrast (4.5:1), font o'lcham, ARIA | Frontend | 3 | Accessibility audit: 90+ ball. Keyboard bilan to'liq boshqarish mumkin |
| 10 | **Production deploy** | `sifat.uz` ga to'liq deploy, Grafana production dashboard, Sentry production alerts, uptime monitor | DevOps | 8 | `sifat.uz` ishlamoqda, 99.9% uptime monitoring ishlaydi |
| 11 | **V1.0 release hujjatlar** | Changelog, Swagger API docs to'liq, foydalanuvchi qo'llanmasi (PDF + video), admin qo'llanmasi | PM + Tech Lead | 5 | Swagger `/api/docs` to'liq, foydalanuvchi video qo'llanmasi YouTube da |

**✅ Sprint 10 natijasi:** ⭐ **V1.0 rasmiy release!** `sifat.uz` production da ishlamoqda. 50K foydalanuvchi yuklamaga bardoshli. Pentest: kritik zaiflik yo'q. Ko'p tilli. Barcha PQ-9 talablari qoplangan.

---

# YAKUNIY XULOSA

## Sprint natijalari jadvali

| Sprint | Muddat | Asosiy natija | Tasklar | SP |
|---|---|---|---|---|
| Sprint 1 | 1-2 hafta | Dev muhit, CI/CD, DB schema — barcha dasturchilar tayyor | 12 | 89 |
| Sprint 2 | 3-4 hafta | Ro'yhat, Login, Unikal ID, QR — birinchi real foydalanuvchi | 11 | 84 |
| Sprint 3 | 5-6 hafta | Kutubxona ulangan, fond yuklangan, kutubxonachi ishlaydi | 13 | 97 |
| Sprint 4 | 7-8 hafta | ⭐ **MVP:** Bron→Olish→Qaytarish→Roaming — **BIRINCHI DEMO** | 12 | 91 |
| Sprint 5 | 9-10 hafta | Reading Index, Top-100, Ochiq reytinglar, Donat — Viral imkoniyat | 11 | 86 |
| Sprint 6 | 11-12 hafta | Statistika, xarita, Smart Alert, Landing Page — Professional ko'rinish | 12 | 88 |
| Sprint 7 | 13-14 hafta | ⭐ **BETA:** Maktab, Jadidlar izidan, Oila — 50+ haqiqiy test | 13 | 95 |
| Sprint 8 | 15-16 hafta | AI Audit, NL Interface, Fraud 95%+, Predictive — Aqlli platforma | 12 | 102 |
| Sprint 9 | 17-18 hafta | Idora moduli, Payme/Click, Buxgalter — To'lov tizimi ishlamoqda | 11 | 87 |
| Sprint 10 | 19-20 hafta | ⭐ **V1.0:** Do'kon API, OTM, Pentest, Load test — **Production release** | 11 | 83 |
| **JAMI** | **20 hafta** | | **118 task** | **902 SP** |

## Asosiy milestone'lar

| Milestone | Sprint | Hafta | Tavsif |
|---|---|---|---|
| ⭐ MVP | Sprint 4 oxiri | 8-hafta | Bron→Olish→Qaytarish ishlaydi. Birinchi DEMO ko'rsatiladi |
| ⭐ BETA | Sprint 7 oxiri | 14-hafta | Maktab, Jadidlar izidan, Oila. 50+ haqiqiy foydalanuvchi testi |
| ⭐ V1.0 | Sprint 10 oxiri | 20-hafta | Production release. Barcha PQ-9 talablari qoplangan |

## Tavsiya etilgan jamoa

| Rol | Soni | Asosiy sprint |
|---|---|---|
| Backend developer | 2-3 kishi | Sprint 1-10 |
| Frontend developer | 2-3 kishi | Sprint 1-10 |
| AI/ML engineer | 1 kishi | Sprint 8 (asosiy), Sprint 5-10 |
| DevOps engineer | 1 kishi | Sprint 1 (asosiy), Sprint 1-10 |
| QA engineer | 1 kishi | Sprint 4, 7, 10 (asosiy) |
| Product Manager | 1 kishi | Sprint 1-10 |
| DBA | 1 kishi (part-time) | Sprint 1-3 |
| **JAMI** | **8-12 kishi** | |

## Muvaffaqiyat mezoni

> **V1.0 release** quyidagi shartlar bajarilganda muvaffaqiyatli hisoblanadi:
> - `sifat.uz` production da 99.9% uptime bilan ishlamoqda
> - 50,000 bir vaqtda foydalanuvchi yuklamaga bardoshli
> - Pentest: kritik (P1) zaiflik yo'q
> - PQ-9 ning barcha 8 ta talabi platformada qoplangan
> - 100+ kutubxona, 10,000+ faol foydalanuvchi
> - AI Fraud Detection: 95%+ aniqlik
> - Lighthouse: Performance 90+, Accessibility 90+

---

*SIFAT LIBRARY TZ v6.0 + Sprint Rejasi | 2026 | 10 Sprint | 20 hafta | 118 task | 902 Story Point*  
*O'zbekiston Respublikasi Yoshlar ishlari agentligi uchun tayyorlangan*
