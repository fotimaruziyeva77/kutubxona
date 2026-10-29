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
import { PrismaService } from "../../../../infra/prisma/prisma.service";
import { MinioService } from "../../../../infra/minio/minio.service";
import {
  assertInstitutionInScope,
  type InstitutionScopedUser,
} from "../../../../common/utils/admin-scope.util";

/**
 * Plan 06-06 ORG-03 — Reading Hour media upload + presigned-URL listing.
 *
 * Mirrors Plan 06-04 DebateMediaService EXACTLY with the following swaps:
 *   - parent model = ReadingHour + ReadingHourMedia (not Debate + DebateMedia)
 *   - bucket = MinioService.bucketReadingHours
 *   - count-cap field = readingHourId
 *
 * Security boundaries (same as Plan 06-04):
 *   - 50MB hard cap per file
 *   - 4 files per event cap (D-Q1 reused)
 *   - file-type magic-byte sniff defeats declared-MIME spoofing
 *   - MinIO key = `reading-hours/{institutionId}/{eventId}/{cuid}.{ext}` — NEVER
 *     user-supplied filename (path-traversal mitigation)
 *   - scope guard BEFORE buffer is touched or putObject is called
 *   - presigned URL TTL ≤ 3600s (Plan 06-01 MinioService hard-cap)
 */

const MAX_FILE_BYTES = 50_000_000; // 50 MB
const MAX_FILES_PER_EVENT = 4;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

// Tolerance: file-type sometimes reports image/jpg; multer usually sends jpeg.
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
export class ReadingHourMediaService {
  private readonly logger = new Logger(ReadingHourMediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioService,
  ) {}

  private async _loadEventAndScope(
    user: InstitutionScopedUser & { id: string },
    institutionId: string,
    readingHourId: string,
  ) {
    const event = await this.prisma.readingHour.findUnique({
      where: { id: readingHourId },
      select: { id: true, institutionId: true },
    });
    if (!event) throw new NotFoundException("Tadbir topilmadi");
    if (event.institutionId !== institutionId) {
      throw new BadRequestException("Tadbir boshqa idoraga tegishli");
    }
    const inst = await this.prisma.institution.findUnique({
      where: { id: event.institutionId },
      select: { id: true, type: true, tumanId: true, viloyatId: true },
    });
    if (!inst) throw new NotFoundException("Idora topilmadi");
    assertInstitutionInScope(user, inst.id, {
      type: inst.type as any,
      tumanId: inst.tumanId,
      viloyatId: inst.viloyatId,
    });
    return event;
  }

  /**
   * Upload a single media file to a DRAFT (or PUBLISHED-for-evidence) event.
   */
  async uploadMedia(
    user: InstitutionScopedUser & { id: string },
    institutionId: string,
    readingHourId: string,
    file: UploadedFile,
  ): Promise<{ id: string; url: string; mimeType: string }> {
    // ── 1. Size cap (multer rejects earlier; defence-in-depth) ────────────
    if (file.size > MAX_FILE_BYTES) {
      throw new PayloadTooLargeException(
        `Fayl 50MB dan oshmasligi kerak (got ${file.size} bytes)`,
      );
    }

    // ── 2. Load event + assert scope BEFORE buffer is touched ─────────────
    await this._loadEventAndScope(user, institutionId, readingHourId);

    // ── 3. 4-file cap ─────────────────────────────────────────────────────
    const existingCount = await this.prisma.readingHourMedia.count({
      where: { readingHourId },
    });
    if (existingCount >= MAX_FILES_PER_EVENT) {
      throw new BadRequestException(
        `Maksimal ${MAX_FILES_PER_EVENT} ta fayl ruxsat etilgan`,
      );
    }

    // ── 4. file-type magic-byte sniff ────────────────────────────────────
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

    // ── 5. Backend-controlled MinIO key (cuid + detected.ext) ────────────
    const cuid = crypto.randomBytes(12).toString("hex");
    const key = `reading-hours/${institutionId}/${readingHourId}/${cuid}.${detected.ext}`;
    const bucket = this.minio.bucketReadingHours;

    try {
      await this.minio.putObject(bucket, key, file.buffer, detected.mime, {
        readingHourId,
        uploadedBy: user.id,
      });
    } catch (err) {
      this.logger.error(
        `MinIO putObject failed (key=${key}): ${(err as Error).message}`,
      );
      throw new BadRequestException("Faylni yuklashda xato");
    }

    // ── 6. Persist + audit ────────────────────────────────────────────────
    const row = await this.prisma.readingHourMedia.create({
      data: {
        readingHourId,
        url: key,
        mimeType: detected.mime,
        sizeBytes: file.size,
        uploadedById: user.id,
      },
    });

    // mediaUrls array kept for back-compat with Plan 06-01 consumers.
    await this.prisma.readingHour.update({
      where: { id: readingHourId },
      data: { mediaUrls: { push: key } },
    });

    await this.prisma.aiAuditLog.create({
      data: {
        scope: "READING_HOUR",
        scopeId: readingHourId,
        issueType: "READING_HOUR_MEDIA_UPLOAD",
        severity: "LOW",
        analysis: `Media uploaded (${detected.mime}, ${file.size}B) by ${user.id}`,
        recommendation: "",
      },
    });

    return { id: row.id, url: key, mimeType: detected.mime };
  }

  /**
   * List media for an event with presigned URLs (3600s TTL).
   */
  async listMedia(
    user: InstitutionScopedUser & { id: string },
    institutionId: string,
    readingHourId: string,
  ): Promise<Array<{ id: string; url: string; mimeType: string; sizeBytes: number }>> {
    await this._loadEventAndScope(user, institutionId, readingHourId);

    const rows = await this.prisma.readingHourMedia.findMany({
      where: { readingHourId },
      orderBy: { uploadedAt: "asc" },
    });

    const bucket = this.minio.bucketReadingHours;
    const out = await Promise.all(
      rows.map(async (r) => {
        let url = r.url;
        try {
          url = await this.minio.presignedGetUrl(bucket, r.url, 3600);
        } catch (err) {
          this.logger.warn(
            `presignedGetUrl skipped (${r.id}): ${(err as Error).message}`,
          );
        }
        return {
          id: r.id,
          url,
          mimeType: r.mimeType,
          sizeBytes: r.sizeBytes,
        };
      }),
    );
    return out;
  }

  /**
   * Single-row presigned URL (3600s TTL). Scope-asserted via the event.
   */
  async getSignedUrl(
    user: InstitutionScopedUser & { id: string },
    institutionId: string,
    readingHourId: string,
    mediaId: string,
  ): Promise<{ url: string; mimeType: string }> {
    await this._loadEventAndScope(user, institutionId, readingHourId);

    const row = await this.prisma.readingHourMedia.findUnique({
      where: { id: mediaId },
    });
    if (!row || row.readingHourId !== readingHourId) {
      throw new NotFoundException("Fayl topilmadi");
    }
    const bucket = this.minio.bucketReadingHours;
    const url = await this.minio.presignedGetUrl(bucket, row.url, 3600);
    return { url, mimeType: row.mimeType };
  }
}
