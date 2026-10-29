import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json"
      }
    },
    plugins: {
      "@typescript-eslint": tseslint
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", {
        // `_` prefiksi — "ataylab ishlatilmaydi" konvensiyasi. Ilgari faqat
        // argumentlarga qo'llanardi, o'zgaruvchilarga emas.
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_",
        // `const { hmacSecret, ...safe } = store` — maxfiy maydonni javobdan
        // chiqarib tashlashning standart idiomasi (store.service.ts:269).
        // Bunda chiqarilgan maydon ta'rifi bo'yicha ishlatilmaydi.
        "ignoreRestSiblings": true
      }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error"
    }
  },
  {
    // Testlarda `require()` (jest.mock bilan lazy import) va `Function` tipi
    // (mock imzolarini tavsiflash) me'yoriy — ishlab chiqarish kodida emas.
    files: ["src/**/__tests__/**/*.ts", "src/**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-function-type": "off"
    }
  },
  {
    ignores: ["dist/**", "node_modules/**", "prisma/**"]
  }
];
