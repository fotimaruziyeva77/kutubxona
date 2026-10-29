/**
 * StoreProductImportProcessor — Phase 8, Plan 08-01 (SHOP-01)
 *
 * BullMQ WorkerHost (concurrency 2) that drains STORE_PRODUCT_IMPORT_QUEUE.
 * Mirrors BookImportProcessor pattern exactly:
 *   - ExcelJS non-streaming reader (10MB cap enforced upstream by FileInterceptor)
 *   - BATCH_SIZE=100 rows per createMany flush
 *   - Per-row validation: ISBN, Title, Author, Price required
 *   - Progress tracking via job.updateProgress + job.updateData
 *   - Post-batch ES indexing (best-effort, no abort on failure)
 *
 * Expected Excel columns: ISBN, Title, Author, Genre, Price, StockCount
 */

import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Job } from "bullmq";
import * as ExcelJS from "exceljs";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { SearchService } from "../../infra/elasticsearch/elasticsearch.service";
import { STORE_PRODUCT_IMPORT_QUEUE } from "../../infra/queue/queue-names";
import type { StoreProductImportJobData } from "./dto/store.dto";

const BATCH_SIZE = 100;

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
  price: number;
  stockCount: number;
  storeId: string;
}

@Injectable()
@Processor(STORE_PRODUCT_IMPORT_QUEUE, { concurrency: 2 })
export class StoreProductImportProcessor extends WorkerHost {
  private readonly logger = new Logger(StoreProductImportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {
    super();
  }

  async process(job: Job<StoreProductImportJobData>): Promise<{
    processed: number;
    total: number;
    errors: RowError[];
  }> {
    const { fileBase64, storeId, operatorId } = job.data;

    if (!fileBase64 || !storeId) {
      throw new Error("Missing fileBase64 or storeId in STORE_PRODUCT_IMPORT job payload");
    }

    // Load store for ES indexing context
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) {
      throw new Error(`Store not found: ${storeId}`);
    }

    const buffer = Buffer.from(fileBase64, "base64");

    let processed = 0;
    let totalSeen = 0;
    const errors: RowError[] = [];

    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);

      const ws = wb.worksheets[0];
      if (!ws) throw new Error("Workbook has no worksheets");

      // Header row (row 1) -> column index map
      const header: Record<string, number> = {};
      const headerRow = ws.getRow(1);
      headerRow.eachCell((cell, colNumber) => {
        const key = String(cell.value ?? "").trim();
        if (key) header[key] = colNumber;
      });

      const rowCount = ws.actualRowCount;
      const dataRowCount = Math.max(0, rowCount - 1);

      const batch: ParsedRow[] = [];
      for (let r = 2; r <= rowCount; r++) {
        const row = ws.getRow(r);
        if (!row || !row.hasValues) continue;

        totalSeen++;
        const parsed = this._parseRow(row, header, storeId);
        if ("error" in parsed) {
          errors.push({ row: r, reason: parsed.error });
          continue;
        }
        batch.push(parsed);

        if (batch.length >= BATCH_SIZE) {
          processed += await this._flushBatch(batch, store);
          batch.length = 0;
          await this._reportProgress(job, dataRowCount, totalSeen, processed, errors);
        }
      }

