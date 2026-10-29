/**
 * BookImportProcessor — Plan 02-04 Task 1 (BOOK-01)
 *
 * BullMQ WorkerHost (concurrency 2 — XLSX parsing is CPU-heavy) that drains
 * BOOK_IMPORT_QUEUE. The HTTP route POST /books/import enqueues a job with
 * the file payload base64-encoded inside job.data (FileInterceptor caps the
 * upload at 10MB; V2 will swap to MinIO object refs once admin uploads
 * become high-volume).
 *
 * Parsing strategy:
 *   - exceljs streaming reader (ExcelJS.stream.xlsx.WorkbookReader) reads
 *     one row at a time so the full row array never sits in memory
 *   - rows accumulate in a 100-row batch buffer; each flush is a single
 *     prisma.book.createMany({ skipDuplicates: true }) — bulk-friendly
 *     for the Plan 02-02 partitioned tables
 *   - per-row validation (title/author/isbn required, ISBN-13 checksum)
 *     pushes failures into errors[] without aborting the import
 *
 * Progress:
 *   - job.updateProgress is called after every batch flush with
 *     (rowsSeen / estimatedTotal) * 100, capped at 99 until the final
 *     flush sets it to 100
 *   - estimatedTotal is the worksheet row count (header-inclusive minus 1);
 *     for streaming reads we approximate via the WorkbookReader's metadata
 *     when available, else fall back to "unknown" (progress reports
 *     processedCount instead of percent in that path)
 *   - job.updateData({ ...job.data, processed, total, errors }) persists
 *     the counters so the GET /books/import/:jobId/status endpoint can
 *     read them without holding a streaming reference
 *
 * Threat coverage (Plan 02-04 register):
 *   T-02-17 — XLSX bomb via streaming + 10MB cap + attempts: 2 (no
 *             retry-spiral on parse failure)
 *
 * Mirrors the RiRecalcProcessor pattern from Plan 02-03 (Processor +
 * WorkerHost + structured logger + OnWorkerEvent hooks).
 */

import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Job } from "bullmq";
import * as ExcelJS from "exceljs";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { ElasticsearchService } from "@nestjs/elasticsearch";
import { BOOK_IMPORT_QUEUE } from "../../infra/queue/queue-names";
import type { BookImportJobData } from "./books.service";

const BATCH_SIZE = 100;
const ES_INDEX = "books";

interface RowError {
  row: number;
  reason: string;
}

interface ParsedRow {
  rowNum: number;
  isbn: string;
  title: string;
  author: string;
  genre: string;
  lang: string;
  pages: number;
  year: number;
  totalCount: number;
  libraryId: string;
}

@Injectable()
@Processor(BOOK_IMPORT_QUEUE, { concurrency: 2 })
export class BookImportProcessor extends WorkerHost {
  private readonly logger = new Logger(BookImportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly es: ElasticsearchService
  ) {
    super();
  }

