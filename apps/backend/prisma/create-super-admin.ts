/**
 * Super Admin yaratish scripti
 * Ishlatish: npx ts-node --transpile-only prisma/create-super-admin.ts
 */
import { PrismaClient, UserGender, UserType, UserStatus, UserRole } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const PHONE    = "+998901111111";
  const PASSWORD = "Admin@2026";
  const SIFAT_ID = "SL-UZ-14-001-0001-00000";

  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  // Address (Toshkent, Chilonzor)
  const toshkent  = await prisma.viloyat.findUnique({ where: { code: "14" } });
  const chilonzor = await prisma.tuman.findUnique({ where: { code: "14-001" } });
  const mahalla   = await prisma.mahalla.findUnique({ where: { code: "14-001-0001" } });

  if (!toshkent || !chilonzor || !mahalla) {
    throw new Error("Geo ma'lumotlari topilmadi. Avval seed ni ishlaturing.");
  }

  const address = await prisma.address.upsert({
    where: { id: "superadmin-address-001" },
    create: {
      id: "superadmin-address-001",
      viloyatId: toshkent.id,
      tumanId:   chilonzor.id,
      mahallaId: mahalla.id,
      street:    "Amir Temur",
      house:     "1",
      apartment: "1"
    },
    update: {}
  });

  const superAdmin = await prisma.user.upsert({
    where: { phone: PHONE },
    create: {
      phone:      PHONE,
      passwordHash,
      name:       "Super Admin",
      dob:        new Date("1990-01-01"),
      gender:     UserGender.MALE,
      type:       UserType.CITIZEN,
      role:       UserRole.SUPER_ADMIN,
      status:     UserStatus.ACTIVE,
      sifatId:    SIFAT_ID,
      trustScore: 100,
      addressId:  address.id
    },
    update: {
      passwordHash,
      role:   UserRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      name:   "Super Admin"
    }
  });

  console.log("╔════════════════════════════════════════════════╗");
  console.log("║         SUPER ADMIN MUVAFFAQIYATLI YARATILDI  ║");
  console.log("╠════════════════════════════════════════════════╣");
  console.log(`║  ID       : ${superAdmin.id}`);
  console.log(`║  Sifat ID : ${superAdmin.sifatId}`);
  console.log(`║  Telefon  : ${superAdmin.phone}`);
  console.log(`║  Rol      : ${superAdmin.role}`);
  console.log(`║  Status   : ${superAdmin.status}`);
  console.log("╠════════════════════════════════════════════════╣");
  console.log("║  KIRISH MA'LUMOTLARI:                          ║");
  console.log(`║  Telefon  : ${PHONE}                ║`);
  console.log("║  OTP      : Telefonga SMS keladi               ║");
  console.log("║  (dev muhitda: log da chiqadi)                 ║");
  console.log("╚════════════════════════════════════════════════╝");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
