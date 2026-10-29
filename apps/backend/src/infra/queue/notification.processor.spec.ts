import { Job } from "bullmq";
import { NotificationProcessor, NotificationJobData, maskPhone } from "./notification.processor";
import { EskizSmsClient } from "../sms/eskiz.client";
import { FcmClient, InvalidFcmTokenError } from "../notifications/fcm.client";
import { MailClient } from "../notifications/mail.client";
import { PrismaService } from "../prisma/prisma.service";

const makeEskiz = () =>
  ({
    sendSms: jest.fn().mockResolvedValue(undefined),
  }) as unknown as EskizSmsClient;

const makeFcm = () =>
  ({
    sendToToken: jest.fn().mockResolvedValue(undefined),
    sendToTopic: jest.fn().mockResolvedValue(undefined),
  }) as unknown as FcmClient;

const makeMail = () =>
  ({
    send: jest.fn().mockResolvedValue(undefined),
  }) as unknown as MailClient;

const makePrisma = () =>
  ({
    deviceToken: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // 05-04-fix FIX C — aiAuditLog.create stub for admin-fallback audit row.
    aiAuditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  }) as unknown as PrismaService;

const makeJob = (data: NotificationJobData): Job<NotificationJobData> =>
  ({
    id: "test-job-1",
    name: data.type === "sms" ? "otp-sms" : `${data.type}-job`,
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
  }) as unknown as Job<NotificationJobData>;

