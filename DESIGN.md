# SIFAT LIBRARY — Dizayn Tizimi (DESIGN.md)

> Ushbu hujjat frontend'dagi barcha UI qarorlarining yagona manbai.
> Tamoyil: **Apple-uslubidagi minimalizm** — kam bezak, ko'p bo'shliq,
> aniq ierarxiya. Har bir yangi komponent shu hujjatga mos bo'lishi shart.

---

## 1. Asosiy tamoyillar

1. **Mazmun birinchi** — UI o'zini ko'rsatmaydi, ma'lumotni ko'rsatadi.
   Dekorativ gradientlar, soyalar va ramkalar minimal.
2. **Bo'shliq — dizayn elementi.** Zichlashtirish o'rniga 4/8px gridda
   nafas beriladi.
3. **Bitta aksent rang** (ko'k). Semantik ranglar (yashil/sariq/qizil)
   faqat holat bildirish uchun, hech qachon bezak uchun emas.
4. **Har bir holat ko'rinadi**: loading → skeleton, bo'sh → empty-state,
   xato → error-state + qayta urinish. Sahifa hech qachon "oq" qolmaydi.
5. **Harakat ma'noli**: animatsiya faqat holat o'zgarishini tushuntirsa
   ishlatiladi (150–300ms), e'tibor tortish uchun emas.

## 2. Ranglar

CSS o'zgaruvchilar `app/globals.css` da (`:root` / `.dark`). Komponentlarda
Tailwind utility'lari ishlatiladi; dark-rejim `globals.css` retrofiti orqali
avtomatik moslashadi — komponentlarda `dark:` prefiksi YOZILMAYDI.

| Rol | Utility | Qiymat (light) |
|---|---|---|
| Aksent / primary | `blue-600` (hover: `blue-700`) | #2563eb |
| Matn asosiy | `gray-900` | #111827 |
| Matn ikkilamchi | `gray-500` | #6b7280 |
| Matn xira / meta | `gray-400` | #9ca3af |
| Fon sahifa | `gray-50` | #f9fafb |
| Fon karta | `white` | #ffffff |
| Chegara | `gray-200` | #e5e7eb |
| Muvaffaqiyat | `green-600` / fon `green-50` | #16a34a |
| Ogohlantirish | `amber-600` / fon `amber-50` | #d97706 |
| Xato / destruktiv | `red-600` / fon `red-50` | #dc2626 |

Qoida: pastel fonlar (`*-50`) faqat holat bildiruvchi bloklar uchun.

## 3. Tipografika

Sistem shrift steki (Next.js default). Masshtab:

| Daraja | Utility | Ishlatilishi |
|---|---|---|
| Display | `text-3xl font-bold tracking-tight` | Landing hero |
| H1 | `text-2xl font-bold` | Sahifa sarlavhasi (har sahifada bitta) |
| H2 | `text-lg font-semibold` | Bo'lim / karta sarlavhasi |
| Body | `text-sm` | Asosiy matn (dashboard zich UI) |
| Meta | `text-xs text-gray-500` | Yordamchi izoh, sana, birlik |
| Mono | `font-mono text-xs` | ID/kod (sifatId, ISBN, LIB-*) |

## 4. Bo'shliq (4/8px grid)

Barcha padding/margin/gap **4px karrali** (Tailwind 1 = 4px):

- Karta ichki padding: `p-4` (zich jadval) yoki `p-6` (standart)
- Elementlararo vertikal ritm: `space-y-4` (bo'limlar orasida `space-y-6`)
- Sahifa konteyner: `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`
- Grid kartalar: `gap-4` (mobil) / `gap-6` (desktop)

## 5. Radius va soyalar

- Radius: karta/modal `rounded-xl`, tugma/input `rounded-md`, badge `rounded-full`
- Soyalar: karta `shadow-sm`, modal/popup `shadow-lg`. Boshqa soyalar yo'q.

## 6. Interaktiv holatlar (majburiy)

Har bir bosiladigan element quyidagi 4 holatga ega bo'lishi shart:

| Holat | Qoida |
|---|---|
| hover | fon bir daraja to'qlashadi (`hover:bg-*`), `transition-colors` |
| active | `active:scale-[0.98]` (tugma) yoki fon yana bir daraja |
| focus | `focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2` — klaviatura uchun, hech qachon o'chirmang |
| disabled | `disabled:opacity-50 disabled:pointer-events-none` |

Bosiladigan kartalar: `hover:border-gray-300 hover:shadow-md transition-all`.

## 7. Holat komponentlari (components/ui)

| Komponent | Fayl | Qachon |
|---|---|---|
| `Skeleton` | `ui/skeleton.tsx` | Ma'lumot yuklanmoqda — kontent shakli oldindan ko'rinadi |
| `Spinner` | `ui/spinner.tsx` | Qisqa amal (tugma ichida, inline) |
| `EmptyState` | `ui/empty-state.tsx` | Ro'yxat bo'sh — sabab + keyingi qadam (CTA tugma) |
| `ErrorState` | `ui/error-state.tsx` | So'rov yiqildi — inson tilida xabar + "Qayta urinish" |
| `ConfirmModal` | `ui/confirm-modal.tsx` | Har qanday destruktiv/qaytarilmas amal oldidan |
| `useToast` | `ui/toast.tsx` | Har CRUD natijasi: muvaffaqiyat (yashil) / xato (qizil) |

Qoidalar:
- **Skeleton** birinchi yuklanishda; **Spinner** faqat refetch/submit'da.
- **Toast** 4s da o'zi yopiladi, xato toast'i 6s; bir vaqtda maks 3 ta.
- **ConfirmModal**siz o'chirish tugmasi bo'lishi taqiqlanadi.
- Xato matnlari texnik emas: "500 Internal" ❌ → "Server bilan bog'lanib
  bo'lmadi. Birozdan so'ng qayta urinib ko'ring." ✅

## 8. Xato sahifalari

- `app/[locale]/not-found.tsx` — 404, bosh sahifaga qaytish havolasi
- `app/[locale]/error.tsx` — 500/render xatosi, "Qayta urinish" (reset)
- `app/global-error.tsx` — root xato (layout ham yiqilganda)
- 403 — `ForbiddenState` komponenti (dashboard guard'lari ichida)

Barcha xato sahifalari: emoji/belgi + H1 + qisqa tushuntirish + bitta CTA.
Texnik tafsilot faqat `NODE_ENV=development` da ko'rsatiladi.

## 9. Responsive

Breakpointlar: mobil default → `sm:640` → `md:768` → `lg:1024` → `xl:1280`.

- **Skan oqimi (`/scan`) planshet/telefon uchun asosiy**: bosish nishonlari
  min `h-12`, matn `text-base`, bitta ustunli layout, pastki qismda katta CTA.
- Jadvallar mobil ekranda gorizontal scroll konteynerda (`overflow-x-auto`)
  yoki kartaga yig'iladi.
- Sidebar `lg:` dan kichikda yashirinadi (hamburger).

## 10. Harakat (motion)

- Kirish animatsiyalari: `animate-in fade-in` uslubida, ≤200ms
- Muvaffaqiyat tasdig'i (to'lov, topshirish): bir martalik checkmark
  animatsiyasi (`ui/success-check.tsx`), 600ms, keyin statik
- `prefers-reduced-motion` hurmat qilinadi — animatsiya o'chadi

## 11. i18n va matn

- UI matnlari `next-intl` kataloglarida (`messages/*.json`)
- Yangi komponentlar hardcoded matn o'rniga `useTranslations` ishlatishi kerak;
  mavjud sahifalar bosqichma-bosqich ko'chiriladi
- Sanalar `toLocaleDateString(locale)`, raqamlar `Intl.NumberFormat`

## 12. Kirish nazorati (sifat cheklovi)

Har PR/o'zgarishdan oldin:
1. `npx tsc --noEmit` — 0 xato
2. `npx eslint . --quiet` — 0 xato
3. `next build` yashil
4. Brauzer konsolida xato yo'q (asosiy sahifalar ochib tekshiriladi)
