import { ConfigService } from "@nestjs/config";
import { MailClient } from "./mail.client";

// ── nodemailer mock ─────────────────────────────────────────────────────────
const mockSendMail: jest.Mock = jest.fn();
const mockCreateTransport: jest.Mock = jest.fn(() => ({
  sendMail: mockSendMail,
}));

jest.mock("nodemailer", () => ({
  createTransport: (opts: unknown) => mockCreateTransport(opts),
}));

const makeConfig = (overrides: Record<string, string | undefined> = {}) => {
  const map: Record<string, string | undefined> = {
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "notifications@sifat.uz",
    SMTP_PASS: "smtp-pass",
    SMTP_FROM: "SIFAT LIBRARY <noreply@sifat.uz>",
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => map[key]),
  } as unknown as ConfigService;
};

describe("MailClient", () => {
  beforeEach(() => {
    mockSendMail.mockReset();
    mockCreateTransport.mockClear();
  });

  describe("onModuleInit + dev no-op", () => {
    it("does NOT create transporter when SMTP_HOST is unset", async () => {
      const client = new MailClient(makeConfig({ SMTP_HOST: undefined }));
      client.onModuleInit();

      expect(mockCreateTransport).not.toHaveBeenCalled();

      // send must NOT throw and NOT call sendMail
      await expect(
        client.send({
          to: "user@example.com",
          subject: "Hi",
          html: "<p>hi</p>",
        }),
      ).resolves.toBeUndefined();
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it("creates transporter when SMTP_HOST IS set, with auth from env", () => {
      const client = new MailClient(makeConfig());
      client.onModuleInit();

      expect(mockCreateTransport).toHaveBeenCalledTimes(1);
      const opts = mockCreateTransport.mock.calls[0][0] as {
        host: string;
        port: number;
        secure: boolean;
        auth: { user: string; pass: string };
      };
      expect(opts.host).toBe("smtp.example.com");
      expect(opts.port).toBe(587);
      expect(opts.secure).toBe(false);
      expect(opts.auth).toEqual({
        user: "notifications@sifat.uz",
        pass: "smtp-pass",
      });
    });

    it("honors SMTP_SECURE=true", () => {
      const client = new MailClient(makeConfig({ SMTP_SECURE: "true" }));
      client.onModuleInit();
      const opts = mockCreateTransport.mock.calls[0][0] as { secure: boolean };
      expect(opts.secure).toBe(true);
    });
  });

  describe("send success path", () => {
    it("calls transporter.sendMail with From/To/Subject/HTML", async () => {
      const client = new MailClient(makeConfig());
      client.onModuleInit();

      mockSendMail.mockResolvedValueOnce({ messageId: "<abc@smtp>" });

      await client.send({
        to: "user@example.com",
        subject: "Hello",
        html: "<p>Test</p>",
      });

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const payload = mockSendMail.mock.calls[0][0] as {
        from: string;
        to: string;
        subject: string;
        html: string;
      };
      expect(payload.from).toBe("SIFAT LIBRARY <noreply@sifat.uz>");
      expect(payload.to).toBe("user@example.com");
      expect(payload.subject).toBe("Hello");
      expect(payload.html).toBe("<p>Test</p>");
    });

    it("passes attachments through to nodemailer", async () => {
      const client = new MailClient(makeConfig());
      client.onModuleInit();
      mockSendMail.mockResolvedValueOnce({ messageId: "<x@y>" });

      await client.send({
        to: "user@example.com",
        subject: "Report",
        html: "<p>Report</p>",
        attachments: [
          {
            filename: "report.pdf",
            content: Buffer.from("PDF-DATA"),
            contentType: "application/pdf",
          },
        ],
      });

      const payload = mockSendMail.mock.calls[0][0] as {
        attachments: Array<{ filename: string }>;
      };
      expect(payload.attachments).toHaveLength(1);
      expect(payload.attachments[0].filename).toBe("report.pdf");
    });
  });

  describe("T-05-07 email header injection rejection", () => {
    it("throws when subject contains CR/LF", async () => {
      const client = new MailClient(makeConfig());
      client.onModuleInit();

      await expect(
        client.send({
          to: "user@example.com",
          subject: "Hello\r\nBcc: evil@attacker.tld",
          html: "<p>x</p>",
        }),
      ).rejects.toThrow(/header injection/i);
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it("throws when to contains CR/LF", async () => {
      const client = new MailClient(makeConfig());
      client.onModuleInit();

      await expect(
        client.send({
          to: "user@example.com\nBcc: evil@attacker.tld",
          subject: "Hi",
          html: "<p>x</p>",
        }),
      ).rejects.toThrow(/header injection/i);
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it("rejects malformed addresses (no @)", async () => {
      const client = new MailClient(makeConfig());
      client.onModuleInit();

      await expect(
        client.send({
          to: "not-an-email",
          subject: "Hi",
          html: "<p>x</p>",
        }),
      ).rejects.toThrow(/recipient/i);
    });

    it("dev no-op path also rejects CR/LF (defense in depth)", async () => {
      const client = new MailClient(makeConfig({ SMTP_HOST: undefined }));
      client.onModuleInit();

      await expect(
        client.send({
          to: "user@example.com",
          subject: "Hello\nBcc: evil@a.tld",
          html: "<p>x</p>",
        }),
      ).rejects.toThrow(/header injection/i);
    });
  });
});
