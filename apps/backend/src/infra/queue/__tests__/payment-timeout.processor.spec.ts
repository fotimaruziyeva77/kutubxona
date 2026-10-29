import { PaymentTimeoutProcessor } from "../payment-timeout.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { Job } from "bullmq";

// Plan 04-02 PAY-04 — PaymentTimeoutProcessor spec.
// Covers the 4 status branches + double-fire safety per plan.

describe("PaymentTimeoutProcessor", () => {
  let processor: PaymentTimeoutProcessor;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = {
      payment: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      aiAuditLog: {
        create: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
    } as unknown as PrismaService;

    processor = new PaymentTimeoutProcessor(prisma);
  });

  const makeJob = (paymentId: string, provider = "PAYME"): Job<any> =>
    ({
      data: { paymentId, provider },
      id: `payment-timeout:${paymentId}`,
    }) as unknown as Job<any>;

  it("PENDING payment → flips to FAILED inside $transaction + writes TIMEOUT audit log", async () => {
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
      id: "pay-1",
      status: "PENDING",
    });

    await processor.process(makeJob("pay-1"));

    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    // FIX B4 — the where clause now includes status: PENDING so the update
    // is atomic with the race-check (P2025 on mismatch).
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: "pay-1", status: "PENDING" },
      data: { status: "FAILED" },
    });
    expect(prisma.aiAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: "payment",
          scopeId: "pay-1",
          issueType: "TIMEOUT",
          severity: "MEDIUM",
        }),
      }),
    );
    const auditCall = (prisma.aiAuditLog.create as jest.Mock).mock.calls[0][0];
    const parsed = JSON.parse(auditCall.data.analysis);
    expect(parsed).toMatchObject({
      provider: "PAYME",
      age_hours: 12,
      by: "SYSTEM_TIMEOUT",
    });
  });

  it("PAID payment → no-op (status guard short-circuits)", async () => {
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
      id: "pay-1",
      status: "PAID",
    });

    await processor.process(makeJob("pay-1"));

    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.aiAuditLog.create).not.toHaveBeenCalled();
  });

  it("FAILED payment → no-op (double-fire safety)", async () => {
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
      id: "pay-1",
      status: "FAILED",
    });

    await processor.process(makeJob("pay-1"));

    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it("REFUNDED payment → no-op", async () => {
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
      id: "pay-1",
      status: "REFUNDED",
    });

    await processor.process(makeJob("pay-1"));

    expect((prisma as any).$transaction).not.toHaveBeenCalled();
  });

  it("missing payment row → no-op + warn log (no throw)", async () => {
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(processor.process(makeJob("pay-deleted"))).resolves.toBeUndefined();
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
  });

  it("processor is idempotent — second fire after success is no-op", async () => {
    // First fire: PENDING → FAILED
    (prisma.payment.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "pay-1",
      status: "PENDING",
    });
    await processor.process(makeJob("pay-1"));
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);

    // Second fire: status now FAILED → no-op
    (prisma.payment.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "pay-1",
      status: "FAILED",
    });
    await processor.process(makeJob("pay-1"));
    // Still only one $transaction call from the first fire
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
  });

  it("forwards provider name from job data to audit log", async () => {
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
      id: "pay-2",
      status: "PENDING",
    });

    await processor.process(makeJob("pay-2", "CLICK"));

    const auditCall = (prisma.aiAuditLog.create as jest.Mock).mock.calls[0][0];
    const parsed = JSON.parse(auditCall.data.analysis);
    expect(parsed.provider).toBe("CLICK");
  });

  // ── Plan 04-02 audit-fix FIX B4 — conditional update closes race window ───
  // Between the findUnique that reads PENDING and the update that flips to
  // FAILED, a webhook can settle the payment as PAID. The where clause must
  // include status: PENDING so Prisma throws P2025 (record-not-found) when
  // the row no longer matches — the processor catches that as a race-safe
  // no-op and skips the audit log.
  describe("FIX B4 — conditional update closes race between read and write", () => {
    it("status changed PENDING → PAID between findUnique and update is race-safe no-op", async () => {
      // Pre-update read sees PENDING (proceeds past status guard)
      (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: "PENDING",
      });
      // Update with where: { id, status: PENDING } fails because status is
      // now PAID — Prisma raises P2025.
      const p2025 = Object.assign(new Error("Record to update not found."), {
        code: "P2025",
      });
      (prisma.payment.update as jest.Mock).mockRejectedValueOnce(p2025);

      await expect(processor.process(makeJob("pay-1"))).resolves.toBeUndefined();

      // Audit log MUST NOT be written when the race-safe path runs.
      expect(prisma.aiAuditLog.create).not.toHaveBeenCalled();
    });

    it("update where-clause includes status: PENDING (atomic conditional)", async () => {
      (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
        id: "pay-2",
        status: "PENDING",
      });
      (prisma.payment.update as jest.Mock).mockResolvedValue({});

      await processor.process(makeJob("pay-2"));

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "pay-2",
            status: "PENDING",
          }),
          data: expect.objectContaining({ status: "FAILED" }),
        }),
      );
      // Audit log written when conditional update succeeds.
      expect(prisma.aiAuditLog.create).toHaveBeenCalledTimes(1);
    });

    it("non-P2025 errors during update still propagate (real DB issues are not swallowed)", async () => {
      (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
        id: "pay-3",
        status: "PENDING",
      });
      const dbErr = Object.assign(new Error("connection refused"), {
        code: "P1001",
      });
      (prisma.payment.update as jest.Mock).mockRejectedValueOnce(dbErr);

      await expect(processor.process(makeJob("pay-3"))).rejects.toThrow(
        "connection refused",
      );
    });
  });
});
