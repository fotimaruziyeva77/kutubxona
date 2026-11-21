/**
 * Birinchi SUPER_ADMIN akkauntini yaratish / parolini yangilash (server uchun).
 *
 * create-super-admin.ts dan farqi: telefon va parol kodga yozilmagan
 * (repo ochiq), hammasi env orqali keladi. deploy/create-admin.sh shu
 * faylni tools konteynerida ishga tushiradi:
 *
 *   ADMIN_PHONE=+998901234567 ADMIN_NAME="Ism Familiya" ADMIN_DOB=1990-05-01 \
 *   ADMIN_GENDER=MALE ADMIN_PASSWORD=... node prisma/create-admin.js
 *
 * Parol konsolga chiqarilmaydi.
 */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");

function fail(msg) {
  console.error("XATO: " + msg);
  process.exit(1);
}

async function main() {
  const rawPhone = (process.env.ADMIN_PHONE || "").replace(/[\s\-()]/g, "");
  const phone = rawPhone.startsWith("+") ? rawPhone : "+" + rawPhone;
  const name = (process.env.ADMIN_NAME || "").trim();
  const dobRaw = (process.env.ADMIN_DOB || "").trim();
  const gender = (process.env.ADMIN_GENDER || "").trim().toUpperCase();
  const password = process.env.ADMIN_PASSWORD || "";

  if (!/^\+998\d{9}$/.test(phone)) fail("Telefon +998XXXXXXXXX shaklida bo'lishi kerak");
  if (name.length < 3) fail("Ism-familiya kiritilmadi");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobRaw) || isNaN(Date.parse(dobRaw)))
    fail("Tug'ilgan sana YYYY-MM-DD shaklida bo'lishi kerak");
  if (!["MALE", "FEMALE"].includes(gender)) fail("Jins MALE yoki FEMALE bo'lishi kerak");
  if (
    password.length < 12 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/\d/.test(password)
  )
    fail("Parol kamida 12 belgi, katta+kichik harf va raqamdan iborat bo'lishi kerak");

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.upsert({
      where: { phone },
      create: {
        phone,
        passwordHash,
        name,
        dob: new Date(dobRaw),
        gender,
        type: "CITIZEN",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      },
      update: { passwordHash, name, role: "SUPER_ADMIN", status: "ACTIVE" },
      select: { id: true, phone: true, role: true, status: true },
    });
    console.log(`Tayyor: ${user.phone} — ${user.role} (${user.status})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => fail(e.message));
