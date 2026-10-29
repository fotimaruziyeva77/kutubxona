import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  UserRole,
  UserStatus,
  UserGender,
  UserType,
  Prisma,
} from "@prisma/client";
import * as bcrypt from "bcrypt";
import { randomInt } from "crypto";
import { PrismaService } from "../../infra/prisma/prisma.service";

const BCRYPT_ROUNDS = 12;

// SUPER_ADMIN bu rollarni yaratishi/boshqarishi mumkin. SUPER_ADMIN va KITOBXON
// bu yerdan boshqarilmaydi — kitobxonlar oddiy ro'yhatdan o'tadi, super admin
// esa seed/DB orqali tayinlanadi (UI'dan yaratilmaydi — xavfsizlik).
const STAFF_ROLES: UserRole[] = [
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.MUASSASA_ADMIN,
  UserRole.KUTUBXONACHI,
  UserRole.KLUB_RAHBARI,
  UserRole.BUXGALTER,
  UserRole.DOKON_OPERATOR,
];

// Bu rollar hududga bog'langan — manzil (viloyat→tuman→mahalla) majburiy, chunki
// RBAC scoping address.viloyatId/tumanId orqali ishlaydi.
const REGION_REQUIRED: UserRole[] = [
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.MUASSASA_ADMIN,
  UserRole.KUTUBXONACHI,
  UserRole.KLUB_RAHBARI,
];

export interface CreateAccountDto {
  name: string;
  phone: string;
  role: string;
  gender?: string;
  dob?: string;
  password?: string; // bo'sh bo'lsa — vaqtinchalik parol generatsiya qilinadi
  viloyatId?: string;
  tumanId?: string;
  mahallaId?: string;
  organizationId?: string;
  schoolId?: string;
  universityId?: string;
}

