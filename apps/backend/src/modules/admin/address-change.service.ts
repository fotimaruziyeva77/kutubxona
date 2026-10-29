import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { assertTumanInScope, type ScopedUser } from "../../common/utils/admin-scope.util";
import {
  CreateAddressChangeDto,
  RejectAddressChangeDto,
} from "./dto/address-change.dto";

/**
 * Plan 06-03 FAM-06 — Address-change workflow.
 *
 * Flow:
 *   1. POST /family/address-change — user submits PENDING request.
 *   2. TUMAN_ADMIN / VILOYAT_ADMIN / SUPER_ADMIN review.
 *   3. PATCH approve → atomic addressId swap + status=APPROVED + audit.
 *   4. PATCH reject → status=REJECTED + reviewer reason + audit.
 *
 * Security (T-06-F2 / T-06-F3 / T-06-F4):
 *   - One PENDING request per user (T-06-F3) — 409 Conflict on duplicate.
 *   - Scope check via assertTumanInScope on toAddress.tumanId; resolved
 *     viloyatId passed for VILOYAT_ADMIN cross-viloyat check (T-06-F4).
 *   - All transitions logged in AiAuditLog.
 */
@Injectable()
export class AddressChangeService {
  private readonly logger = new Logger(AddressChangeService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── POST /family/address-change ───────────────────────────────────────────
  async createRequest(userId: string, dto: CreateAddressChangeDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, addressId: true },
    });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    const target = await this.prisma.address.findUnique({
      where: { id: dto.toAddressId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException("Yangi manzil topilmadi");

    // T-06-F3 — one PENDING per user.
    const existing = await this.prisma.addressChangeRequest.findFirst({
      where: { userId, status: "PENDING" },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        "Avvalgi so'rov hali ko'rib chiqilmadi",
      );
    }

    const request = await this.prisma.addressChangeRequest.create({
      data: {
        userId,
        fromAddressId: user.addressId,
        toAddressId: dto.toAddressId,
        reason: dto.reason,
        status: "PENDING",
      },
    });

    await this.prisma.aiAuditLog.create({
      data: {
        scope: "USER",
        scopeId: userId,
        issueType: "ADDRESS_CHANGE_REQUEST",
        severity: "LOW",
        analysis: `Address change request ${request.id} submitted`,
        recommendation: "Awaiting TUMAN_ADMIN review.",
      },
    });

    return request;
  }

  // ── GET /family/address-change ────────────────────────────────────────────
  // Scope-filtered list for admins.
  async listRequests(
    caller: ScopedUser,
    status?: string,
  ) {
    const role = caller.role as UserRole;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    if (role === UserRole.SUPER_ADMIN || role === UserRole.BUXGALTER) {
      // No additional filter.
    } else if (role === UserRole.VILOYAT_ADMIN) {
      const viloyatId = caller.address?.viloyatId ?? null;
      if (!viloyatId) {
        throw new ForbiddenException(
          "Hudud aniqlanmagan — administrator manzilini sozlang",
        );
      }
      where.toAddress = { viloyatId };
    } else if (role === UserRole.TUMAN_ADMIN) {
      const tumanId = caller.address?.tumanId ?? null;
      if (!tumanId) {
        throw new ForbiddenException(
          "Hudud aniqlanmagan — administrator manzilini sozlang",
        );
      }
      where.toAddress = { tumanId };
    } else {
      throw new ForbiddenException(
        "Scope mismatch: address-change ro'yhatiga ruxsat yo'q",
      );
    }

    return this.prisma.addressChangeRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  // ── PATCH /family/address-change/:id/approve ─────────────────────────────
  async approveRequest(caller: ScopedUser, requestId: string, reviewerId: string) {
    const request = await this.prisma.addressChangeRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException("So'rov topilmadi");
    if (request.status !== "PENDING") {
      throw new BadRequestException(
        "So'rov allaqachon hal qilingan",
      );
    }

    const toAddress = await this.prisma.address.findUnique({
      where: { id: request.toAddressId },
      select: { viloyatId: true, tumanId: true },
    });
    if (!toAddress) throw new NotFoundException("Yangi manzil topilmadi");

    // T-06-F2 / T-06-F4 — scope assertion gates VILOYAT_ADMIN / TUMAN_ADMIN
    // to the resolved viloyat / tuman of the destination address.
    assertTumanInScope(caller, toAddress.tumanId, {
      resolvedViloyatId: toAddress.viloyatId,
    });

    // Atomic: request → APPROVED + user.addressId swap + audit log.
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.addressChangeRequest.update({
        where: { id: requestId },
        data: {
          status: "APPROVED",
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
        },
      });
      await tx.user.update({
        where: { id: request.userId },
        data: { addressId: request.toAddressId },
      });
      await tx.aiAuditLog.create({
        data: {
          scope: "USER",
          scopeId: request.userId,
          issueType: "ADDRESS_CHANGE_APPROVED",
          severity: "LOW",
          analysis: `Address change ${requestId} approved by ${reviewerId}`,
          recommendation: "User address updated.",
        },
      });
      return updated;
    });

    return result;
  }

  // ── PATCH /family/address-change/:id/reject ──────────────────────────────
  async rejectRequest(
    caller: ScopedUser,
    requestId: string,
    reviewerId: string,
    dto: RejectAddressChangeDto,
  ) {
    const request = await this.prisma.addressChangeRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException("So'rov topilmadi");
    if (request.status !== "PENDING") {
      throw new BadRequestException(
        "So'rov allaqachon hal qilingan",
      );
    }

    const toAddress = await this.prisma.address.findUnique({
      where: { id: request.toAddressId },
      select: { viloyatId: true, tumanId: true },
    });
    if (!toAddress) throw new NotFoundException("Yangi manzil topilmadi");

    assertTumanInScope(caller, toAddress.tumanId, {
      resolvedViloyatId: toAddress.viloyatId,
    });

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.addressChangeRequest.update({
        where: { id: requestId },
        data: {
          status: "REJECTED",
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
        },
      });
      await tx.aiAuditLog.create({
        data: {
          scope: "USER",
          scopeId: request.userId,
          issueType: "ADDRESS_CHANGE_REJECTED",
          severity: "LOW",
          analysis: dto.reason,
          recommendation: `Rejected by ${reviewerId}`,
        },
      });
      return updated;
    });
  }
}
