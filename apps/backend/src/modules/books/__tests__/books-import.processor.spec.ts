/**
 * BookImportProcessor spec (Plan 02-04 Task 1 / BOOK-01)
 *
 * Asserts the streaming XLSX worker:
 *  (a) parses a real ExcelJS-generated workbook,
 *  (b) validates rows (ISBN-13 checksum + required-field check),
 *  (c) flushes batches via prisma.book.createMany({ skipDuplicates: true }),
 *  (d) reports progress + final state via job.updateProgress + updateData,
 *  (e) records errors[] without aborting the whole import,
 *  (f) propagates parse failures (malformed payload) so BullMQ retries.
 */

import * as ExcelJS from "exceljs";
import { BookImportProcessor } from "../books-import.processor";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { ElasticsearchService } from "@nestjs/elasticsearch";
import type { Job } from "bullmq";
import type { BookImportJobData } from "../books.service";

/** Build a real .xlsx buffer via ExcelJS (mirrors prod parser API). */
async function makeExcelBuffer(
  rows: Array<Record<string, string | number>>
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    ws.addRow(headers);
    for (const r of rows) {
      ws.addRow(headers.map((h) => r[h]));
    }
  }
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

function makeJob(buffer: Buffer, libraryId = "lib1"): Job<BookImportJobData> {
  const progressCalls: number[] = [];
  const updates: Array<Partial<BookImportJobData & {
    processed: number;
    total: number;
    errors: { row: number; reason: string }[];
  }>> = [];

  const data: BookImportJobData = {
    libraryId,
    uploaderUserId: "u1",
    fileBase64: buffer.toString("base64")
  };

  const job = {
    id: "test-job",
    data,
    opts: { attempts: 2 },
    attemptsMade: 0,
    updateProgress: jest.fn(async (n: number) => {
      progressCalls.push(n);
    }),
    updateData: jest.fn(async (next: never) => {
      updates.push(next as never);
      Object.assign(job.data as object, next as object);
    })
  } as unknown as Job<BookImportJobData> & {
    _progressCalls: number[];
    _updates: typeof updates;
  };

  (job as unknown as { _progressCalls: number[] })._progressCalls = progressCalls;
  (job as unknown as { _updates: typeof updates })._updates = updates;
  return job;
}

const mockPrisma = {
  book: {
    createMany: jest.fn().mockResolvedValue({ count: 0 })
  }
} as unknown as PrismaService;

const mockEs = {
  bulk: jest.fn().mockResolvedValue({})
} as unknown as ElasticsearchService;

describe("BookImportProcessor", () => {
  let processor: BookImportProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.book.createMany as jest.Mock).mockImplementation((args: { data: unknown[] }) =>
      Promise.resolve({ count: args.data.length })
    );
    processor = new BookImportProcessor(mockPrisma, mockEs);
  });

  it("parses a valid 3-row XLSX and creates books via createMany", async () => {
    const buf = await makeExcelBuffer([
      { ISBN: "9789943452787", Nomi: "Alpomish", Muallif: "Xalq dostoni", Janr: "Epik", Til: "uz", Sahifalar: 320, Yil: 2020, Nusxa: 3 },
      { ISBN: "9783161484100", Nomi: "Test 2", Muallif: "Author 2", Janr: "Roman", Til: "uz", Sahifalar: 200, Yil: 2021, Nusxa: 1 },
      { ISBN: "9780306406157", Nomi: "Test 3", Muallif: "Author 3", Janr: "Ilmiy", Til: "uz", Sahifalar: 150, Yil: 2022, Nusxa: 2 }
    ]);
    const job = makeJob(buf);

    const result = await processor.process(job);

    expect(result.processed).toBe(3);
    expect(result.total).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(mockPrisma.book.createMany).toHaveBeenCalledTimes(1);
    const args = (mockPrisma.book.createMany as jest.Mock).mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(3);
    expect(args.data[0].libraryId).toBe("lib1");
  });

  it("collects per-row errors without aborting (invalid ISBN, missing fields)", async () => {
    const buf = await makeExcelBuffer([
      { ISBN: "9789943452787", Nomi: "Alpomish", Muallif: "Xalq dostoni", Janr: "Epik" },
      { ISBN: "1111111111111", Nomi: "Bad ISBN", Muallif: "X", Janr: "Y" },
      { ISBN: "", Nomi: "", Muallif: "", Janr: "" }
    ]);
    const job = makeJob(buf);

    const result = await processor.process(job);

    expect(result.processed).toBe(1); // only the first row is valid
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].reason).toMatch(/noto'g'ri|majburiy/);
  });

  it("reports final progress 100 + persists processed/total/errors via updateData", async () => {
    const buf = await makeExcelBuffer([
      { ISBN: "9789943452787", Nomi: "Alpomish", Muallif: "Xalq dostoni", Janr: "Epik" },
      { ISBN: "9783161484100", Nomi: "Test 2", Muallif: "Author 2", Janr: "Roman" }
    ]);
    const job = makeJob(buf);

    await processor.process(job);

    const progressCalls = (job as unknown as { _progressCalls: number[] })._progressCalls;
    expect(progressCalls[progressCalls.length - 1]).toBe(100);
    expect(job.updateData).toHaveBeenCalled();
    const lastUpdate = (job.updateData as jest.Mock).mock.calls.slice(-1)[0][0];
    expect(lastUpdate.processed).toBe(2);
    expect(lastUpdate.total).toBe(2);
    expect(lastUpdate.errors).toEqual([]);
  });

  it("throws on a malformed payload (corrupt buffer) so BullMQ honors retries", async () => {
    const corrupt = Buffer.from("not-a-real-xlsx-file");
    const job = makeJob(corrupt);

    await expect(processor.process(job)).rejects.toThrow();
    // updateData was called with the failure context so the status endpoint
    // can surface "failed" without losing the partial errors[] array.
    expect(job.updateData).toHaveBeenCalled();
    const lastUpdate = (job.updateData as jest.Mock).mock.calls.slice(-1)[0][0];
    expect(lastUpdate.errors.some((e: { row: number; reason: string }) =>
      /Faylni o'qib bo'lmadi/.test(e.reason)
    )).toBe(true);
  });

  it("rejects when job payload is missing libraryId or fileBase64", async () => {
    const badJob = {
      id: "bad",
      data: { libraryId: "", uploaderUserId: "u1", fileBase64: "" },
      opts: { attempts: 2 },
      attemptsMade: 0,
      updateProgress: jest.fn(),
      updateData: jest.fn()
    } as unknown as Job<BookImportJobData>;

    await expect(processor.process(badJob)).rejects.toThrow(/Missing/);
  });
});