describe("NotificationProcessor", () => {
  // ── SMS routing (carry-over from Phase 1) ────────────────────────────────
  describe("sms job routing", () => {
    it("routes an sms job to EskizSmsClient.sendSms with phone + message", async () => {
      const eskiz = makeEskiz();
      const processor = new NotificationProcessor(eskiz, makeFcm(), makeMail(), makePrisma());

      const job = makeJob({
        type: "sms",
        phone: "+998901234567",
        message: "SIFAT: code 1234",
      });

      await processor.process(job);

      expect(eskiz.sendSms).toHaveBeenCalledTimes(1);
      expect(eskiz.sendSms).toHaveBeenCalledWith("+998901234567", "SIFAT: code 1234");
    });
  });

  describe("unknown job type", () => {
    it("throws on unknown notification type", async () => {
      const processor = new NotificationProcessor(makeEskiz(), makeFcm(), makeMail(), makePrisma());

      const job = makeJob({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: "fax" as any,
        message: "nope",
      });

      await expect(processor.process(job)).rejects.toThrow(/Noma'lum bildirishnoma turi/);
    });
  });

  // ── Plan 05-04 Task 1 — sendPush ─────────────────────────────────────────
  describe("sendPush (Plan 05-04 NOTIF-02)", () => {
    it("single-target: when deviceToken is set, calls fcm.sendToToken exactly once", async () => {
      const fcm = makeFcm();
      const prisma = makePrisma();
      const processor = new NotificationProcessor(makeEskiz(), fcm, makeMail(), prisma);

      await processor.process(
        makeJob({ type: "push", deviceToken: "tok-1", message: "hello" }),
      );

      expect(fcm.sendToToken).toHaveBeenCalledTimes(1);
      expect(fcm.sendToToken).toHaveBeenCalledWith(
        "tok-1",
        expect.objectContaining({ title: expect.any(String), body: "hello" }),
      );
      // deviceToken path never reads from device-token table.
      expect(prisma.deviceToken.findMany).not.toHaveBeenCalled();
    });

    it("user-fan-out: looks up tokens and pushes to each (top-10 by lastSeen DESC)", async () => {
      const fcm = makeFcm();
      const prisma = makePrisma();
      (prisma.deviceToken.findMany as jest.Mock).mockResolvedValue([
        { id: "dt1", token: "a" },
        { id: "dt2", token: "b" },
        { id: "dt3", token: "c" },
      ]);

      const processor = new NotificationProcessor(makeEskiz(), fcm, makeMail(), prisma);

      await processor.process(
        makeJob({ type: "push", userId: "u-1", message: "hi all" }),
      );

      expect(prisma.deviceToken.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "u-1" },
          orderBy: { lastSeen: "desc" },
          take: 10,
        }),
      );
      expect(fcm.sendToToken).toHaveBeenCalledTimes(3);
    });

    it("InvalidFcmTokenError: deletes the dead row and CONTINUES with remaining tokens", async () => {
      const fcm = makeFcm();
      const prisma = makePrisma();
      (prisma.deviceToken.findMany as jest.Mock).mockResolvedValue([
        { id: "dt1", token: "good-1" },
        { id: "dt2", token: "dead" },
        { id: "dt3", token: "good-2" },
      ]);
      (fcm.sendToToken as jest.Mock).mockImplementation(async (token: string) => {
        if (token === "dead") throw new InvalidFcmTokenError(token);
        return undefined;
      });

      const processor = new NotificationProcessor(makeEskiz(), fcm, makeMail(), prisma);

      await processor.process(
        makeJob({ type: "push", userId: "u-1", message: "hi" }),
      );

      // All 3 tokens were attempted — bad one didn't abort the loop.
      expect(fcm.sendToToken).toHaveBeenCalledTimes(3);
      // Dead row was deleted.
      expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { token: "dead" },
      });
    });

    it("bug-tolerant: no target (no deviceToken, no userId) logs warn and returns silently", async () => {
      const fcm = makeFcm();
      const prisma = makePrisma();
      const processor = new NotificationProcessor(makeEskiz(), fcm, makeMail(), prisma);

      await expect(
        processor.process(makeJob({ type: "push", message: "orphan" })),
      ).resolves.toBeUndefined();

      expect(fcm.sendToToken).not.toHaveBeenCalled();
      expect(prisma.deviceToken.findMany).not.toHaveBeenCalled();
    });

    it("generic error: when fcm.sendToToken throws non-InvalidFcmTokenError, the error re-throws", async () => {
      const fcm = makeFcm();
      (fcm.sendToToken as jest.Mock).mockRejectedValue(new Error("FCM service down"));
      const processor = new NotificationProcessor(makeEskiz(), fcm, makeMail(), makePrisma());

      await expect(
        processor.process(makeJob({ type: "push", deviceToken: "tok", message: "x" })),
      ).rejects.toThrow(/FCM service down/);
    });
  });

  // ── Plan 05-04 Task 2 — sendEmail ────────────────────────────────────────
  describe("sendEmail (Plan 05-04 NOTIF-03)", () => {
    it("calls mail.send with default subject + escaped body when neither subject nor html provided", async () => {
      const mail = makeMail();
      const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, makePrisma());

      await processor.process(
        makeJob({
          type: "email",
          email: "a@b.uz",
          message: "<script>x()</script>",
        }),
      );

      expect(mail.send).toHaveBeenCalledTimes(1);
      const args = (mail.send as jest.Mock).mock.calls[0][0];
      expect(args.to).toBe("a@b.uz");
      expect(args.subject).toBe("[SIFAT LIBRARY] Notification");
      // Default body wraps in <pre> + escapeHtml — script tag must be defanged.
      expect(args.html).toContain("&lt;script&gt;");
      expect(args.html).not.toContain("<script>");
    });

    it("uses caller-provided html AS-IS (no double escape)", async () => {
      const mail = makeMail();
      const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, makePrisma());

      await processor.process(
        makeJob({
          type: "email",
          email: "a@b.uz",
          message: "ignored",
          html: "<p>caller controlled</p>",
        }),
      );

      const args = (mail.send as jest.Mock).mock.calls[0][0];
      expect(args.html).toBe("<p>caller controlled</p>");
    });

    it("uses caller-provided subject when set (overrides default)", async () => {
      const mail = makeMail();
      const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, makePrisma());

      await processor.process(
        makeJob({
          type: "email",
          email: "a@b.uz",
          message: "hi",
          subject: "Custom Subject",
          jobType: "reminder",
        }),
      );

      expect((mail.send as jest.Mock).mock.calls[0][0].subject).toBe("Custom Subject");
    });

    it("subject default uses jobType when no subject is provided", async () => {
      const mail = makeMail();
      const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, makePrisma());

      await processor.process(
        makeJob({
          type: "email",
          email: "a@b.uz",
          message: "hi",
          jobType: "ri-monthly-report",
        }),
      );

      expect((mail.send as jest.Mock).mock.calls[0][0].subject).toBe(
        "[SIFAT LIBRARY] ri-monthly-report",
      );
    });

    it("passes attachments through unchanged", async () => {
      const mail = makeMail();
      const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, makePrisma());

      const attachments = [{ filename: "x.pdf", content: Buffer.from("") }];
      await processor.process(
        makeJob({
          type: "email",
          email: "a@b.uz",
          message: "hi",
          attachments,
        }),
      );

      const args = (mail.send as jest.Mock).mock.calls[0][0];
      expect(args.attachments).toEqual(attachments);
    });

    it("bug-tolerant: no recipient + no admin-fallback logs warn and returns silently", async () => {
      const mail = makeMail();
      const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, makePrisma());

      await expect(
        processor.process(makeJob({ type: "email", message: "orphan" })),
      ).resolves.toBeUndefined();
      expect(mail.send).not.toHaveBeenCalled();
    });

    it("admin fallback: broadcasts to ADMIN_NOTIFICATION_EMAILS CSV when admin flag set", async () => {
      const oldEnv = process.env.ADMIN_NOTIFICATION_EMAILS;
      process.env.ADMIN_NOTIFICATION_EMAILS = "ops@sifat.uz, alerts@sifat.uz";

      try {
        const mail = makeMail();
        const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, makePrisma());

        const data = {
          type: "email" as const,
          message: "new demo request",
          admin: true,
        };
        await processor.process(makeJob(data as NotificationJobData));

        expect(mail.send).toHaveBeenCalledTimes(2);
        const recipients = (mail.send as jest.Mock).mock.calls.map((c) => c[0].to);
        expect(recipients).toEqual(["ops@sifat.uz", "alerts@sifat.uz"]);
      } finally {
        process.env.ADMIN_NOTIFICATION_EMAILS = oldEnv;
      }
    });

    it("admin fallback: when ADMIN_NOTIFICATION_EMAILS is unset, logs warn and returns silently", async () => {
      const oldEnv = process.env.ADMIN_NOTIFICATION_EMAILS;
      delete process.env.ADMIN_NOTIFICATION_EMAILS;

      try {
        const mail = makeMail();
        const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, makePrisma());

        const data = { type: "email" as const, message: "no recipients", admin: true };
        await processor.process(makeJob(data as NotificationJobData));

        expect(mail.send).not.toHaveBeenCalled();
      } finally {
        if (oldEnv !== undefined) process.env.ADMIN_NOTIFICATION_EMAILS = oldEnv;
      }
    });

    // ── 05-04-fix FIX C — validation + cap + audit ────────────────────────
    describe("FIX C: admin-fallback hardening", () => {
      it("parses 'admin@foo.uz,not-an-email,b@b.com' → 2 valid sends, 1 dropped with warn", async () => {
        const oldEnv = process.env.ADMIN_NOTIFICATION_EMAILS;
        process.env.ADMIN_NOTIFICATION_EMAILS = "admin@foo.uz,not-an-email,b@b.com";

        try {
          const mail = makeMail();
          const prisma = makePrisma();
          const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, prisma);

          await processor.process(
            makeJob({ type: "email", message: "test", admin: true } as NotificationJobData),
          );

          // Only the 2 valid entries got mail.send. The bare 'not-an-email' is dropped.
          expect(mail.send).toHaveBeenCalledTimes(2);
          const recipients = (mail.send as jest.Mock).mock.calls.map((c) => c[0].to);
          expect(recipients).toEqual(["admin@foo.uz", "b@b.com"]);
        } finally {
          if (oldEnv !== undefined) process.env.ADMIN_NOTIFICATION_EMAILS = oldEnv;
          else delete process.env.ADMIN_NOTIFICATION_EMAILS;
        }
      });

      it("caps at 10 — 11 valid entries → only 10 sent + warning", async () => {
        const oldEnv = process.env.ADMIN_NOTIFICATION_EMAILS;
        const addrs = Array.from({ length: 11 }, (_, i) => `a${i}@sifat.uz`).join(",");
        process.env.ADMIN_NOTIFICATION_EMAILS = addrs;

        try {
          const mail = makeMail();
          const prisma = makePrisma();
          const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, prisma);

          await processor.process(
            makeJob({ type: "email", message: "test", admin: true } as NotificationJobData),
          );

          // Cap enforced — only the first 10 are dispatched.
          expect(mail.send).toHaveBeenCalledTimes(10);
        } finally {
          if (oldEnv !== undefined) process.env.ADMIN_NOTIFICATION_EMAILS = oldEnv;
          else delete process.env.ADMIN_NOTIFICATION_EMAILS;
        }
      });

      it("audit: writes ADMIN_NOTIFICATION_FALLBACK aiAuditLog row on dispatch", async () => {
        const oldEnv = process.env.ADMIN_NOTIFICATION_EMAILS;
        process.env.ADMIN_NOTIFICATION_EMAILS = "ops@sifat.uz";

        try {
          const mail = makeMail();
          const prisma = makePrisma();
          const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, prisma);

          await processor.process(
            makeJob({
              type: "email",
              message: "demo request",
              admin: true,
              subject: "[SIFAT] Demo",
            } as NotificationJobData),
          );

          // Wait one tick for the fire-and-forget audit promise.
          await new Promise((r) => setImmediate(r));

          expect(prisma.aiAuditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({
                issueType: "ADMIN_NOTIFICATION_FALLBACK",
                scope: "SYSTEM",
              }),
            }),
          );
          // PII protection — body must NOT be in the audit analysis field.
          const auditArg = (prisma.aiAuditLog.create as jest.Mock).mock.calls[0][0];
          expect(auditArg.data.analysis).not.toContain("demo request");
          // Subject IS allowed (not PII).
          expect(auditArg.data.analysis).toContain("[SIFAT] Demo");
        } finally {
          if (oldEnv !== undefined) process.env.ADMIN_NOTIFICATION_EMAILS = oldEnv;
          else delete process.env.ADMIN_NOTIFICATION_EMAILS;
        }
      });

      it("all entries invalid → no mail.send, warn-only", async () => {
        const oldEnv = process.env.ADMIN_NOTIFICATION_EMAILS;
        process.env.ADMIN_NOTIFICATION_EMAILS = "garbage,more-garbage";

        try {
          const mail = makeMail();
          const processor = new NotificationProcessor(makeEskiz(), makeFcm(), mail, makePrisma());

          await processor.process(
            makeJob({ type: "email", message: "x", admin: true } as NotificationJobData),
          );

          expect(mail.send).not.toHaveBeenCalled();
        } finally {
          if (oldEnv !== undefined) process.env.ADMIN_NOTIFICATION_EMAILS = oldEnv;
          else delete process.env.ADMIN_NOTIFICATION_EMAILS;
        }
      });
    });
  });

  // ── H5 fix — log redaction (OTP/PII loglarga chiqmasligi) ────────────────
  describe("H5: log redaction", () => {
    const OTP_SMS_MESSAGE =
      "SIFAT LIBRARY: Tasdiqlash kodingiz: 482913. Muddati 2 daqiqa. Hech kimga bermang!";

    it("maskPhone: +998901234567 → +99890***4567; qisqa/bo'sh qiymatlar to'liq yashiriladi", () => {
      expect(maskPhone("+998901234567")).toBe("+99890***4567");
      expect(maskPhone(undefined)).toBe("-");
      expect(maskPhone("")).toBe("-");
      // 12 belgidan qisqa raqamlarda prefix+suffix ustma-ust tushib raqamni
      // oshkor qilmasligi uchun to'liq maskalanadi.
      expect(maskPhone("12345678")).toBe("***");
    });

    it("success log: SMS message matni va OTP kod LOG GA CHIQMAYDI, telefon maskalanadi", async () => {
      const processor = new NotificationProcessor(makeEskiz(), makeFcm(), makeMail(), makePrisma());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logSpy = jest.spyOn((processor as any).logger, "log").mockImplementation(() => undefined);

      await processor.process(
        makeJob({ type: "sms", phone: "+998901234567", message: OTP_SMS_MESSAGE }),
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = String(logSpy.mock.calls[0][0]);
      // OTP kod va SMS matni yo'q
      expect(logged).not.toContain("482913");
      expect(logged).not.toContain("Tasdiqlash kodingiz");
      // To'liq telefon yo'q, maskalangan shakl bor
      expect(logged).not.toContain("+998901234567");
      expect(logged).toContain("+99890***4567");
      // Metadata bor: tur, job nomi, id
      expect(logged).toContain("[sms]");
      expect(logged).toContain("otp-sms");
      expect(logged).toContain("test-job-1");
    });

    it("onFailed: job.data LOG QILINMAYDI — faqat jobId/name/type + maskalangan telefon", () => {
      const processor = new NotificationProcessor(makeEskiz(), makeFcm(), makeMail(), makePrisma());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorSpy = jest.spyOn((processor as any).logger, "error").mockImplementation(() => undefined);

      const job = makeJob({ type: "sms", phone: "+998901234567", message: OTP_SMS_MESSAGE });
      processor.onFailed(job, new Error("Eskiz 500"));

      expect(errorSpy).toHaveBeenCalled();
      const [msg, meta] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      // Birinchi argument matnida OTP/telefon yo'q
      expect(String(msg)).not.toContain("482913");
      expect(String(msg)).not.toContain("+998901234567");
      // Metadata obyektida data/message YO'Q, telefon maskalangan
      expect(meta).not.toHaveProperty("data");
      expect(meta).not.toHaveProperty("message");
      expect(meta).toEqual(
        expect.objectContaining({
          jobId: "test-job-1",
          name: "otp-sms",
          type: "sms",
          phone: "+99890***4567",
        }),
      );
      // Butun metadata serializatsiyasida ham OTP kod uchramasligi kerak
      expect(JSON.stringify(meta)).not.toContain("482913");
      expect(JSON.stringify(meta)).not.toContain("Tasdiqlash kodingiz");
    });
  });
});
