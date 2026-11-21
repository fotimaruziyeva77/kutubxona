// D1 (XATOLIKLAR-2026-07): .env.prod.example dagi kalitlar backend'ning
// PRODUCTION_REQUIRED_ENV ro'yxatini to'liq qoplashi shart — aks holda hujjat
// bo'yicha to'ldirilgan prod konteyner boot'da yiqiladi. CI'da ishlaydi.
import { readFileSync } from "node:fs";

const util = readFileSync("apps/backend/src/common/utils/production-env.util.ts", "utf8");
const arr = util.slice(util.indexOf("PRODUCTION_REQUIRED_ENV = ["), util.indexOf("];", util.indexOf("PRODUCTION_REQUIRED_ENV = [")));
const required = [...arr.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);

const example = readFileSync(".env.prod.example", "utf8");
const present = new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));

const missing = required.filter((k) => !present.has(k));
if (missing.length > 0) {
  console.error(`.env.prod.example da yetishmayotgan kalitlar (${missing.length}): ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`ok: PRODUCTION_REQUIRED_ENV (${required.length} kalit) .env.prod.example da to'liq`);
