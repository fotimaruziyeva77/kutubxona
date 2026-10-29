import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException
} from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { LibraryType, LibraryStatus, Prisma, UserRole } from "@prisma/client";
import { resolveCallerLibraryId } from "../../common/utils/library-scope.util";
// Plan 04-04 audit-fix FIX C — DTO with class-validator decorators lives
// in ./dto/create-library.dto.ts. We re-export the types here so existing
// callers (libraries.controller.ts) keep their import paths.
import {
  CreateLibraryDto,
  UpdateLibraryDto,
  isLibraryNameSafe,
} from "./dto/create-library.dto";
export { CreateLibraryDto, UpdateLibraryDto } from "./dto/create-library.dto";

const TYPE_PREFIX: Record<LibraryType, string> = {
  GOV: "GOV",
  SCH: "SCH",
  UNI: "UNI",
  ORG: "ORG",
  MAH: "MAH"
};

@Injectable()
export class LibrariesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Kutubxona ro'yhati ────────────────────────────────────────────────────
  async findAll(status?: LibraryStatus, type?: LibraryType, tumanId?: string) {
    return this.prisma.library.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        ...(tumanId ? { tumanId } : {})
      },
      include: { approvalLogs: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { createdAt: "desc" }
    });
  }

  // ── Joriy foydalanuvchining kutubxona(lar)i (RBAC scope) ──────────────────
  //
  // Powers GET /libraries/mine. Returns ONLY the libraries the caller may
  // see/manage in the Muassasa paneli + Kitob fondi dropdowns, so a
  // KUTUBXONACHI no longer sees every library in the country.
  //
  //   KUTUBXONACHI / MUASSASA_ADMIN → [their institution's library] (or [])
  //       resolved via the CORRECT forward link Institution.libraryId
  //       (Library.institutionId is NULL for every row — see library-scope.util).
  //   TUMAN_ADMIN   → all libraries where tumanId = caller's address.tumanId
  //   VILOYAT_ADMIN → all libraries where viloyatId = caller's address.viloyatId
  //   SUPER_ADMIN   → all ACTIVE libraries
  //   anything else → []
  //
  // Same row shape (+ last approvalLog) the dropdown already consumes via
  // findAll, so the frontend needs no new field mapping.
  async getManageableLibraries(user: { sub: string; role: UserRole | string }) {
    const role = user.role as UserRole;

    if (role === UserRole.SUPER_ADMIN) {
      return this.findAll(LibraryStatus.ACTIVE);
    }

    if (role === UserRole.VILOYAT_ADMIN || role === UserRole.TUMAN_ADMIN) {
      const caller = await this.prisma.user.findUnique({
        where: { id: user.sub },
        select: { address: { select: { viloyatId: true, tumanId: true } } },
      });
      // Fail-CLOSED on missing scope — mirrors admin-scope.util / payment
      // getCallerScope: a tier admin with no address row sees nothing rather
      // than every library.
      if (role === UserRole.VILOYAT_ADMIN) {
        const viloyatId = caller?.address?.viloyatId;
        if (!viloyatId) return [];
        return this.prisma.library.findMany({
          where: { viloyatId, status: LibraryStatus.ACTIVE },
          include: { approvalLogs: { orderBy: { createdAt: "desc" }, take: 1 } },
          orderBy: { createdAt: "desc" },
        });
      }
      const tumanId = caller?.address?.tumanId;
      if (!tumanId) return [];
      return this.prisma.library.findMany({
        where: { tumanId, status: LibraryStatus.ACTIVE },
        include: { approvalLogs: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { createdAt: "desc" },
      });
    }

    if (role === UserRole.KUTUBXONACHI || role === UserRole.MUASSASA_ADMIN) {
      const libraryId = await resolveCallerLibraryId(this.prisma, user.sub);
      if (!libraryId) return [];
      const lib = await this.prisma.library.findUnique({
        where: { id: libraryId },
        include: { approvalLogs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      return lib ? [lib] : [];
    }

    // KITOBXON / KLUB_RAHBARI / DOKON_OPERATOR / BUXGALTER etc. — no library
    // management surface.
    return [];
  }

  // Kitobxon (talaba/o'quvchi/xodim) o'z muassasa kutubxonasi — navigatsiyadagi
  // "Mening kutubxonam" havolasi uchun. resolveCallerLibraryId BOSHQARUV emas,
  // shunchaki user.(schoolId|universityId|organizationId) → Institution.libraryId
  // forward-link orqali yechadi. Oddiy fuqaroda (muassasasiz) yoki muassasada
  // kutubxona bog'lanmagan bo'lsa null qaytadi → havola ko'rsatilmaydi.
  async getMyInstitutionLibrary(userId: string) {
    const libraryId = await resolveCallerLibraryId(this.prisma, userId);
    if (!libraryId) return null;
    return this.prisma.library.findUnique({
      where: { id: libraryId },
      select: { id: true, code: true, name: true, type: true, status: true }
    });
  }

  // ── Bitta kutubxona ───────────────────────────────────────────────────────
  async findOne(id: string) {
    const lib = await this.prisma.library.findUnique({
      where: { id },
      include: {
        books: { orderBy: { createdAt: "desc" }, take: 20 },
        approvalLogs: { orderBy: { createdAt: "desc" } },
        subscriptions: { orderBy: { createdAt: "desc" }, take: 1 }
      }
    });
    if (!lib) throw new NotFoundException("Kutubxona topilmadi");

    // Kitobxonlar soni — kutubxonaga bog'liq muassasa a'zolari. Library.institutionId
    // NULL bo'lgani uchun bog'lanish Institution.libraryId orqali. Muassasa
    // kutubxonasi uchun = o'sha muassasa o'quvchilari/xodimlari soni.
    let readerCount = 0;
    const inst = await this.prisma.institution.findFirst({
      where: { libraryId: id },
      select: { id: true }
    });
    if (inst) {
      readerCount = await this.prisma.user.count({
        where: {
          OR: [
            { organizationId: inst.id },
            { schoolId: inst.id },
            { universityId: inst.id }
          ]
        }
      });
    }

    return { ...lib, readerCount };
  }

  async findByCode(code: string) {
    const lib = await this.prisma.library.findUnique({
      where: { code },
      include: {
        books: {
          where: { availableCount: { gt: 0 } },
          orderBy: { title: "asc" },
          take: 50
        },
        approvalLogs: { orderBy: { createdAt: "desc" }, take: 3 }
      }
    });
    if (!lib) throw new NotFoundException("Kutubxona topilmadi");
    return lib;
  }

  // ── Kutubxona yaratish ────────────────────────────────────────────────────
  async create(dto: CreateLibraryDto, actorId?: string) {
    // Plan 04-04 audit-fix FIX C (SEC HIGH) — defence in depth. The DTO
    // class-validator runs at the controller via the global ValidationPipe;
    // we re-verify here so a service caller that bypasses the pipe (CLI,
    // future internal API, test seed) still cannot persist a hostile name.
    //
    // Also strip CR/LF outright before persisting so a misconfigured
    // validation pipe in dev never leaves a multi-line name in the DB that
    // would corrupt downstream SMS / CSV / PDF rendering.
    const rawName = dto.name ?? "";
    const strippedName = rawName.replace(/[\r\n]/g, " ").trim();
    if (!isLibraryNameSafe(strippedName)) {
      throw new BadRequestException(
        "Kutubxona nomi yaroqsiz: faqat harf, raqam, bo'sh joy, defis va ampersand. URL fragmentlari taqiqlangan.",
      );
    }

    const code = await this.generateCode(dto.type, dto.tumanId ?? dto.regionId);

    const library = await this.prisma.library.create({
      data: {
        code,
        type: dto.type,
        name: strippedName,
        regionId: dto.regionId,
        tumanId: dto.tumanId,
        viloyatId: dto.viloyatId,
        institutionId: dto.institutionId,
        address: dto.address,
        phone: dto.phone,
        workHours: dto.workHours,
        latitude: dto.latitude,
        longitude: dto.longitude,
        status: LibraryStatus.PENDING,
        approvalLogs: {
          create: { action: "SUBMITTED", actorId, note: "Ariza yuborildi" }
        }
      }
    });
    return library;
  }

  // ── Kutubxona tahrirlash ──────────────────────────────────────────────────
  async update(id: string, dto: UpdateLibraryDto) {
    await this.findOne(id);
    // Plan 04-04 audit-fix FIX C — same defence in depth on update.
    let nameToWrite: string | undefined = undefined;
    if (dto.name !== undefined) {
      const stripped = dto.name.replace(/[\r\n]/g, " ").trim();
      if (!isLibraryNameSafe(stripped)) {
        throw new BadRequestException(
          "Kutubxona nomi yaroqsiz: faqat harf, raqam, bo'sh joy, defis va ampersand. URL fragmentlari taqiqlangan.",
        );
      }
      nameToWrite = stripped;
    }
    return this.prisma.library.update({
      where: { id },
      data: {
        ...(nameToWrite !== undefined ? { name: nameToWrite } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.workHours !== undefined ? { workHours: dto.workHours } : {}),
        ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
        ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {})
      }
    });
  }

  // ── Tasdiqlash jarayoni (3-bosqich) ───────────────────────────────────────
  async approveByTuman(id: string, actorId: string) {
    const lib = await this.findOne(id);
    if (lib.status !== LibraryStatus.PENDING)
      throw new BadRequestException("Kutubxona PENDING holatida emas");

    const lastLog = lib.approvalLogs[0];
    if (lastLog?.action !== "SUBMITTED")
      throw new BadRequestException("Tuman admin allaqachon tasdiqlagan");

    await this.prisma.libraryApprovalLog.create({
      data: { libraryId: id, action: "TUMAN_APPROVED", actorId, note: "Tuman admin tasdiqladi" }
    });
    return { message: "Tuman admin tasdiqladi. Super admin kutilmoqda." };
  }

  async approveBySuperAdmin(id: string, actorId: string) {
    const lib = await this.findOne(id);
    if (lib.status !== LibraryStatus.PENDING)
      throw new BadRequestException("Kutubxona PENDING holatida emas");

    const lastLog = lib.approvalLogs[0];
    if (!lastLog || lastLog.action !== "TUMAN_APPROVED")
      throw new BadRequestException("Avval tuman admin tasdiqlashi kerak");

    return this.prisma.library.update({
      where: { id },
      data: {
        status: LibraryStatus.ACTIVE,
        approvalLogs: {
          create: { action: "SUPER_APPROVED", actorId, note: "Super admin tasdiqladi — ACTIVE" }
        }
      }
    });
  }

  async reject(id: string, actorId: string, reason: string) {
    const lib = await this.findOne(id);
    if (lib.status === LibraryStatus.ACTIVE)
      throw new BadRequestException("Faol kutubxonani rad etib bo'lmaydi");

    return this.prisma.library.update({
      where: { id },
      data: {
        status: LibraryStatus.DELETED,
        approvalLogs: {
          create: { action: "REJECTED", actorId, note: reason }
        }
      }
    });
  }

  // ── Muzlatish ─────────────────────────────────────────────────────────────
  async freeze(id: string, reason: string, actorId: string) {
    if (!reason?.trim()) throw new BadRequestException("Muzlatish sababi majburiy");
    const lib = await this.findOne(id);
    if (lib.status !== LibraryStatus.ACTIVE)
      throw new BadRequestException("Faqat faol kutubxonani muzlatish mumkin");

    return this.prisma.library.update({
      where: { id },
      data: {
        status: LibraryStatus.FROZEN,
        frozenReason: reason,
        approvalLogs: {
          create: { action: "FROZEN", actorId, note: reason }
        }
      }
    });
  }

  async unfreeze(id: string, actorId: string) {
    const lib = await this.findOne(id);
    if (lib.status !== LibraryStatus.FROZEN)
      throw new BadRequestException("Kutubxona muzlatilmagan");

    return this.prisma.library.update({
      where: { id },
      data: {
        status: LibraryStatus.ACTIVE,
        frozenReason: null,
        approvalLogs: {
          create: { action: "UNFROZEN", actorId, note: "Muzlatish bekor qilindi" }
        }
      }
    });
  }

  // ── O'chirish (2-bosqichli: faqat super admin) ────────────────────────────
  async softDelete(id: string, confirmation: string, actorId: string) {
    if (confirmation !== "ROZIMAN")
      throw new ForbiddenException("O'chirish uchun 'ROZIMAN' yozing");

    const lib = await this.findOne(id);
    if (lib.status === LibraryStatus.DELETED)
      throw new BadRequestException("Kutubxona allaqachon o'chirilgan");

    return this.prisma.library.update({
      where: { id },
      data: {
        status: LibraryStatus.DELETED,
        approvalLogs: {
          create: { action: "DELETED", actorId, note: "Super admin tomonidan o'chirildi" }
        }
      }
    });
  }

  // ── Fond inventarizatsiya hisoboti ────────────────────────────────────────
  async getInventoryReport(id: string) {
    const lib = await this.prisma.library.findUnique({
      where: { id },
      include: { books: { select: { id: true, totalCount: true, availableCount: true } } }
    });
    if (!lib) throw new NotFoundException("Kutubxona topilmadi");

    const dbTotal = lib.books.reduce((s, b) => s + b.totalCount, 0);
    const dbAvailable = lib.books.reduce((s, b) => s + b.availableCount, 0);
    const activeBorrowed = dbTotal - dbAvailable;
    const discrepancy = Math.abs(lib.fundCount - dbTotal);
    const discrepancyPct = lib.fundCount > 0 ? (discrepancy / lib.fundCount) * 100 : 0;

    return {
      libraryId: id,
      declaredFundCount: lib.fundCount,
      dbBookCount: dbTotal,
      availableCount: dbAvailable,
      borrowedCount: activeBorrowed,
      discrepancy,
      discrepancyPct: Math.round(discrepancyPct * 100) / 100,
      alert: discrepancyPct >= 5
    };
  }

  // ── BOOK-02 (Plan 02-05): Confirm an inter-library BookTransfer ───────────
  // Bilateral roaming flow (per CLAUDE.md Section III.3.4 Kutubxona Roaming):
  //   1. Plan 02-02 returnRoaming wrote BookTransfer{PENDING, from, to}
  //   2. The source-library librarian (or admin) calls this endpoint
  //   3. We atomically: mark transfer CONFIRMED + increment Book.availableCount
  //      on the source library by 1 using Prisma's atomic { increment: 1 }
  //      (race-safe — no read-then-write window). This restores the source
  //      library's inventory count to what it would have been if the book
  //      had been returned at the source library directly.
  //
  // Authorization (T-02-23): caller must be one of
  //   - SUPER_ADMIN (system-wide)
  //   - the source library's Institution.directorId (KUTUBXONACHI normally)
  //   - TUMAN_ADMIN / VILOYAT_ADMIN are accepted at the controller layer
  //     (RolesGuard); tuman-scope assertion is a future hardening.
  //
  // Double-confirm rejection (T-02-24): transfer must be PENDING. The
  // status check happens inside the interactive $transaction so two
  // concurrent confirm calls race on the row update — Prisma's atomic
  // semantics give us BOOK-05 CHECK-style protection.
  async confirmTransfer(
    libraryId: string,
    transferId: string,
    authUser: { id: string; role: string }
  ): Promise<{ confirmed: boolean; transferId: string }> {
    try {
      const result = await this.prisma.$transaction(async (p) => {
        const transfer = await (p as Prisma.TransactionClient & {
          bookTransfer: {
            findUnique: (args: unknown) => Promise<unknown>;
          };
        }).bookTransfer.findUnique({
          where: { id: transferId },
          include: {
            fromLibrary: { include: { institution: true } },
            transaction: { include: { book: true } }
          }
        });

        if (!transfer) {
          throw new NotFoundException("Transfer topilmadi");
        }

        const t = transfer as {
          id: string;
          status: string;
          fromLibraryId: string;
          fromLibrary: { institution?: { directorId?: string | null } | null };
          transaction: { bookId: string };
        };

        if (t.status !== "PENDING") {
          throw new BadRequestException(
            "Transfer allaqachon tasdiqlangan yoki bekor qilingan"
          );
        }
        if (t.fromLibraryId !== libraryId) {
          throw new BadRequestException("Transfer manba kutubxonasi mos kelmaydi");
        }

        // Authorization: SUPER_ADMIN bypass, otherwise must match institution
        // directorId on the source library.
        const directorMatches =
          t.fromLibrary.institution?.directorId === authUser.id;
        const isSuperAdmin = authUser.role === "SUPER_ADMIN";
        // Tier-admin allowance is checked at the controller RolesGuard layer.
        // Adding tuman scope here would require a User → Address join we
        // intentionally defer (research Open Q 2 — tuman-scope assertion at
        // confirm time is a v2 hardening).
        const isTierAdmin =
          authUser.role === "TUMAN_ADMIN" || authUser.role === "VILOYAT_ADMIN";
        if (!directorMatches && !isSuperAdmin && !isTierAdmin) {
          throw new ForbiddenException(
            "Bu transferni tasdiqlash uchun ruxsat yo'q"
          );
        }

        // Atomic: BookTransfer → CONFIRMED + Book.availableCount + 1.
        await p.bookTransfer.update({
          where: { id: transferId },
          data: {
            status: "CONFIRMED",
            confirmedAt: new Date(),
            confirmedById: authUser.id
          }
        });

        await p.book.update({
          where: { id: t.transaction.bookId },
          data: { availableCount: { increment: 1 } }
        });

        return { confirmed: true, transferId };
      });
      return result;
    } catch (e) {
      // Re-throw NestJS HTTP exceptions cleanly so the controller surfaces
      // the right status code.
      if (
        e instanceof NotFoundException ||
        e instanceof BadRequestException ||
        e instanceof ForbiddenException
      ) {
        throw e;
      }
      // P2010 CHECK violation on a + increment is theoretically impossible
      // (availableCount can only grow), but defensively surface it as 400
      // to match the BOOK-05 pattern from Plan 02-02.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === "P2010" || e.code === "P2002" || e.code === "P2003")
      ) {
        throw new BadRequestException("Inventory race condition — retry");
      }
      throw e;
    }
  }

  // ── Yaqin kutubxonalar (joylashuv) ────────────────────────────────────────
  async findNearby(lat: number, lon: number, radiusKm = 10, bookTitle?: string) {
    const allLibs = await this.prisma.library.findMany({
      where: {
        status: LibraryStatus.ACTIVE,
        latitude: { not: null },
        longitude: { not: null },
        ...(bookTitle
          ? { books: { some: { title: { contains: bookTitle, mode: "insensitive" }, availableCount: { gt: 0 } } } }
          : {})
      },
      include: {
        books: bookTitle
          ? { where: { title: { contains: bookTitle, mode: "insensitive" }, availableCount: { gt: 0 } }, take: 5 }
          : false
      }
    });

    return allLibs
      .map((lib) => ({
        ...lib,
        distanceKm: this.haversine(lat, lon, lib.latitude!, lib.longitude!)
      }))
      .filter((lib) => lib.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 10);
  }

  // ── Kod generatsiya ───────────────────────────────────────────────────────
  private async generateCode(type: LibraryType, tumanIdOrRegion: string): Promise<string> {
    const prefix = TYPE_PREFIX[type];
    // tumanIdOrRegion could be a tuman DB id or a legacy regionId string
    const regionPart = tumanIdOrRegion.replace(/-/g, "").slice(0, 8).toUpperCase();
    const count = await this.prisma.library.count({
      where: { code: { startsWith: `LIB-${prefix}-${regionPart}` } }
    });
    const seq = String(count + 1).padStart(3, "0");
    return `LIB-${prefix}-${regionPart}-${seq}`;
  }

  // ── Haversine formulasi (km) ──────────────────────────────────────────────
  private haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
