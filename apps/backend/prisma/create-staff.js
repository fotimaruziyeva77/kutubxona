/**
 * Kutubxona xodimi (KUTUBXONACHI yoki MUASSASA_ADMIN) yaratish — server uchun.
 * deploy/create-staff.sh shu faylni tools konteynerida ishga tushiradi.
 *
 *   STAFF_ROLE=KUTUBXONACHI STAFF_PHONE=+998901234567 STAFF_NAME="Ism Familiya" \
 *   STAFF_GENDER=FEMALE LIBRARY_CODE=LIB-SCH-07002-001 node prisma/create-staff.js
 *
 * Nima qiladi:
 *  1. Kutubxonani kodi bo'yicha topadi (topilmasa — mavjud kodlar ro'yxatini chiqaradi).
 *  2. Kutubxonaga bog'langan Muassasa (Institution) bo'lmasa — yaratadi. Xodimning
 *     kutubxonasi aynan shu bog'lanish orqali aniqlanadi:
 *       User.schoolId | universityId | organizationId → Institution.libraryId → Library
 *  3. Xodimni yaratadi (telefon band bo'lsa — rolini, parolini va bog'lanishini yangilaydi).
 *  4. STAFF_PASSWORD berilmasa — tasodifiy parol yaratib, BIR MARTA ekranga chiqaradi.
 */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const { randomInt } = require("crypto");

const prisma = new PrismaClient();
const ROLES = ["KUTUBXONACHI", "MUASSASA_ADMIN"];
// Kutubxona tipi → muassasa tipi va xodimning qaysi maydoni orqali bog'lanishi
const BY_TYPE = {
  SCH: { inst: "MAKTAB", field: "schoolId" },
  UNI: { inst: "OTM", field: "universityId" },
  ORG: { inst: "IDORA", field: "organizationId" },
  GOV: { inst: "IDORA", field: "organizationId" },
  MAH: { inst: "MAHALLA", field: "organizationId" },
};

function fail(msg) {
  console.error("XATO: " + msg);
  process.exit(1);
}

// Chalkash belgilarsiz (0/O, 1/l/I) o'qiladigan parol
function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[randomInt(chars.length)];
  return out + randomInt(10); // kamida bitta raqam kafolatlanadi
}

async function main() {
  const role = (process.env.STAFF_ROLE || "KUTUBXONACHI").trim().toUpperCase();
  const rawPhone = (process.env.STAFF_PHONE || "").replace(/[\s\-()]/g, "");
  const phone = rawPhone.startsWith("+") ? rawPhone : "+" + rawPhone;
  const name = (process.env.STAFF_NAME || "").trim();
  const gender = (process.env.STAFF_GENDER || "FEMALE").trim().toUpperCase();
  const code = (process.env.LIBRARY_CODE || "").trim().toUpperCase();
  let password = process.env.STAFF_PASSWORD || "";

  if (!ROLES.includes(role)) fail(`Rol ${ROLES.join(" yoki ")} bo'lishi kerak`);
  if (!/^\+998\d{9}$/.test(phone)) fail("Telefon +998XXXXXXXXX shaklida bo'lishi kerak");
  if (name.length < 3) fail("Ism-familiya kiritilmadi");
  if (!["MALE", "FEMALE"].includes(gender)) fail("Jins MALE yoki FEMALE bo'lishi kerak");
  if (password && password.length < 8) fail("Parol kamida 8 belgi bo'lishi kerak");

  // ── 1. Kutubxona ────────────────────────────────────────────────────────
  const library = code ? await prisma.library.findUnique({ where: { code } }) : null;
  if (!library) {
    const all = await prisma.library.findMany({
      select: { code: true, name: true, status: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    console.error(code ? `XATO: "${code}" kodli kutubxona topilmadi.` : "XATO: kutubxona kodi kiritilmadi.");
    console.error("Mavjud kutubxonalar:");
    for (const l of all) console.error(`  ${l.code}  ${l.name}  [${l.status}]`);
    if (all.length === 0) console.error("  (hali kutubxona yo'q — avval admin panelda kutubxona qo'shing)");
    process.exit(1);
  }
  const map = BY_TYPE[library.type];
  const tumanId = library.tumanId || library.regionId;
  const tuman = await prisma.tuman.findUnique({ where: { id: tumanId } });
  if (!tuman) fail(`Kutubxona tumani topilmadi (${tumanId}) — kutubxonani admin panelda tahrirlab tuman tanlang`);
  const viloyatId = library.viloyatId || tuman.viloyatId;

  // ── 2. Muassasa (Institution) ↔ kutubxona ───────────────────────────────
  let inst = await prisma.institution.findFirst({ where: { libraryId: library.id } });
  if (!inst) {
    inst = await prisma.institution.create({
      data: {
        type: map.inst,
        name: library.name,
        code: `${map.inst}-${library.code}`,
        tumanId: tuman.id,
        viloyatId,
        address: library.address,
        phone: library.phone,
        libraryId: library.id,
      },
    });
    console.log(`Muassasa yaratildi va kutubxonaga bog'landi: ${inst.code}`);
  }

  // ── 3. Xodim ────────────────────────────────────────────────────────────
  const generated = !password;
  if (generated) password = generatePassword();
  const passwordHash = await bcrypt.hash(password, 12);
  const link = { schoolId: null, universityId: null, organizationId: null, [map.field]: inst.id };

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    if (existing.role === "SUPER_ADMIN") fail("Bu raqam super admin'ga tegishli — boshqa raqam kiriting");
    await prisma.user.update({
      where: { id: existing.id },
      data: { role, status: "ACTIVE", passwordHash, ...link },
    });
    console.log(`Mavjud foydalanuvchi yangilandi: ${existing.name} → ${role}`);
  } else {
    // Hududiy rollar uchun manzil + sifatId (admin panel bilan bir xil qoida).
    const mahalla = await prisma.mahalla.findFirst({ where: { tumanId: tuman.id }, orderBy: { code: "asc" } });
    if (!mahalla) fail(`${tuman.name} tumanida mahalla topilmadi`);
    const address = await prisma.address.create({
      data: { viloyatId, tumanId: tuman.id, mahallaId: mahalla.id, street: "-", house: "-", apartment: "-" },
    });
    const m = await prisma.mahalla.update({
      where: { id: mahalla.id },
      data: { lastSeq: { increment: 1 } },
      select: { code: true, lastSeq: true },
    });
    await prisma.user.create({
      data: {
        phone,
        name,
        passwordHash,
        role,
        type: "GOVERNMENT_EMPLOYEE",
        gender,
        dob: new Date("1990-01-01"),
        status: "ACTIVE",
        trustScore: 100,
        sifatId: `SL-UZ-${m.code}-${String(m.lastSeq).padStart(5, "0")}`,
        addressId: address.id,
        ...link,
      },
    });
    console.log(`Xodim yaratildi: ${name} (${role})`);
  }

  console.log("");
  console.log(`  Kutubxona: ${library.name} (${library.code})`);
  console.log(`  Login:     ${phone}`);
  if (generated) {
    console.log(`  Parol:     ${password}`);
    console.log("  Parol faqat hozir ko'rsatildi — xodimga xavfsiz yo'l bilan bering.");
  } else {
    console.log("  Parol:     siz kiritgan parol");
  }
  if (library.status !== "ACTIVE") {
    console.log("");
    console.log(`  DIQQAT: kutubxona holati ${library.status}. Kitobxonlar bron qila olishi uchun`);
    console.log("  admin panelda «Tuman darajasida tasdiqlash» va «Super admin tasdiqi» ni bosing.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
