/**
 * Plan 05-08 Task 2 (RPT-02) — ReportEmailProcessor contract.
 *
 * Plan 05-08-fix amendments:
 *   - FIX A (HIGH SEC): admin-fallback recipients (userId == null) collapse to
 *     a single per-scope NOTIFICATION_QUEUE job with `admin: true`.
 *   - FIX B (HIGH SEC): PDF attachments are base64 strings, not raw Buffers,
 *     and carry encoding:'base64' so they survive BullMQ's JSON envelope.
 */
import { Job, Queue } from "bullmq";
import { ReportEmailProcessor, ReportEmailJobData } from "../report-email.processor";
import { ReportDataService } from "../report-data.service";
import { PdfService } from "../../../infra/pdf/pdf.service";

describe("ReportEmailProcessor (Plan 05-08 RPT-02)", () => {
  const periodStart = new Date("2026-05-01T00:00:00Z").toISOString();
  const periodEnd = new Date("2026-06-01T00:00:00Z").toISOString();
  const PDF_BYTES = "PDF-CONTENTS";

  const makeReportData = (): jest.Mocked<Pick<ReportDataService, "gatherForScope">> => ({
    gatherForScope: jest.fn().mockResolvedValue({
      title: "Respublika oylik kitobxonlik hisoboti — May 2026",
      period: "May 2026",
      scopeLabel: "Respublika",
      tableRows: [{ label: "Foydalanuvchilar", value: "1,000" }],
      genderBuckets: [],
      ageBuckets: [],
      topLibraries: [],
      topReaders: [],
      generatedAt: new Date().toISOString(),
    }),
  });

  const makePdf = (): jest.Mocked<Pick<PdfService, "generateMonthlyReport" | "buildMonthlyReportHtml" | "generateFromHtml">> => ({
    generateMonthlyReport: jest.fn().mockResolvedValue(Buffer.from(PDF_BYTES)),
    buildMonthlyReportHtml: jest.fn().mockReturnValue("<html></html>"),
    generateFromHtml: jest.fn().mockResolvedValue(Buffer.from(PDF_BYTES)),
  });

  const makeQueue = (): jest.Mocked<Pick<Queue, "add">> => ({
    add: jest.fn().mockResolvedValue({ id: "queued-1" }),
  });

  const makeJob = (data: ReportEmailJobData): Job<ReportEmailJobData> =>
    ({ id: "j1", name: "monthly-report", data, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<ReportEmailJobData>);

  // ── Per-recipient enqueue path (userId set — trusted lookup) ──────────────

  it("renders the PDF and fans out one email per real-user recipient", async () => {
    const reportData = makeReportData();
    const pdf = makePdf();
    const queue = makeQueue();
    const processor = new ReportEmailProcessor(
      reportData as unknown as ReportDataService,
      pdf as unknown as PdfService,
      queue as unknown as Queue,
    );

    const result = await processor.process(
      makeJob({
        scope: "national",
        scopeId: null,
        periodStart,
        periodEnd,
        recipients: [
          { email: "a@example.com", userId: "u-1" },
          { email: "b@example.com", userId: "u-2" },
        ],
      }),
    );

    expect(reportData.gatherForScope).toHaveBeenCalledWith("national", null, expect.any(Date), expect.any(Date));
    expect(pdf.generateMonthlyReport).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(result.enqueuedEmails).toBe(2);

    const firstCall = (queue.add as jest.Mock).mock.calls[0];
    expect(firstCall[0]).toBe("monthly-report-email");
    expect(firstCall[1]).toMatchObject({
      type: "email",
      email: "a@example.com",
      subject: expect.stringContaining("Respublika oylik hisobot"),
      jobType: "monthly-report",
    });
    expect(firstCall[1].attachments).toHaveLength(1);
    expect(firstCall[1].attachments[0]).toMatchObject({
      filename: expect.stringMatching(/\.pdf$/),
      contentType: "application/pdf",
    });
  });

  it("skips when no recipients are provided", async () => {
    const reportData = makeReportData();
    const pdf = makePdf();
    const queue = makeQueue();
    const processor = new ReportEmailProcessor(
      reportData as unknown as ReportDataService,
      pdf as unknown as PdfService,
      queue as unknown as Queue,
    );

    const result = await processor.process(
      makeJob({
        scope: "viloyat",
        scopeId: "UZ-08",
        periodStart,
        periodEnd,
        recipients: [],
      }),
    );

    expect(result.enqueuedEmails).toBe(0);
    expect(reportData.gatherForScope).not.toHaveBeenCalled();
    expect(pdf.generateMonthlyReport).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("uses scope-specific subject + filename for viloyat report", async () => {
    const reportData = makeReportData();
    const pdf = makePdf();
    const queue = makeQueue();
    const processor = new ReportEmailProcessor(
      reportData as unknown as ReportDataService,
      pdf as unknown as PdfService,
      queue as unknown as Queue,
    );

    await processor.process(
      makeJob({
        scope: "viloyat",
        scopeId: "UZ-08",
        periodStart,
        periodEnd,
        recipients: [{ email: "admin@example.com", userId: "u-1" }],
      }),
    );

    expect(pdf.generateMonthlyReport).toHaveBeenCalledWith(
      expect.anything(),
      "viloyat",
      "UZ-08",
    );
    const payload = (queue.add as jest.Mock).mock.calls[0][1];
    expect(payload.subject).toContain("Viloyat oylik hisobot");
    expect(payload.attachments[0].filename).toMatch(/viloyat-UZ-08-2026-05\.pdf/);
  });

  it("uses deterministic jobId per recipient for dedupe", async () => {
    const reportData = makeReportData();
    const pdf = makePdf();
    const queue = makeQueue();
    const processor = new ReportEmailProcessor(
      reportData as unknown as ReportDataService,
      pdf as unknown as PdfService,
      queue as unknown as Queue,
    );

    await processor.process(
      makeJob({
        scope: "tuman",
        scopeId: "UZ-08-012",
        periodStart,
        periodEnd,
        recipients: [{ email: "x@example.com", userId: "u-1" }],
      }),
    );

    const opts = (queue.add as jest.Mock).mock.calls[0][2];
    expect(opts.jobId).toBe(
      // buildJobId() `:` ni `-` ga almashtiradi — BullMQ 5 qismli
      // nuqtali custom jobId'ni rad etadi va email umuman ketmasdi.
      "monthly-report-email-tuman-UZ-08-012-2026-05-x@example.com",
    );
  });

  // ── Plan 05-08-fix FIX A: admin-fallback collapse ─────────────────────────

  describe("FIX A: admin-fallback (userId == null) collapse to admin: true", () => {
    it("11 admin-fallback recipients → ONE per-scope NOTIFICATION_QUEUE job with admin: true", async () => {
      const reportData = makeReportData();
      const pdf = makePdf();
      const queue = makeQueue();
      const processor = new ReportEmailProcessor(
        reportData as unknown as ReportDataService,
        pdf as unknown as PdfService,
        queue as unknown as Queue,
      );

      // 11 entries — would have over-flowed the Plan 05-04 cap of 10 if the
      // old per-recipient loop ran. Now collapses to 1 job; NotificationProcessor
      // re-resolves via parseAdminFallbackEmails (cap enforced there).
      const recipients = Array.from({ length: 11 }, (_, i) => ({
        email: `admin${i}@sifat.uz`,
        userId: null,
      }));

      const result = await processor.process(
        makeJob({
          scope: "national",
          scopeId: null,
          periodStart,
          periodEnd,
          recipients,
        }),
      );

      // Exactly ONE per-scope enqueue (not 11).
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(result.enqueuedEmails).toBe(1);

      const payload = (queue.add as jest.Mock).mock.calls[0][1];
      expect(payload).toMatchObject({
        type: "email",
        admin: true,
        jobType: "monthly-report",
      });
      // CRITICAL: no `email` field — NotificationProcessor must NOT see a
      // per-recipient address and bypass its admin-fallback validation.
      expect(payload.email).toBeUndefined();

      // Deterministic admin-fallback jobId — survives REPORT_QUEUE retries.
      const opts = (queue.add as jest.Mock).mock.calls[0][2];
      expect(opts.jobId).toBe(
        "monthly-report-email-national-UZ-2026-05-admin-fallback",
      );
    });

    it("malformed env-CSV entries are dropped downstream — processor just hands off", async () => {
      // The processor itself does NOT validate addresses on the admin-fallback
      // path; that's NotificationProcessor's job (parseAdminFallbackEmails).
      // We assert: the processor passes the job through with admin: true so
      // the shared validator runs.
      const reportData = makeReportData();
      const pdf = makePdf();
      const queue = makeQueue();
      const processor = new ReportEmailProcessor(
        reportData as unknown as ReportDataService,
        pdf as unknown as PdfService,
        queue as unknown as Queue,
      );

      await processor.process(
        makeJob({
          scope: "tuman",
          scopeId: "UZ-08-012",
          periodStart,
          periodEnd,
          recipients: [{ email: "anything@sifat.uz", userId: null }],
        }),
      );

      expect(queue.add).toHaveBeenCalledTimes(1);
      const payload = (queue.add as jest.Mock).mock.calls[0][1];
      expect(payload.admin).toBe(true);
      expect(payload.email).toBeUndefined();
    });
  });

  // ── Plan 05-08-fix FIX B: PDF base64 round-trip ────────────────────────────

  describe("FIX B: PDF base64-encoded BEFORE enqueue (BullMQ JSON-safe)", () => {
    it("attachment content is a base64 string, encoding is 'base64'", async () => {
      const reportData = makeReportData();
      const pdf = makePdf();
      const queue = makeQueue();
      const processor = new ReportEmailProcessor(
        reportData as unknown as ReportDataService,
        pdf as unknown as PdfService,
        queue as unknown as Queue,
      );

      await processor.process(
        makeJob({
          scope: "national",
          scopeId: null,
          periodStart,
          periodEnd,
          recipients: [{ email: "x@example.com", userId: "u-1" }],
        }),
      );

      const payload = (queue.add as jest.Mock).mock.calls[0][1];
      const att = payload.attachments[0];

      // content must be a base64 STRING, never a raw Buffer (which would
      // serialize through BullMQ's JSON envelope as {type:'Buffer', data:[...]}
      // and then collapse to '[object Object]' inside nodemailer).
      expect(typeof att.content).toBe("string");
      expect(Buffer.isBuffer(att.content)).toBe(false);
      expect(att.encoding).toBe("base64");

      // Round-trip sanity: decoding back must reproduce the original PDF bytes.
      expect(Buffer.from(att.content as string, "base64").toString("utf8")).toBe(
        PDF_BYTES,
      );
    });

    it("BullMQ JSON envelope round-trip preserves content (no {type:'Buffer'} corruption)", async () => {
      const reportData = makeReportData();
      const pdf = makePdf();
      const queue = makeQueue();
      const processor = new ReportEmailProcessor(
        reportData as unknown as ReportDataService,
        pdf as unknown as PdfService,
        queue as unknown as Queue,
      );

      await processor.process(
        makeJob({
          scope: "viloyat",
          scopeId: "UZ-08",
          periodStart,
          periodEnd,
          recipients: [{ email: "v@example.com", userId: "u-1" }],
        }),
      );

      const payload = (queue.add as jest.Mock).mock.calls[0][1];
      // Simulate BullMQ persistence: JSON.stringify on enqueue, JSON.parse on
      // worker pull. If the producer enqueued a Buffer the parsed shape would
      // be {type:'Buffer', data:[...]}; with base64 it remains a string.
      const persisted = JSON.parse(JSON.stringify(payload));
      const att = persisted.attachments[0];
      expect(typeof att.content).toBe("string");
      expect(att.encoding).toBe("base64");
      // The corrupted shape — must NOT appear. (att.content is a string, so
      // toMatchObject would throw; assert via deep-equality on the JSON form.)
      expect(att.content).not.toEqual(
        expect.objectContaining({ type: "Buffer" }),
      );
      // Decoded bytes still match the original PDF.
      expect(Buffer.from(att.content, "base64").toString("utf8")).toBe(PDF_BYTES);
    });

    it("admin-fallback job also carries base64 attachment + encoding", async () => {
      const reportData = makeReportData();
      const pdf = makePdf();
      const queue = makeQueue();
      const processor = new ReportEmailProcessor(
        reportData as unknown as ReportDataService,
        pdf as unknown as PdfService,
        queue as unknown as Queue,
      );

      await processor.process(
        makeJob({
          scope: "national",
          scopeId: null,
          periodStart,
          periodEnd,
          recipients: [{ email: "fallback@sifat.uz", userId: null }],
        }),
      );

      const payload = (queue.add as jest.Mock).mock.calls[0][1];
      expect(payload.admin).toBe(true);
      const att = payload.attachments[0];
      expect(typeof att.content).toBe("string");
      expect(att.encoding).toBe("base64");
    });
  });
});
