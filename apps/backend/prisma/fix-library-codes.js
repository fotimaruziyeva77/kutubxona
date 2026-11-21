/* eslint-disable */
// Eski formatdagi kutubxona kodlarini (LIB-SCH-CMWHHXMB-001) TZ formatiga
// (LIB-SCH-08012-001) o'tkazadi. Bir martalik; qayta ishga tushirish xavfsiz.
//   docker compose run --rm tools node prisma/fix-library-codes.js
// Boshqa jadvallar kutubxonaga id orqali bog'langan — kod o'zgarishi ularga ta'sir qilmaydi.
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const OK = /^LIB-[A-Z]{3}-\d{5}-\d{3,}$/;

async function main() {
  const libs = await prisma.library.findMany({ orderBy: { createdAt: "asc" } });
  let fixed = 0;
  for (const lib of libs) {
    if (OK.test(lib.code)) continue;
    let tuman = null;
    for (const id of [lib.tumanId, lib.regionId]) {
      if (id && !tuman) tuman = await prisma.tuman.findUnique({ where: { id } });
    }
    const geo = !tuman && lib.regionId && lib.regionId.match(/^(?:UZ-)?(\d{2})-(\d{3})$/i);
    const part = tuman ? tuman.code.replace(/\D/g, "") : geo ? geo[1] + geo[2] : null;
    if (!part) {
      console.log(`O'TKAZIB YUBORILDI (tuman topilmadi): ${lib.code} — ${lib.name}`);
      continue;
    }
    const base = `LIB-${lib.type}-${part}-`;
    const taken = await prisma.library.findMany({ where: { code: { startsWith: base } }, select: { code: true } });
    const max = taken.reduce((m, { code }) => Math.max(m, parseInt(code.slice(base.length), 10) || 0), 0);
    const code = `${base}${String(max + 1).padStart(3, "0")}`;
    await prisma.library.update({ where: { id: lib.id }, data: { code } });
    console.log(`${lib.code} → ${code}  (${lib.name})`);
    fixed++;
  }
  console.log(`Tayyor: ${fixed} ta kod yangilandi.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