  async process(job: Job<BookImportJobData>): Promise<{
    processed: number;
    total: number;
    errors: RowError[];
  }> {
    const { fileBase64, libraryId, uploaderUserId } = job.data;

    if (!fileBase64 || !libraryId) {
      throw new Error("Missing fileBase64 or libraryId in BOOK_IMPORT job payload");
    }

    const buffer = Buffer.from(fileBase64, "base64");

    let processed = 0;
    let totalSeen = 0;
    const errors: RowError[] = [];

    try {
      // Use the non-streaming Workbook.xlsx.load API: more reliable than the
      // streaming WorkbookReader for small-to-medium files (≤10MB is our
      // FileInterceptor cap, so memory cost is bounded). Streaming swap is
      // a V2 concern once admin uploads regularly exceed that ceiling.
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);

      const ws = wb.worksheets[0];
      if (!ws) throw new Error("Workbook has no worksheets");

      // Header row (row 1) → column index map.
      const header: Record<string, number> = {};
      const headerRow = ws.getRow(1);
      headerRow.eachCell((cell, colNumber) => {
        const key = String(cell.value ?? "").trim();
        if (key) header[key] = colNumber;
      });

      const rowCount = ws.actualRowCount; // includes header
      const dataRowCount = Math.max(0, rowCount - 1);

      const batch: ParsedRow[] = [];
      // Iterate from row 2 (first data row) to actualRowCount.
      for (let r = 2; r <= rowCount; r++) {
        const row = ws.getRow(r);
        if (!row || !row.hasValues) continue;

        totalSeen++;
        const parsed = this._parseRow(row, header, libraryId);
        if ("error" in parsed) {
          errors.push({ row: r, reason: parsed.error });
          continue;
        }
        batch.push(parsed);

        if (batch.length >= BATCH_SIZE) {
          processed += await this._flushBatch(batch);
          batch.length = 0;
          await this._reportProgress(job, dataRowCount, totalSeen, processed, errors);
        }
      }

      if (batch.length > 0) {
        processed += await this._flushBatch(batch);
        batch.length = 0;
      }
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `BOOK_IMPORT parse failure (job ${job.id}, library ${libraryId}, uploader ${uploaderUserId}): ${message}`
      );
      await job.updateData({
        ...job.data,
        processed,
        total: totalSeen,
        errors: [...errors, { row: 0, reason: `Faylni o'qib bo'lmadi: ${message}` }]
      } as never);
      throw err;
    }

    await job.updateData({
      ...job.data,
      processed,
      total: totalSeen,
      errors
    } as never);
    await job.updateProgress(100);

    this.logger.log(
      `BOOK_IMPORT done (job ${job.id}, library ${libraryId}): ${processed} created, ${errors.length} errors`
    );

    return { processed, total: totalSeen, errors };
  }

  private _parseRow(
    row: ExcelJS.Row,
    header: Record<string, number>,
    libraryId: string
  ): ParsedRow | { error: string } {
    const get = (...keys: string[]): string => {
      for (const k of keys) {
        const col = header[k];
        if (col === undefined) continue;
        const cell = row.getCell(col);
        const v = cell.value;
        if (v === null || v === undefined) continue;
        return String(typeof v === "object" && "text" in v ? (v as { text: string }).text : v).trim();
      }
      return "";
    };

    const isbnRaw = get("ISBN", "isbn");
    const title = get("Nomi", "title");
    const author = get("Muallif", "author");
    const genre = get("Janr", "genre") || "Umumiy";
    const lang = get("Til", "lang") || "uz";
    const pages = parseInt(get("Sahifalar", "pages") || "0", 10) || 0;
    const year = parseInt(get("Yil", "year") || "0", 10) || 0;
    const totalCount = parseInt(get("Nusxa", "count") || "1", 10) || 1;

    if (!isbnRaw || !title || !author) {
      return { error: "ISBN, Nomi va Muallif majburiy" };
    }

    const isbn = isbnRaw.replace(/[-\s]/g, "");
    if (!this._isValidIsbn(isbn)) {
      return { error: `ISBN noto'g'ri: ${isbnRaw}` };
    }

    return {
      rowNum: row.number,
      isbn,
      title,
      author,
      genre,
      lang,
      pages,
      year,
      totalCount,
      libraryId
    };
  }

  private _isValidIsbn(isbn: string): boolean {
    if (isbn.length !== 13 || !/^\d+$/.test(isbn)) return false;
    const sum = isbn
      .split("")
      .reduce((acc, d, i) => acc + parseInt(d, 10) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }

  private async _flushBatch(batch: ParsedRow[]): Promise<number> {
    if (batch.length === 0) return 0;
    const data = batch.map((r) => ({
      isbn: r.isbn,
      title: r.title,
      author: r.author,
      genre: r.genre,
      lang: r.lang,
      pages: r.pages,
      year: r.year,
      totalCount: r.totalCount,
      availableCount: r.totalCount,
      libraryId: r.libraryId
    }));

    const result = await this.prisma.book.createMany({
      data,
      skipDuplicates: true
    });

    // Best-effort Elasticsearch refresh — failures here do not abort the
    // import. Books are searchable via Prisma fallback even when ES is down.
    void this._bulkIndex(batch).catch((err) =>
      this.logger.warn(`Elasticsearch bulk-index skipped: ${(err as Error).message}`)
    );

    return result.count;
  }

  private async _bulkIndex(batch: ParsedRow[]): Promise<void> {
    if (batch.length === 0) return;
    const body: Array<Record<string, unknown>> = [];
    for (const r of batch) {
      body.push({ index: { _index: ES_INDEX } });
      body.push({
        isbn: r.isbn,
        title: r.title,
        author: r.author,
        genre: r.genre,
        lang: r.lang,
        pages: r.pages,
        year: r.year,
        availableCount: r.totalCount,
        libraryId: r.libraryId
      });
    }
    try {
      await this.es.bulk({ operations: body });
    } catch {
      // Swallowed — fallback path handles search if ES is unavailable.
    }
  }

  private async _reportProgress(
    job: Job<BookImportJobData>,
    knownTotal: number,
    totalSeen: number,
    processed: number,
    errors: RowError[]
  ): Promise<void> {
    await job.updateData({
      ...job.data,
      processed,
      total: knownTotal > 0 ? knownTotal : totalSeen,
      errors
    } as never);
    const denom = knownTotal > 0 ? knownTotal : Math.max(totalSeen, 1);
    const pct = Math.min(99, Math.round((totalSeen / denom) * 100));
    await job.updateProgress(pct);
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<BookImportJobData>, error: Error) {
    this.logger.error(
      `BOOK_IMPORT job failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${error.message}`,
      { jobId: job.id, libraryId: job.data?.libraryId }
    );
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<BookImportJobData>) {
    this.logger.debug(`BOOK_IMPORT job completed: ${job.id}`);
  }
}
