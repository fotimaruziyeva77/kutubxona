# SIFAT LIBRARY — brend aktivlari

Logotip va ilova ikonkasi vektor (SVG) ko'rinishida; PNG eksportlar `sharp` bilan
`app-icon.svg` dan yaratilgan. Ranglar veb-ilovaning `globals.css` dagi `brand-*`
tokenlari bilan bir xil (asosiy `#2563EB`).

| Fayl | Nima uchun |
|---|---|
| `logo.svg` | Gorizontal logotip, yorug' fon (belgi + "Sifat Library" + shior) |
| `logo-dark.svg` | Gorizontal logotip, to'q fon |
| `logo-mark.svg` | Faqat belgi (ochiq kitob + uchqun), 64×64 viewBox |
| `app-icon.svg` / `app-icon-1024.png` | App Store (1024×1024, burchaklari Apple tomonidan kesiladi) |
| `app-icon-512.png` | Google Play ro'yxat ikonkasi (512×512) |
| `app-icon-192.png`, `app-icon-180.png`, `app-icon-32.png` | PWA / apple-touch-icon / favicon |
| `app-icon-dark.svg` / `app-icon-dark-1024.png` | Tungi variant (iOS 18 dark icon) |
| `adaptive-foreground.svg` / `adaptive-foreground-432.png` | Android adaptive icon — old qatlam (xavfsiz zona 66%) |
| `adaptive-background-432.png` | Android adaptive icon — orqa qatlam, `#2563EB` |

## Palitra

| Rol | Hex |
|---|---|
| Asosiy | `#2563EB` |
| Asosiy (bosilgan / chip matni) | `#1D4ED8` |
| Matn | `#0F172A` |
| Aksent | `#60A5FA` |
| Yordamchi (chip, aktiv tab foni) | `#E0E7FF` |
| Fon | `#F8FAFC` |
| Chegara | `#E2E8F0` |
| Ikkilamchi matn | `#64748B` |

## Shriftlar

- Sarlavha va so'z belgisi: **Plus Jakarta Sans** 700/800
- Matn: **Inter** 400/500/600

`logo.svg` ichidagi matn `<text>` sifatida turadi — shrift o'rnatilmagan joyda
zaxira shriftga tushadi. Bosma yoki do'kon rasmlari uchun dizayn kanvasidan
PNG eksport qiling yoki matnni konturga (outline) aylantiring.

PNG larni qayta yig'ish (repo ildizidan):

    node <skript> apps/frontend/public/brand <preview-papka>

(skript: sharp bilan `app-icon.svg` → 1024/512/192/180/32, `app-icon-dark.svg` → 1024,
`adaptive-foreground.svg` → 432 va `#2563EB` fon.)
