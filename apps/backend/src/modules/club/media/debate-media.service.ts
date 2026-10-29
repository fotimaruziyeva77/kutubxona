import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  PayloadTooLargeException,
} from "@nestjs/common";
// file-type v19+ is ESM-only; use dynamic import() for CJS compat
async function fileTypeFromBuffer(buf: Uint8Array) {
  const { fileTypeFromBuffer: ft } = await import("file-type");
  return ft(buf);
}
import * as crypto from "crypto";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { MinioService } from "../../../infra/minio/minio.service";
import {
  assertInstitutionInScope,
  type InstitutionScopedUser,
} from "../../../common/utils/admin-scope.util";

/**
 * Plan 06-04 SCH-05 — Debate media upload + DRAFT→PUBLISHED state machine.
 *
 * Security boundaries:
 *   - 50MB hard cap per file (Multer middleware enforces BEFORE buffer fully
 *     materialises — see club.controller @UseInterceptors(FileInterceptor)).
 *   - 4-file max per debate (D-Q1) — server-side count enforced here too.
 *   - file-type magic-byte sniff defeats declared-mime spoofing.
 *   - MinIO key derived from cuid + detected.ext (NEVER user filename) —
 *     path traversal mitigation T-06-06b.
 *   - sharp 200x200 thumbnail for images; fail-soft so a corrupt thumbnail
 *     does NOT abort the original upload.
 *   - DRAFT → PUBLISHED requires ≥1 valid DebateMedia row.
 */

const MAX_FILE_BYTES = 50_000_000; // 50 MB
const MAX_FILES_PER_DEBATE = 4;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

// Tolerance: file-type sometimes reports image/jpg; Express usually sends jpeg.
function mimeEqualish(a: string, b: string): boolean {
  const norm = (m: string) => m.toLowerCase().replace("/jpg", "/jpeg");
  return norm(a) === norm(b);
}

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

@Injectable()
export class DebateMediaService {
  private readonly logger = new Logger(DebateMediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioService,
  ) {}

  /**
   * Upload a single media file to a DRAFT debate.
   *
   * Throws:
   *   - PayloadTooLargeException if file > 50MB
   *   - BadRequestException on MIME mismatch, MIME not whitelisted, 5+ files
   *   - NotFoundException on missing debate / club / institution
   *   - ForbiddenException via assertInstitutionInScope
   */
  async uploadDebateMedia(
    user: InstitutionScopedUser & { id: string },
    clubId: string,
    debateId: string,
    file: UploadedFile,
  ): Promise<{ id: string; url: string; thumbnailUrl: string | null }> {
    // ── 1. Size cap (multer should have rejected already, but assert) ──────
    if (file.size > MAX_FILE_BYTES) {
      throw new PayloadTooLargeException(
        `Fayl 50MB dan oshmasligi kerak (got ${file.size} bytes)`,
      );
    }

    // ── 2. Load debate + club + institution for scope check ──────────────
    const debate = await this.prisma.debate.findUnique({
      where: { id: debateId },
      include: {
        club: {
          include: {
            institution: {
              select: { id: true, type: true, tumanId: true, viloyatId: true },
            },
          },
        },
      },
    });
    if (!debate) throw new NotFoundException("Debat topilmadi");
    if (debate.clubId !== clubId) {
      throw new BadRequestException("Debat boshqa klubga tegishli");
    }
    if ((debate as any).status === "PUBLISHED") {
      throw new BadRequestException("Tasdiqlangan debatga yangi fayl yuklash mumkin emas");
    }

    // ── 3. Scope guard BEFORE we touch the file buffer / MinIO ───────────
    const inst = debate.club.institution;
    assertInstitutionInScope(user, inst.id, {
      type: inst.type as any,
      tumanId: inst.tumanId,
      viloyatId: inst.viloyatId,
    });

    // ── 4. 4-file cap ─────────────────────────────────────────────────────
    const existingCount = await this.prisma.debateMedia.count({
      where: { debateId },
    });
    if (existingCount >= MAX_FILES_PER_DEBATE) {
      throw new BadRequestException(
        `Maksimal ${MAX_FILES_PER_DEBATE} ta fayl ruxsat etilgan`,
      );
    }

    // ── 5. file-type magic-byte sniff ────────────────────────────────────
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected) {
      throw new BadRequestException("Fayl turi aniqlanmadi");
    }
    if (!ALLOWED_MIME.has(detected.mime)) {
      throw new BadRequestException(
        `Fayl turi qabul qilinmaydi: ${detected.mime}`,
      );
    }
    if (!mimeEqualish(detected.mime, file.mimetype)) {
      throw new BadRequestException(
        `Fayl turi mos kelmaydi (e'lon: ${file.mimetype}, haqiqiy: ${detected.mime})`,
      );
    }

    // ── 6. Backend-controlled MinIO key (cuid + detected.ext) ────────────
    const cuid = crypto.randomBytes(12).toString("hex"); // simple cuid-ish suffix
    const key = `${inst.id}/${debateId}/${cuid}.${detected.ext}`;
    const bucket = this.minio.bucketDebates;

    try {
      await this.minio.putObject(bucket, key, file.buffer, detected.mime, {
        debateId,
        uploadedBy: user.id,
      });
    } catch (err) {
      this.logger.error(
        `MinIO putObject failed (key=${key}): ${(err as Error).message}`,
      );
      throw new BadRequestException("Faylni yuklashda xato");
    }