      if (batch.length > 0) {
        processed += await this._flushBatch(batch, store);
        batch.length = 0;
      }
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `STORE_PRODUCT_IMPORT parse failure (job ${job.id}, store ${storeId}, operator ${operatorId}): ${message}`
      );
      await job.updateData({
        ...job.data,
        processed,
        total: totalSeen,
        errors: [...errors, { row: 0, reason: `Faylni o'qib bo'lmadi: ${message}` }],
      } as never);
      throw err;
    }

    await job.updateData({
      ...job.data,
      processed,
      total: totalSeen,
      errors,
    } as never);
    await job.updateProgress(100);

    this.logger.log(
      `STORE_PRODUCT_IMPORT done (job ${job.id}, store ${storeId}): ${processed} created, ${errors.length} errors`
    );

    return { processed, total: totalSeen, errors };
  }

  private _parseRow(
    row: ExcelJS.Row,
    header: Record<string, number>,
    storeId: string,
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

    const isbn = get("ISBN", "isbn");
    const title = get("Title", "Nomi", "title");
    const author = get("Author", "Muallif", "author");
    const genre = get("Genre", "Janr", "genre") || "Umumiy";
    const priceStr = get("Price", "Narx", "price");
    const stockStr = get("StockCount", "Soni", "stockCount", "count");

    if (!isbn || !title || !author) {
      return { error: "ISBN, Title va Author majburiy" };
    }

    const price = parseInt(priceStr || "0", 10);
    if (!price || price <= 0) {
      return { error: "Narx musbat son bo'lishi kerak" };
    }

    const stockCount = parseInt(stockStr || "0", 10);
    if (stockCount < 0) {
      return { error: "Mavjud soni manfiy bo'lishi mumkin emas" };
    }

    return {
      rowNum: row.number,
      isbn: isbn.replace(/[-\s]/g, ""),
      title,
      author,
      genre,
      price,
      stockCount: isNaN(stockCount) ? 0 : stockCount,
      storeId,
    };
  }

  private async _flushBatch(
    batch: ParsedRow[],
    store: { id: string; name: string; lat: number | null; lon: number | null; premiumBadge: boolean },
  ): Promise<number> {
    if (batch.length === 0) return 0;
    const data = batch.map((r) => ({
      storeId: r.storeId,
      isbn: r.isbn,
      title: r.title,
      author: r.author,
      genre: r.genre,
      price: r.price,
      stockCount: r.stockCount,
    }));

    const result = await this.prisma.storeProduct.createMany({
      data,
      skipDuplicates: true,
    });

    // Best-effort ES indexing after batch flush
    void this._bulkIndex(batch, store).catch((err) =>
      this.logger.warn(`Elasticsearch bulk-index skipped: ${(err as Error).message}`)
    );

    return result.count;
  }

  private async _bulkIndex(
    batch: ParsedRow[],
    store: { id: string; name: string; lat: number | null; lon: number | null; premiumBadge: boolean },
  ): Promise<void> {
    // Look up the actual Prisma product IDs so ES docs match CRUD-indexed docs
    const isbns = batch.map(r => r.isbn);
    const products = await this.prisma.storeProduct.findMany({
      where: { storeId: store.id, isbn: { in: isbns } },
      select: { id: true, isbn: true },
    });
    const isbnToId = new Map(products.map(p => [p.isbn, p.id]));

    for (const r of batch) {
      const productId = isbnToId.get(r.isbn);
      if (!productId) continue; // Skip if createMany didn't create it (e.g. duplicate)
      try {
        await this.search.indexStoreProduct({
          id: productId, // Use Prisma product ID to match CRUD indexing
          storeId: store.id,
          storeName: store.name,
          isbn: r.isbn,
          title: r.title,
          author: r.author,
          genre: r.genre,
          price: r.price,
          stockCount: r.stockCount,
          active: true,
          location: store.lat != null && store.lon != null ? { lat: store.lat, lon: store.lon } : undefined,
          premiumBadge: store.premiumBadge,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // Swallowed — fallback path handles search if ES is unavailable
      }
    }
  }

  private async _reportProgress(
    job: Job<StoreProductImportJobData>,
    knownTotal: number,
    totalSeen: number,
    processed: number,
    errors: RowError[],
  ): Promise<void> {
    await job.updateData({
      ...job.data,
      processed,
      total: knownTotal > 0 ? knownTotal : totalSeen,
      errors,
    } as never);
    const denom = knownTotal > 0 ? knownTotal : Math.max(totalSeen, 1);
    const pct = Math.min(99, Math.round((totalSeen / denom) * 100));
    await job.updateProgress(pct);
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<StoreProductImportJobData>, error: Error) {
    this.logger.error(
      `STORE_PRODUCT_IMPORT job failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${error.message}`,
      { jobId: job.id, storeId: job.data?.storeId },
    );
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<StoreProductImportJobData>) {
    this.logger.debug(`STORE_PRODUCT_IMPORT job completed: ${job.id}`);
  }
}
