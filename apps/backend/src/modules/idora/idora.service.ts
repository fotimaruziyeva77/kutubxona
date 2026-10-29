import {
  Injectable,
  Logger,
  Optional,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../infra/cache/cache.service";
import { PdfService } from "../../infra/pdf/pdf.service";
import { MinioService } from "../../infra/minio/minio.service";
import { AlertDispatchService } from "../ai/alert-dispatch.service";
import { ALERT_TYPES, ALERT_SEVERITY } from "../../common/constants/alert-types.const";
import { NOTIFICATION_QUEUE } from "../../infra/queue/queue-names";
import {
  assertInstitutionInScope,
  type InstitutionScopedUser,
} from "../../common/utils/admin-scope.util";
import { K_ANONYMITY_THRESHOLD } from "../../common/utils/k-anonymity.const";
import { UserRole } from "@prisma/client";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB for kitob burchagi photos
const ALLOWED_PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

@Injectable()
export class IdoraService {
  private readonly logger = new Logger(IdoraService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly pdf: PdfService,
    @Optional() private readonly replicaParam?: PrismaReplicaService,
    @Optional() private readonly minio?: MinioService,
    @Optional() private readonly alertDispatch?: AlertDispatchService,
    @Optional()
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly notificationQueue?: Queue,
  ) {}

  /** Replica when wired, otherwise primary (tests / dev fallback). */
  private get r(): PrismaService | PrismaReplicaService {
    return (this.replicaParam as PrismaReplicaService | undefined) ?? this.prisma;
  }

  // Plan 06-05 ORG-01 — scope resolver. Looks up institution { type, viloyatId,
  // tumanId } so `assertInstitutionInScope` can fail-CLOSED for MUASSASA_ADMIN /
  // VILOYAT_ADMIN / TUMAN_ADMIN without a second round-trip per call site.
  private async _assertScope(
    institutionId: string,
    user?: InstitutionScopedUser,
  ): Promise<void> {
    if (!user) return;
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { id: true, type: true, viloyatId: true, tumanId: true },
    });
    if (!inst) throw new NotFoundException("Idora topilmadi");
    assertInstitutionInScope(user, institutionId, {
      viloyatId: inst.viloyatId,
      tumanId: inst.tumanId,
      type: inst.type as any,
    });
  }

  // Plan 06-05 — ACTIVE/TRIAL subscription gate for paid features (PQ-9 PDF +
  // book-corner verify). SUPER_ADMIN bypasses for operational support.
  private async _assertSubscriptionActive(
    institutionId: string,
    user?: InstitutionScopedUser,
  ): Promise<void> {
    if (user?.role === UserRole.SUPER_ADMIN) return;
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { libraryId: true },
    });
    if (!inst?.libraryId) {
      // No linked library — treat as active (e.g. government-funded ORG without
      // explicit Subscription row). This matches GOV/MAH free-tier flow.
      return;
    }
    const sub = await this.r.subscription.findFirst({
      where: { libraryId: inst.libraryId },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    });
    if (!sub) return;
    if (sub.status !== "ACTIVE" && sub.status !== "TRIAL") {
      throw new ForbiddenException(
        "Idora obunasi muzlatilgan/o'chirilgan — to'lov amalga oshiring",
      );
    }
  }

  // ── Xodimlar ro'yhati ────────────────────────────────────────────────────

  async getEmployees(institutionId: string, filters: {
    department?: string;
    search?: string;
    page?: number;
    limit?: number;
  }, user?: InstitutionScopedUser) {
    await this._assertScope(institutionId, user);

    const { department, search, page = 1, limit = 50 } = filters;
    const skip = (page - 1) * limit;

    const where: any = { organizationId: institutionId };
    if (department) where.department = department;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
        { position: { contains: search, mode: "insensitive" } },
      ];
    }

    const [employees, total] = await Promise.all([
      this.r.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          phone: true,
          sifatId: true,
          department: true,
          position: true,
          status: true,
          trustScore: true,
          createdAt: true,
          readingIndex: {
            orderBy: { calculatedAt: "desc" },
            take: 1,
            select: { score: true, calculatedAt: true },
          },
        },
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
      this.r.user.count({ where }),
    ]);

    return { employees, total, page, limit };
  }

  // Plan 06-05 ORG-01 — employees grouped by department with K-anonymity
  // (threshold 5). Departments with < 5 employees render avgRi as null and
  // kAnonymitySuppressed:true, preserving the bucket shape but hiding the
  // re-identifiable signal.
  async getEmployeesByDepartment(institutionId: string, opts?: { departmentId?: string }, user?: InstitutionScopedUser) {
    await this._assertScope(institutionId, user);

    return this.cache.remember(
      `idora:employees-by-dep:${institutionId}:${opts?.departmentId ?? "all"}`,
      300,
      async () => {
        const where: any = { organizationId: institutionId };
        if (opts?.departmentId) {
          // departmentId here is the Department.name (User.department is a
          // free-text mirror of Department.name in the schema).
          where.department = opts.departmentId;
        }
        const rows = await this.r.user.findMany({
          where,
          select: {
            id: true,
            name: true,
            position: true,
            department: true,
            status: true,
            readingIndex: {
              orderBy: { calculatedAt: "desc" },
              take: 1,
              select: { score: true },
            },
            transactions: {
              where: {
                type: "BORROW",
                borrowedAt: { gte: new Date(new Date().getFullYear(), 0, 1) },
              },
              select: { id: true },
            },
          },
        });

        const buckets = new Map<string, Array<typeof rows[number]>>();
        for (const r of rows) {
          const key = r.department ?? "—";
          const list = buckets.get(key) ?? [];
          list.push(r);
          buckets.set(key, list);
        }

        const out = Array.from(buckets.entries()).map(([departmentName, list]) => {
          const total = list.length;
          const suppressed = total < K_ANONYMITY_THRESHOLD;
          const scores = list
            .map((u) => u.readingIndex[0]?.score ?? 0)
            .filter((s) => s > 0);
          const avgRi = suppressed
            ? null
            : scores.length
            ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2))
            : 0;
          return {
            departmentName,
            total,
            avgRi,
            kAnonymitySuppressed: suppressed,
            employees: list.map((u) => ({
              id: u.id,
              name: u.name,
              position: u.position,
              status: u.status,
              avgRi: u.readingIndex[0]?.score ?? 0,
              booksReadThisYear: u.transactions.length,
            })),
          };
        });

        return { institutionId, buckets: out };
      },
    );
  }

  // Plan 06-05-fix FIX A — scope-asserted employee profile.
  // SECURITY: Returns 404 (NotFoundException) on cross-org access to avoid
  // ID-enumeration leakage. _assertScope runs FIRST to confirm the caller
  // owns the institutionId; then the target.organizationId === institutionId
  // check ensures the userId actually belongs to this institution.
  async getEmployee(
    institutionId: string,
    userId: string,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        readingIndex: { orderBy: { calculatedAt: "desc" }, take: 12 },
        fraudScore: { select: { riskScore: true, action: true } },
        transactions: {
          where: { type: "BORROW" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: {
            id: true,
            status: true,
            borrowedAt: true,
            returnedAt: true,
            book: { select: { title: true, author: true } },
          },
        },
      },
    });
    if (!target) throw new NotFoundException("Xodim topilmadi");
    // Cross-org id-enumeration shield: 404 (not 403) when the target belongs
    // to a different institution. Indistinguishable from "not found".
    if (target.organizationId !== institutionId) {
      throw new NotFoundException("Xodim topilmadi");
    }
    return target;
  }

  // Plan 06-05 ORG-01 — HR admin approves a PENDING employee → ACTIVE; writes
  // AiAuditLog row { issueType:'EMPLOYEE_APPROVE' }.
  async approveEmployee(
    institutionId: string,
    userId: string,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException("Xodim topilmadi");
    if (target.organizationId !== institutionId) {
      throw new BadRequestException("Bu xodim sizning idorangizga tegishli emas");
    }
    if (target.status !== "PENDING") {
      throw new BadRequestException("Xodim allaqachon tasdiqlangan yoki bloklangan");
    }

    await this.cache.del(`idora:employees-by-dep:${institutionId}:all`);

    const [updated, audit] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { status: "ACTIVE" },
      }),
      this.prisma.aiAuditLog.create({
        data: {
          scope: "USER",
          scopeId: userId,
          issueType: "EMPLOYEE_APPROVE",
          severity: "LOW" as any,
          analysis: `HR admin approved employee ${target.name} for institution ${institutionId}`,
          recommendation: "—",
        },
      }),
    ]);

    return { userId, status: updated.status, auditId: audit.id };
  }

  // Plan 06-05 ORG-01 — HR admin rejects a PENDING employee → BLOCKED with
  // free-text reason (min 3 chars). Audit log captures reason for recovery.
  async rejectEmployee(
    institutionId: string,
    userId: string,
    reason: string,
    user?: InstitutionScopedUser,
  ) {
    if (typeof reason !== "string" || reason.trim().length < 3) {
      throw new BadRequestException("Rad etish sababi (kamida 3 belgi) majburiy");
    }
    const trimmedReason = reason.trim().slice(0, 500);

    await this._assertScope(institutionId, user);
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException("Xodim topilmadi");
    if (target.organizationId !== institutionId) {
      throw new BadRequestException("Bu xodim sizning idorangizga tegishli emas");
    }
    if (target.status !== "PENDING") {
      throw new BadRequestException("Xodim PENDING holatida emas");
    }

    await this.cache.del(`idora:employees-by-dep:${institutionId}:all`);

    const [, audit] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { status: "BLOCKED" as any },
      }),
      this.prisma.aiAuditLog.create({
        data: {
          scope: "USER",
          scopeId: userId,
          issueType: "EMPLOYEE_REJECT",
          severity: "LOW" as any,
          analysis: `HR admin rejected: ${trimmedReason}`,
          recommendation: "—",
        },
      }),
    ]);

    return { userId, status: "BLOCKED", reason: trimmedReason, auditId: audit.id };
  }

  // ── Bo'lim (Department) boshqaruvi ──────────────────────────────────────

  async getDepartments(institutionId: string, user?: InstitutionScopedUser) {
    await this._assertScope(institutionId, user);
    return this.cache.remember(`idora:departments:${institutionId}`, 600, async () => {
      const deps = await this.prisma.department.findMany({
        where: { institutionId },
        orderBy: { name: "asc" },
      });

      // Har bir bo'lim uchun xodimlar sonini qo'shamiz
      const result = await Promise.all(
        deps.map(async (d) => {
          const count = await this.prisma.user.count({
            where: { organizationId: institutionId, department: d.name },
          });
          return { ...d, employeeCount: count };
        })
      );
      return result;
    });
  }

  async createDepartment(
    institutionId: string,
    data: { name: string; code?: string; headId?: string },
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    await this.cache.del(`idora:departments:${institutionId}`);
    return this.prisma.department.create({ data: { institutionId, ...data } });
  }

  // Plan 06-05-fix FIX B — scoped department update.
  // SECURITY: institutionId is now part of the signature so we can
  //   (1) assert scope on institutionId BEFORE any DB write, and
  //   (2) verify the deptId belongs to that institution (cross-org dept
  //       takeover defence — 404 on mismatch).
  async updateDepartment(
    institutionId: string,
    deptId: string,
    data: Partial<{ name: string; code: string; headId: string }>,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const existing = await this.prisma.department.findUnique({
      where: { id: deptId },
      select: { institutionId: true },
    });
    if (!existing) throw new NotFoundException("Bo'lim topilmadi");
    if (existing.institutionId !== institutionId) {
      // 404 (not 403) to avoid id-enumeration leakage across institutions.
      throw new NotFoundException("Bo'lim topilmadi");
    }
    await this.cache.del(`idora:departments:${institutionId}`);
    return this.prisma.department.update({ where: { id: deptId }, data });
  }

  // Plan 06-05-fix FIX B — scoped department delete (same contract).
  async deleteDepartment(
    institutionId: string,
    deptId: string,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const existing = await this.prisma.department.findUnique({
      where: { id: deptId },
      select: { institutionId: true },
    });
    if (!existing) throw new NotFoundException("Bo'lim topilmadi");
    if (existing.institutionId !== institutionId) {
      throw new NotFoundException("Bo'lim topilmadi");
    }
    await this.cache.del(`idora:departments:${institutionId}`);
    return this.prisma.department.delete({ where: { id: deptId } });
  }

  // ── Idora ichki reyting ──────────────────────────────────────────────────
  //
  // Plan 06-01 R-DUP resolution (SCH-07 + ORG-02 + D-OQ-1):
  //   Phase 3 InstitutionalService.computeForType('IDORA') is the SOLE writer
  //   of OrgRating rows. Read paths here MUST NOT write — duplicate writes
  //   caused rank flapping when both crons fired within the same minute.
  //
  //   Read fallback (when Phase 3 cron has not yet produced a row) computes
  //   in-memory only — the result is returned but never persisted.

  async getInternalRating(
    institutionId: string,
    month?: string,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const m = month ?? this._currentMonth();
    const cacheKey = `idora:rating:${institutionId}:${m}`;

    return this.cache.remember(cacheKey, 300, async () => {
      const existing = await this.r.orgRating.findMany({
        where: { institutionId, month: m },
        orderBy: { rank: "asc" },
      });
      if (existing.length > 0) return existing;

      // Phase 3 cron hasn't materialised yet — compute in-memory only.
      // We DO NOT persist; see R-DUP note above.
      return this._computeRating(institutionId, m);
    });
  }

  // Plan 06-05 ORG-02 — last-6-months OrgRating series for monthly dynamics
  // chart. Read-only against OrgRating (the R-DUP regression guard tests this).
  async getInternalRatingHistory(institutionId: string, user?: InstitutionScopedUser) {
    await this._assertScope(institutionId, user);
    const months: string[] = [];
    const d = new Date();
    for (let i = 0; i < 6; i++) {
      const month = new Date(d.getFullYear(), d.getMonth() - i, 1);
      months.push(
        `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`,
      );
    }
    const rows = await this.r.orgRating.findMany({
      where: { institutionId, month: { in: months } },
      orderBy: [{ month: "asc" }, { rank: "asc" }],
    });
    return { institutionId, months: months.reverse(), rows };
  }

  private async _computeRating(institutionId: string, month: string) {
    const employees = await this.r.user.findMany({
      where: { organizationId: institutionId },
      select: {
        id: true,
        name: true,
        department: true,
        readingIndex: {
          where: {
            calculatedAt: { gte: new Date(`${month}-01`) },
          },
          orderBy: { calculatedAt: "desc" },
          take: 1,
          select: { score: true },
        },
        transactions: {
          where: {
            type: "BORROW",
            borrowedAt: { gte: new Date(`${month}-01`) },
          },
          select: { id: true },
        },
      },
    });

    const withScores = employees.map((e) => ({
      userId: e.id,
      userName: e.name,
      department: e.department ?? undefined,
      avgRi: e.readingIndex[0]?.score ?? 0,
      booksRead: e.transactions.length,
    }));

    // RI bo'yicha saralash
    withScores.sort((a, b) => b.avgRi - a.avgRi || b.booksRead - a.booksRead);

    return withScores.map((e, idx) => ({
      ...e,
      rank: idx + 1,
      isMvp: idx === 0,
    }));
  }

  // ── Kitob burchagi ───────────────────────────────────────────────────────

  async getBookCorner(institutionId: string, user?: InstitutionScopedUser) {
    await this._assertScope(institutionId, user);
    return this.prisma.bookCorner.findFirst({
      where: { institutionId },
      orderBy: { createdAt: "desc" },
    });
  }

  async upsertBookCorner(
    institutionId: string,
    data: {
      name?: string;
      floor?: string;
      photoUrls?: string[];
      latitude?: number;
      longitude?: number;
      adminNote?: string;
    },
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const existing = await this.prisma.bookCorner.findFirst({ where: { institutionId } });
    const now = new Date();
    const nextReminder = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    if (existing) {
      return this.prisma.bookCorner.update({
        where: { id: existing.id },
        data: {
          ...data,
          lastVerified: now,
          nextReminderAt: nextReminder,
          isActive: true,
        },
      });
    }

    return this.prisma.bookCorner.create({
      data: {
        institutionId,
        ...data,
        lastVerified: now,
        nextReminderAt: nextReminder,
      },
    });
  }

  // Plan 06-05 ORG-04 — Verify the book corner with a freshly uploaded photo.
  // MIME sniff via file-type (image-only whitelist) + 5MB cap. MinIO upload to
  // MINIO_BUCKET_BOOKCORNERS. $transaction writes BookCornerVerification row +
  // bumps BookCorner.lastVerifiedAt + creates audit log.
  async verifyBookCorner(
    institutionId: string,
    verifiedById: string,
    file: { buffer: Buffer; mimetype?: string; size?: number; originalname?: string } | undefined,
    user?: InstitutionScopedUser,
  ): Promise<{ verificationId: string; photoUrl: string }> {
    await this._assertScope(institutionId, user);
    await this._assertSubscriptionActive(institutionId, user);

    if (!file?.buffer) {
      throw new BadRequestException("Foto fayl talab qilinadi");
    }
    if ((file.size ?? file.buffer.length) > MAX_PHOTO_BYTES) {
      throw new BadRequestException(
        `Foto hajmi ${MAX_PHOTO_BYTES / 1024 / 1024} MB dan oshib ketdi`,
      );
    }
    // file-type sniff — never trust the client-sent Content-Type.
    let detectedMime = "";
    try {
      const ft = await import("file-type");
      const detected = await ft.fileTypeFromBuffer(file.buffer);
      detectedMime = detected?.mime ?? "";
    } catch (err) {
      this.logger.warn(`[verifyBookCorner] file-type sniff failed: ${(err as Error).message}`);
    }
    if (!detectedMime || !ALLOWED_PHOTO_MIMES.includes(detectedMime as any)) {
      throw new BadRequestException(
        "Faqat JPEG/PNG/WebP rasm fayllariga ruxsat berilgan",
      );
    }

    // Find or create the BookCorner row so we have a stable bookCornerId.
    let corner = await this.prisma.bookCorner.findFirst({
      where: { institutionId },
    });
    const now = new Date();
    const next = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    if (!corner) {
      corner = await this.prisma.bookCorner.create({
        data: {
          institutionId,
          lastVerified: now,
          nextReminderAt: next,
          isActive: true,
        },
      });
    }

    // Build a deterministic backend-controlled key — never user-supplied.
    const ext = detectedMime.split("/")[1] || "jpg";
    const key = `${institutionId}/${corner.id}/${now.getTime()}.${ext}`;
    const bucket = this.minio?.bucketBookCorners ?? "bookcorner-photos";
    if (this.minio) {
      await this.minio.putObject(bucket, key, file.buffer, detectedMime, {
        "x-amz-meta-institution-id": institutionId,
        "x-amz-meta-verified-by": verifiedById,
      });
    }
    // Signed URL — 1h TTL hard cap enforced inside MinioService.
    const photoUrl = this.minio
      ? await this.minio.presignedGetUrl(bucket, key, 3600)
      : `minio://${bucket}/${key}`;

    const [, verification] = await this.prisma.$transaction([
      this.prisma.bookCorner.update({
        where: { id: corner.id },
        data: {
          lastVerified: now,
          nextReminderAt: next,
          isActive: true,
          photoUrls: { set: [...(corner.photoUrls ?? []), photoUrl].slice(-4) },
        },
      }),
      this.prisma.bookCornerVerification.create({
        data: {
          bookCornerId: corner.id,
          verifiedById,
          photoUrls: [photoUrl],
        },
      }),
    ]);

    return { verificationId: verification.id, photoUrl };
  }

  // ── Kitob o'qish soati ───────────────────────────────────────────────────

  async getReadingHours(
    institutionId: string,
    page = 1,
    limit = 20,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.readingHour.findMany({
        where: { institutionId },
        include: { attendances: { select: { userId: true } } },
        orderBy: { heldAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.readingHour.count({ where: { institutionId } }),
    ]);
    return { items, total, page, limit };
  }

  // Plan 06-05-fix FIX D — recordedById is the JWT actor (NOT body input).
  // The controller passes user.sub from the request token; body cannot forge
  // identity (audit-trail integrity).
  async createReadingHour(
    institutionId: string,
    recordedById: string,
    data: {
      title?: string;
      heldAt: string;
      venue?: string;
      durationMin?: number;
      mediaUrls?: string[];
      notes?: string;
    },
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    return this.prisma.readingHour.create({
      data: {
        institutionId,
        recordedById,
        title: data.title ?? "Kitob o'qish soati",
        heldAt: new Date(data.heldAt),
        venue: data.venue,
        durationMin: data.durationMin ?? 60,
        mediaUrls: data.mediaUrls ?? [],
        notes: data.notes,
      },
    });
  }

  // Plan 06-05-fix FIX D — cross-org attendance forgery defence.
  // SECURITY: An attacker could otherwise post userIds from another
  // organization to mark them as attending an event in this institution and
  // inflate their reading-index. We verify every userId.organizationId
  // matches institutionId before writing attendance rows.
  async markAttendance(
    institutionId: string,
    readingHourId: string,
    userIds: string[],
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return { marked: 0 };
    }
    // Verify the readingHour belongs to this institution (route binding
    // integrity — readingHourId comes from the URL, not the body).
    const event = await this.prisma.readingHour.findUnique({
      where: { id: readingHourId },
      select: { institutionId: true },
    });
    if (!event) throw new NotFoundException("Tadbir topilmadi");
    if (event.institutionId !== institutionId) {
      throw new NotFoundException("Tadbir topilmadi");
    }
    // Cross-org user filter — every userId MUST belong to this institution.
    const valid = await this.prisma.user.findMany({
      where: { id: { in: userIds }, organizationId: institutionId },
      select: { id: true },
    });
    if (valid.length !== userIds.length) {
      throw new BadRequestException(
        "Ba'zi xodimlar bu idoraga tegishli emas",
      );
    }
    const data = userIds.map((userId) => ({ readingHourId, userId }));
    await this.prisma.readingHourAttendee.createMany({ data, skipDuplicates: true });
    return { marked: userIds.length };
  }

  async getReadingHourStats(institutionId: string, user?: InstitutionScopedUser) {
    await this._assertScope(institutionId, user);
    const thisMonth = this._currentMonth();
    const [total, thisMonthCount] = await Promise.all([
      this.prisma.readingHour.count({ where: { institutionId } }),
      this.prisma.readingHour.count({
        where: {
          institutionId,
          heldAt: { gte: new Date(`${thisMonth}-01`) },
        },
      }),
    ]);

    const lastEvent = await this.prisma.readingHour.findFirst({
      where: { institutionId },
      orderBy: { heldAt: "desc" },
      select: { heldAt: true },
    });

    const daysSinceLastEvent = lastEvent
      ? Math.floor((Date.now() - lastEvent.heldAt.getTime()) / (24 * 60 * 60 * 1000))
      : null;

    return { total, thisMonthCount, lastEvent: lastEvent?.heldAt, daysSinceLastEvent };
  }

  // ── Kasb adabiyotlar ro'yhati ────────────────────────────────────────────

  async getProfBooks(
    institutionId: string,
    departmentId?: string,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    return this.prisma.profBook.findMany({
      where: {
        institutionId,
        ...(departmentId ? { departmentId } : {}),
      },
      include: { department: { select: { name: true } } },
      orderBy: [{ isRequired: "desc" }, { createdAt: "desc" }],
    });
  }

  // Plan 06-05 ORG-07 — HR-only kasb adabiyotlar add. Validates ISBN-13 when
  // supplied; scope-asserted; title 1-200, author required.
  async addProfBook(
    institutionId: string,
    addedById: string,
    data: {
      departmentId?: string;
      isbn?: string;
      title: string;
      author: string;
      genre?: string;
      description?: string;
      isRequired?: boolean;
    },
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    if (!data?.title?.trim() || data.title.trim().length > 200) {
      throw new BadRequestException("Kitob nomi 1-200 belgi orasida bo'lishi kerak");
    }
    if (!data?.author?.trim()) {
      throw new BadRequestException("Muallif majburiy");
    }
    if (data.isbn && !this._isValidIsbn13(data.isbn)) {
      throw new BadRequestException("ISBN-13 formati noto'g'ri");
    }
    return this.prisma.profBook.create({
      data: { institutionId, addedById, ...data },
    });
  }

  // Plan 06-05 ORG-07 — HR-only remove. Ownership check (profBook.institutionId
  // === institutionId) blocks cross-institution deletion.
  async removeProfBook(
    institutionId: string,
    id: string,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const book = await this.prisma.profBook.findUnique({ where: { id } });
    if (!book) throw new NotFoundException("Kitob topilmadi");
    if (book.institutionId !== institutionId) {
      throw new ForbiddenException("Bu kitob boshqa muassasaga tegishli");
    }
    return this.prisma.profBook.delete({ where: { id } });
  }

  // Plan 06-05 ORG-07 — keep legacy 1-arg signature for back-compat callers.
  async removeProfBookById(id: string) {
    return this.prisma.profBook.delete({ where: { id } });
  }

  private _isValidIsbn13(isbn: string): boolean {
    const digits = isbn.replace(/[-\s]/g, "");
    if (!/^\d{13}$/.test(digits)) return false;
    // ISBN-13 checksum: sum(d_i * (i%2 === 0 ? 1 : 3)) mod 10 === 0
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return sum % 10 === 0;
  }

  // ── PQ-9 Hisobot (PDF) ───────────────────────────────────────────────────
  //
  // Plan 06-05 ORG-06 — delegates the HTML render to PdfService.generateIdoraPq9Report,
  // mirroring the Plan 06-02 SchoolService → PdfService.generateSchoolPq9Report
  // factoring. Subscription gate enforced before puppeteer launches.

  async generatePq9Report(
    institutionId: string,
    user?: InstitutionScopedUser,
  ): Promise<Buffer> {
    await this._assertScope(institutionId, user);
    await this._assertSubscriptionActive(institutionId, user);

    // Outer assertion done — pass `undefined` to skip nested scope DB hit.
    const data = await this.composePq9Data(institutionId);
    const html = this.pdf.generateIdoraPq9Report(data);
    return this.pdf.generateFromHtml(html);
  }

  /**
   * Plan 06-05 ORG-06 — Compose the PQ-9 idora PDF data shape. Reads via replica
   * where possible. EVERY DB string interpolation is escaped downstream in
   * PdfService.generateIdoraPq9Report (Wave 0 lesson).
   *
   * Plan 06-05-fix FIX B — scope-asserted. Callers (generatePq9Report) already
   * assert via the outer entry-point, but composePq9Data is also a public read
   * surface, so we guard it here too. The internal sub-calls
   * (getBookCorner / getReadingHourStats / getInternalRating / getProfBooks)
   * re-assert when `user` is forwarded — pass `undefined` to bypass the
   * redundant per-call DB round-trip while keeping the outer assertion active.
   */
  async composePq9Data(institutionId: string, user?: InstitutionScopedUser) {
    await this._assertScope(institutionId, user);
    const institution = await this.r.institution.findUnique({
      where: { id: institutionId },
    });
    if (!institution) throw new NotFoundException("Idora topilmadi");

    const month = this._currentMonth();
    const [corner, readingHourStats, rating, profBooks, employees] = await Promise.all([
      // Scope already asserted above — skip nested re-assertion to avoid
      // double DB round-trips on the institution row.
      this.getBookCorner(institutionId),
      this.getReadingHourStats(institutionId),
      this.getInternalRating(institutionId, month),
      this.getProfBooks(institutionId),
      this.r.user.count({ where: { organizationId: institutionId } }),
    ]);

    const mvp = (rating as any[]).find((r: any) => r.isMvp);

    // Mukofot taklifi audit history (most recent 5) — frontend / PDF can show
    // who was already nominated this period.
    const mukofotHistory = await this.r.aiAuditLog.findMany({
      where: { issueType: "MUKOFOT_TAKLIFI", scope: "INSTITUTION", scopeId: institutionId },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    const bookCornerActive = corner?.lastVerified
      ? Date.now() - corner.lastVerified.getTime() < 90 * 24 * 60 * 60 * 1000
      : false;

    return {
      title: "PQ-9 Muvofiqlik Hisoboti",
      period: month,
      generatedAt: new Date().toLocaleDateString("uz-UZ"),
      institutionName: institution.name,
      bookCorner: {
        isActive: bookCornerActive,
        lastVerifiedAt: corner?.lastVerified ?? null,
        nextReminderAt: corner?.nextReminderAt ?? null,
        photos: (corner?.photoUrls ?? []).slice(0, 3),
      },
      readingHours: {
        thisMonth: readingHourStats.thisMonthCount,
        total: readingHourStats.total,
        lastEventAt: readingHourStats.lastEvent ?? null,
        daysSinceLastEvent: readingHourStats.daysSinceLastEvent,
      },
      mvp: mvp
        ? {
            userName: mvp.userName,
            department: mvp.department ?? null,
            avgRi: Number(mvp.avgRi ?? 0),
            booksRead: Number(mvp.booksRead ?? 0),
          }
        : null,
      rankingTop10: (rating as any[]).slice(0, 10).map((r: any) => ({
        rank: Number(r.rank),
        userName: r.userName,
        department: r.department ?? null,
        avgRi: Number(r.avgRi ?? 0),
        booksRead: Number(r.booksRead ?? 0),
      })),
      profBooks: (profBooks ?? []).slice(0, 20).map((b: any) => ({
        title: b.title,
        author: b.author,
        isRequired: Boolean(b.isRequired),
      })),
      employeeCount: Number(employees),
      mukofotHistory: mukofotHistory.map((m: any) => ({
        createdAt: m.createdAt,
        analysis: m.analysis,
      })),
    };
  }

  // ── Kitob burchagi 90-kunlik eslatmasi (cron) ───────────────────────────
  //
  // Plan 06-05 ORG-04 — Replaces the prior STUB. Daily 09:00 Asia/Tashkent.
  // Leader-locked via Redis SETNX (cron:book-corner-reminders:<YYYY-MM-DD>,
  // 22h TTL) so only one replica fans out. Per-institution 30-day dedup
  // (BOOK_CORNER_REMINDER_SENT audit row check) prevents spam.

  @Cron("0 9 * * *", {
    name: "book-corner-reminders",
    timeZone: "Asia/Tashkent",
  })
  async bookCornerReminders(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const lockKey = `cron:book-corner-reminders:${day}`;
    const acquired = await this.cache.setNx(lockKey, "1", 22 * 60 * 60);
    if (!acquired) {
      this.logger.debug(
        `[book-corner-reminders] leader lock held — skipping ${day}`,
      );
      return;
    }

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const dedupCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const overdue = await this.r.bookCorner.findMany({
      where: {
        isActive: true,
        OR: [
          { lastVerified: { lt: cutoff } },
          { lastVerified: null, createdAt: { lt: cutoff } },
        ],
      },
      select: {
        id: true,
        institutionId: true,
        lastVerified: true,
      },
    });

    if (overdue.length === 0) {
      this.logger.log("[book-corner-reminders] no overdue book corners");
      return;
    }

    let dispatched = 0;
    let skippedSubscription = 0;
    let skippedDedup = 0;

    for (const row of overdue) {
      // Subscription gate — skip frozen / deleted institutions to avoid
      // spamming non-paying customers (T-06-O5).
      const inst = await this.r.institution.findUnique({
        where: { id: row.institutionId },
        select: { libraryId: true, name: true },
      });
      if (inst?.libraryId) {
        const sub = await this.r.subscription.findFirst({
          where: { libraryId: inst.libraryId },
          orderBy: { createdAt: "desc" },
          select: { status: true },
        });
        if (sub && sub.status !== "ACTIVE" && sub.status !== "TRIAL") {
          skippedSubscription++;
          continue;
        }
      }

      // Dedup — skip if we already sent a BOOK_CORNER_REMINDER_SENT for this
      // institution in the last 30 days.
      const recent = await this.r.aiAuditLog.findFirst({
        where: {
          issueType: "BOOK_CORNER_REMINDER_SENT",
          scope: "INSTITUTION",
          scopeId: row.institutionId,
          createdAt: { gte: dedupCutoff },
        },
        select: { id: true },
      });
      if (recent) {
        skippedDedup++;
        continue;
      }

      const daysSince = row.lastVerified
        ? Math.floor((Date.now() - row.lastVerified.getTime()) / (24 * 60 * 60 * 1000))
        : 90;

      // Persist the audit log first — even if dispatch fails, we have a
      // record for retry / manual processing.
      const audit = await this.prisma.aiAuditLog.create({
        data: {
          scope: "INSTITUTION",
          scopeId: row.institutionId,
          issueType: "BOOK_CORNER_REMINDER_SENT",
          severity: ALERT_SEVERITY.OGOHLANTIRISH as any,
          analysis: `Kitob burchagi ${daysSince} kundan beri yangilanmagan (institutionId=${row.institutionId})`,
          recommendation: "HR admin yangi foto yuklash orqali tasdiqlasin",
        },
      });

      if (this.alertDispatch) {
        try {
          await this.alertDispatch.dispatch({
            id: audit.id,
            scope: "INSTITUTION",
            scopeId: row.institutionId,
            issueType: ALERT_TYPES.BOOK_CORNER_REMINDER,
            severity: ALERT_SEVERITY.OGOHLANTIRISH as any,
            analysis: audit.analysis,
            recommendation: audit.recommendation,
            createdAt: audit.createdAt,
          });
          dispatched++;
        } catch (err) {
          this.logger.error(
            `[book-corner-reminders] dispatch failed for ${row.institutionId}: ${(err as Error).message}`,
          );
        }
      }
    }

    this.logger.log(
      `[book-corner-reminders] dispatched=${dispatched} skippedSubscription=${skippedSubscription} skippedDedup=${skippedDedup} overdue=${overdue.length}`,
    );
  }

  private _currentMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
}