@Injectable()
export class AdminAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizePhone(phone: string): string {
    let p = (phone ?? "").replace(/[\s\-()]/g, "");
    if (!p.startsWith("+")) p = "+" + p;
    return p;
  }

  // 10 belgili o'qiladigan vaqtinchalik parol — chalkash belgilar (0/O, 1/l/I)
  // chiqarib tashlangan, super admin uni admin bilan ulashadi.
  private generateTempPassword(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < 10; i++) out += chars[randomInt(chars.length)];
    return out;
  }

  private async generateSifatId(mahallaId: string): Promise<string> {
    const m = await this.prisma.mahalla.update({
      where: { id: mahallaId },
      data: { lastSeq: { increment: 1 } },
      select: { code: true, lastSeq: true },
    });
    return `SL-UZ-${m.code}-${m.lastSeq.toString().padStart(5, "0")}`;
  }

  async createAccount(dto: CreateAccountDto) {
    const role = dto.role as UserRole;
    if (!STAFF_ROLES.includes(role)) {
      throw new BadRequestException("Bu rolni yaratib bo'lmaydi");
    }
    if (!dto.name?.trim()) throw new BadRequestException("Ism majburiy");
    if ((dto.password ?? "").length > 0 && dto.password!.length < 8) {
      throw new BadRequestException(
        "Parol kamida 8 ta belgidan iborat bo'lishi kerak",
      );
    }

    const phone = this.normalizePhone(dto.phone);
    if (!/^\+\d{9,15}$/.test(phone)) {
      throw new BadRequestException("Telefon raqami noto'g'ri");
    }
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      throw new ConflictException(
        "Bu telefon raqami allaqachon ro'yhatdan o'tgan",
      );
    }

    // Hududiy rollar uchun manzil + sifatId.
    let addressId: string | undefined;
    let sifatId: string | null = null;
    if (REGION_REQUIRED.includes(role)) {
      if (!dto.mahallaId) {
        throw new BadRequestException(
          "Hudud (viloyat → tuman → mahalla) tanlanishi shart",
        );
      }
      const mahalla = await this.prisma.mahalla.findUnique({
        where: { id: dto.mahallaId },
        include: { tuman: { select: { id: true, viloyatId: true } } },
      });
      if (!mahalla) throw new NotFoundException("Mahalla topilmadi");
      const address = await this.prisma.address.create({
        data: {
          viloyatId: mahalla.tuman.viloyatId,
          tumanId: mahalla.tumanId,
          mahallaId: mahalla.id,
          street: "-",
          house: "-",
          apartment: "-",
        },
      });
      addressId = address.id;
      sifatId = await this.generateSifatId(mahalla.id);
    }

    const tempPassword =
      (dto.password ?? "").length >= 8 ? dto.password! : this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);

    const type: UserType =
      role === UserRole.DOKON_OPERATOR
        ? UserType.CITIZEN
        : UserType.GOVERNMENT_EMPLOYEE;
    const gender =
      (dto.gender as UserGender) === UserGender.FEMALE
        ? UserGender.FEMALE
        : UserGender.MALE;
    const dob =
      dto.dob && !isNaN(new Date(dto.dob).getTime())
        ? new Date(dto.dob)
        : new Date("1990-01-01");

    const user = await this.prisma.user.create({
      data: {
        name: dto.name.trim(),
        phone,
        passwordHash,
        role,
        type,
        gender,
        dob,
        status: UserStatus.ACTIVE,
        trustScore: 100,
        sifatId,
        addressId,
        organizationId: dto.organizationId || undefined,
        schoolId: dto.schoolId || undefined,
        universityId: dto.universityId || undefined,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        sifatId: true,
        status: true,
      },
    });

    // Parol faqat shu javobda BIR MARTA ko'rsatiladi — super admin uni admin
    // bilan ulashadi, admin keyin o'zi o'zgartiradi (POST /auth/password/change).
    return { ...user, tempPassword };
  }

  async listAccounts(params: {
    role?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const roleFilter =
      params.role && STAFF_ROLES.includes(params.role as UserRole)
        ? [params.role as UserRole]
        : STAFF_ROLES;

    const where: Prisma.UserWhereInput = {
      role: { in: roleFilter },
      status: { not: UserStatus.DELETED },
    };
    if (params.search?.trim()) {
      const q = params.search.trim();
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
      ];
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          phone: true,
          role: true,
          status: true,
          sifatId: true,
          createdAt: true,
          address: { select: { viloyatId: true, tumanId: true } },
        },
      }),
    ]);

    // Viloyat/Tuman nomlarini batch resolve — Address'da geo relation yo'q.
    const vIds = [
      ...new Set(
        users.map((u) => u.address?.viloyatId).filter(Boolean) as string[],
      ),
    ];
    const tIds = [
      ...new Set(
        users.map((u) => u.address?.tumanId).filter(Boolean) as string[],
      ),
    ];
    const [vRows, tRows] = await Promise.all([
      vIds.length
        ? this.prisma.viloyat.findMany({
            where: { id: { in: vIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      tIds.length
        ? this.prisma.tuman.findMany({
            where: { id: { in: tIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const vMap = new Map(vRows.map((v) => [v.id, v.name]));
    const tMap = new Map(tRows.map((t) => [t.id, t.name]));

    return {
      total,
      page,
      limit,
      items: users.map((u) => ({
        id: u.id,
        name: u.name,
        phone: u.phone,
        role: u.role,
        status: u.status,
        sifatId: u.sifatId,
        createdAt: u.createdAt,
        viloyatName: u.address?.viloyatId
          ? vMap.get(u.address.viloyatId) ?? null
          : null,
        tumanName: u.address?.tumanId
          ? tMap.get(u.address.tumanId) ?? null
          : null,
      })),
    };
  }

  // ── Kitobxon/xodim qo'shish (KUTUBXONACHI / MUASSASA_ADMIN) ────────────────
  // Kutubxona xodimi yoki tashkilot HR walk-in kitobxon/xodimni ro'yhatga oladi.
  // Yangi a'zo KITOBXON roli bilan ACTIVE bo'ladi; muassasa (org/maktab/OTM)
  // konteksti chaqiruvchidan meros qilib olinadi.
  async registerReader(
    callerId: string,
    dto: {
      name: string;
      phone: string;
      gender?: string;
      dob?: string;
      viloyatId?: string;
      tumanId?: string;
      mahallaId?: string;
      schoolClass?: string;
      department?: string;
      position?: string;
    },
  ) {
    if (!dto.name?.trim()) throw new BadRequestException("Ism majburiy");
    const phone = this.normalizePhone(dto.phone);
    if (!/^\+\d{9,15}$/.test(phone)) {
      throw new BadRequestException("Telefon raqami noto'g'ri");
    }
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      throw new ConflictException("Bu telefon raqami allaqachon ro'yhatdan o'tgan");
    }
    if (!dto.mahallaId) {
      throw new BadRequestException("Hudud (viloyat → tuman → mahalla) tanlang");
    }

    // Chaqiruvchining muassasasi → yangi a'zo o'sha org/maktab/OTM ga biriktiriladi.
    const caller = await this.prisma.user.findUnique({
      where: { id: callerId },
      select: { organizationId: true, schoolId: true, universityId: true },
    });

    const mahalla = await this.prisma.mahalla.findUnique({
      where: { id: dto.mahallaId },
      include: { tuman: { select: { id: true, viloyatId: true } } },
    });
    if (!mahalla) throw new NotFoundException("Mahalla topilmadi");
    const address = await this.prisma.address.create({
      data: {
        viloyatId: mahalla.tuman.viloyatId,
        tumanId: mahalla.tumanId,
        mahallaId: mahalla.id,
        street: "-",
        house: "-",
        apartment: "-",
      },
    });
    const sifatId = await this.generateSifatId(mahalla.id);

    // Muassasa konteksti bo'yicha foydalanuvchi turi.
    let type: UserType = UserType.CITIZEN;
    if (caller?.schoolId) type = UserType.STUDENT_SCHOOL;
    else if (caller?.universityId) type = UserType.STUDENT_UNIVERSITY;
    else if (caller?.organizationId) type = UserType.GOVERNMENT_EMPLOYEE;

    const tempPassword = this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);
    const gender =
      (dto.gender as UserGender) === UserGender.FEMALE
        ? UserGender.FEMALE
        : UserGender.MALE;
    const dob =
      dto.dob && !isNaN(new Date(dto.dob).getTime())
        ? new Date(dto.dob)
        : new Date("2000-01-01");

    const user = await this.prisma.user.create({
      data: {
        name: dto.name.trim(),
        phone,
        passwordHash,
        role: UserRole.KITOBXON,
        type,
        gender,
        dob,
        status: UserStatus.ACTIVE,
        trustScore: 50,
        sifatId,
        addressId: address.id,
        schoolId: caller?.schoolId ?? undefined,
        schoolClass: caller?.schoolId ? dto.schoolClass || undefined : undefined,
        universityId: caller?.universityId ?? undefined,
        organizationId: caller?.organizationId ?? undefined,
        department: caller?.organizationId ? dto.department || undefined : undefined,
        position: caller?.organizationId ? dto.position || undefined : undefined,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        sifatId: true,
        type: true,
        status: true,
      },
    });

    return { ...user, tempPassword };
  }

  async resetPassword(targetId: string, newPassword?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        "Super admin paroli bu yerdan o'zgartirilmaydi",
      );
    }
    if ((newPassword ?? "").length > 0 && newPassword!.length < 8) {
      throw new BadRequestException(
        "Parol kamida 8 ta belgidan iborat bo'lishi kerak",
      );
    }
    const tempPassword =
      (newPassword ?? "").length >= 8 ? newPassword! : this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: targetId },
      data: { passwordHash },
    });
    // Maqsadli foydalanuvchining barcha sessiyalari bekor qilinadi — u yangi
    // (vaqtinchalik) parol bilan qayta kiradi.
    await this.prisma.refreshToken.updateMany({
      where: { userId: targetId, revoked: false },
      data: { revoked: true },
    });
    return { tempPassword };
  }

  async deleteAccount(targetId: string, actingUserId: string) {
    if (targetId === actingUserId) {
      throw new BadRequestException("O'z akauntingizni o'chira olmaysiz");
    }
    const user = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException("Super admin akaunti o'chirilmaydi");
    }
    // Yumshoq o'chirish — status DELETED + sessiyalar bekor. Ma'lumotlar
    // (tranzaksiyalar, audit) saqlanadi, lekin foydalanuvchi kira olmaydi.
    await this.prisma.user.update({
      where: { id: targetId },
      data: { status: UserStatus.DELETED },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId: targetId, revoked: false },
      data: { revoked: true },
    });
    return { success: true };
  }
}