    // ── 7. Thumbnail (images only — fail-soft) ───────────────────────────
    let thumbnailUrl: string | null = null;
    if (IMAGE_MIME.has(detected.mime)) {
      const thumbKey = `${inst.id}/${debateId}/${cuid}-thumb.jpg`;
      try {
        // Lazy import sharp so unit tests can mock it.
        const sharpMod = await import("sharp");
        const sharp = (sharpMod as any).default ?? sharpMod;
        const thumbBuffer: Buffer = await sharp(file.buffer)
          .resize(200, 200, { fit: "cover" })
          .jpeg({ quality: 80 })
          .toBuffer();
        await this.minio.putObject(bucket, thumbKey, thumbBuffer, "image/jpeg");
        thumbnailUrl = thumbKey;
      } catch (err) {
        this.logger.warn(
          `Thumbnail generation skipped for ${key}: ${(err as Error).message}`,
        );
      }
    }

    // ── 8. Persist + audit ────────────────────────────────────────────────
    const row = await this.prisma.debateMedia.create({
      data: {
        debateId,
        url: key,
        mimeType: detected.mime,
        sizeBytes: file.size,
        thumbnailUrl,
        uploadedById: user.id,
      },
    });

    // mediaUrls array kept for back-compat with Plan 06-02 consumers.
    await this.prisma.debate.update({
      where: { id: debateId },
      data: { mediaUrls: { push: key } },
    });

    await this.prisma.aiAuditLog.create({
      data: {
        scope: "DEBATE",
        scopeId: debateId,
        issueType: "DEBATE_MEDIA_UPLOAD",
        severity: "LOW",
        analysis: `Media uploaded (${detected.mime}, ${file.size}B) by ${user.id}`,
        recommendation: "",
      },
    });

    return { id: row.id, url: key, thumbnailUrl };
  }

  /**
   * Finalise a DRAFT debate → PUBLISHED. Requires ≥1 DebateMedia row.
   */
  async finalizeDebate(
    user: InstitutionScopedUser & { id: string },
    clubId: string,
    debateId: string,
  ): Promise<{ id: string; status: "PUBLISHED" }> {
    const debate = await this.prisma.debate.findUnique({
      where: { id: debateId },
      include: {
        club: {
          include: {
            institution: {
              select: { id: true, type: true, tumanId: true, viloyatId: true },
            },
          },
        },
      },
    });
    if (!debate) throw new NotFoundException("Debat topilmadi");
    if (debate.clubId !== clubId) {
      throw new BadRequestException("Debat boshqa klubga tegishli");
    }
    if ((debate as any).status === "PUBLISHED") {
      throw new BadRequestException("Debat allaqachon tasdiqlangan");
    }

    const inst = debate.club.institution;
    assertInstitutionInScope(user, inst.id, {
      type: inst.type as any,
      tumanId: inst.tumanId,
      viloyatId: inst.viloyatId,
    });

    const mediaCount = await this.prisma.debateMedia.count({
      where: { debateId },
    });
    if (mediaCount < 1) {
      throw new BadRequestException(
        "Hech bo'lmaganda 1 ta foto yoki video yuklang",
      );
    }

    await this.prisma.$transaction([
      this.prisma.debate.update({
        where: { id: debateId },
        data: { status: "PUBLISHED" } as any,
      }),
      this.prisma.aiAuditLog.create({
        data: {
          scope: "DEBATE",
          scopeId: debateId,
          issueType: "DEBATE_PUBLISHED",
          severity: "LOW",
          analysis: `Debate finalised by ${user.id} with ${mediaCount} media`,
          recommendation: "",
        },
      }),
    ]);

    return { id: debateId, status: "PUBLISHED" };
  }

  /**
   * List debate media with presigned URLs (1h TTL — capped in MinioService).
   */
  async listDebateMedia(
    user: InstitutionScopedUser & { id: string },
    clubId: string,
    debateId: string,
  ): Promise<Array<{ id: string; url: string; thumbnailUrl: string | null; mimeType: string }>> {
    const debate = await this.prisma.debate.findUnique({
      where: { id: debateId },
      include: {
        club: {
          include: {
            institution: {
              select: { id: true, type: true, tumanId: true, viloyatId: true },
            },
          },
        },
      },
    });
    if (!debate) throw new NotFoundException("Debat topilmadi");
    if (debate.clubId !== clubId) {
      throw new BadRequestException("Debat boshqa klubga tegishli");
    }
    const inst = debate.club.institution;
    assertInstitutionInScope(user, inst.id, {
      type: inst.type as any,
      tumanId: inst.tumanId,
      viloyatId: inst.viloyatId,
    });

    const rows = await this.prisma.debateMedia.findMany({
      where: { debateId },
      orderBy: { uploadedAt: "asc" },
    });

    const bucket = this.minio.bucketDebates;
    const out = await Promise.all(
      rows.map(async (r) => {
        let url = r.url;
        let thumbnailUrl = r.thumbnailUrl;
        try {
          url = await this.minio.presignedGetUrl(bucket, r.url, 3600);
          if (r.thumbnailUrl) {
            thumbnailUrl = await this.minio.presignedGetUrl(
              bucket,
              r.thumbnailUrl,
              3600,
            );
          }
        } catch (err) {
          this.logger.warn(
            `presignedGetUrl skipped (${r.id}): ${(err as Error).message}`,
          );
        }
        return {
          id: r.id,
          url,
          thumbnailUrl,
          mimeType: r.mimeType,
        };
      }),
    );
    return out;
  }
}
