import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_",
        "ignoreRestSiblings": true
      }],
      "@typescript-eslint/no-explicit-any": "warn",

      // O'zbek lotin imlosi apostrofga tayanadi: o'quvchi, g'oya, ma'lumot.
      // Bu qoida har bir shunday so'zni xato deb belgilaydi (328 ta hit) va
      // barchasini &apos; ga aylantirish matnni tarjimonlar uchun o'qib
      // bo'lmas holga keltiradi. JSX matnidagi apostrof to'g'ri render
      // bo'ladi — bu xavfsizlik yoki to'g'rilik muammosi emas, faqat uslub.
      "react/no-unescaped-entities": "off",

      // H18 — NEXT_PUBLIC_API_URL ni qo'lda o'qish taqiqlanadi.
      // Kalit "bo'sh backend origin" ni bildiradi (lib/api/base.ts shartnomasi):
      // REST prefiksi "/api" ni apiBase() qo'shadi. Qo'lda o'qilganda prefiks
      // tushib qolib butun sahifa jimgina 404 ga uriladi — landing statistikasi
      // va QR davomat skani aynan shu sababdan buzilgan edi.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='NEXT_PUBLIC_API_URL']",
          message:
            "NEXT_PUBLIC_API_URL ni to'g'ridan-to'g'ri o'qimang. REST uchun apiBase() (= <origin>/api), " +
            "Socket.IO/health uchun apiOrigin() ishlating — @/lib/api/base.",
        },
      ],
    }
  },
  {
    // base.ts — shartnomaning O'ZI, env kalitini o'qishga haqli yagona joy.
    files: ["lib/api/base.ts"],
    rules: { "no-restricted-syntax": "off" }
  },
  {
    // Testlarda jest.mock bilan lazy `require()` me'yoriy naqsh; mock holatini
    // ushlab turuvchi o'zgaruvchilar esa assertion'da emas, closure ichida
    // ishlatiladi va linter ularni "unused" deb ko'radi.
    files: ["**/__tests__/**", "**/*.spec.*", "**/*.test.*"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off"
    }
  },
  {
    // Node konfig/skript fayllari CommonJS `require()` ishlatadi — bu
    // Next.js ning o'z konfig formati, brauzer bundle'ga kirmaydi.
    files: [
      "next.config.js",
      "postcss.config.js",
      "jest.config.js",
      "jest.setup.js",
      "*.config.mjs",
    ],
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  {
    ignores: [".next/**", "node_modules/**"]
  }
];

export default config;
