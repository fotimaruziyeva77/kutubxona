import { ConfigService } from "@nestjs/config";
import { FcmClient, InvalidFcmTokenError } from "./fcm.client";

// ── firebase-admin mock ─────────────────────────────────────────────────────
// Stub initializeApp + messaging() so the spec never reaches network. The
// shape mirrors firebase-admin's actual surface so the production code path
// is exercised without real credentials.

const mockSend: jest.Mock = jest.fn();
const mockMessaging: jest.Mock = jest.fn(() => ({ send: mockSend }));
const mockInitializeApp: jest.Mock = jest.fn(() => ({
  messaging: mockMessaging,
}));
const mockCert: jest.Mock = jest.fn((sa: unknown) => ({ _serviceAccount: sa }));

jest.mock("firebase-admin", () => ({
  initializeApp: (...args: unknown[]) => mockInitializeApp(...(args as [])),
  credential: {
    cert: (sa: unknown) => mockCert(sa),
  },
}));

// ── fs mock for reading the service-account JSON ────────────────────────────
const mockReadFileSync = jest.fn();
jest.mock("fs", () => ({
  readFileSync: (p: string, enc: string) => mockReadFileSync(p, enc),
}));

const makeConfig = (overrides: Record<string, string | undefined> = {}) => {
  const map: Record<string, string | undefined> = {
    FCM_SERVICE_ACCOUNT_KEY_PATH: "/tmp/fcm-sa.json",
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => map[key]),
  } as unknown as ConfigService;
};

describe("FcmClient", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockMessaging.mockClear();
    mockInitializeApp.mockClear();
    mockCert.mockClear();
    mockReadFileSync.mockReset();
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        project_id: "sifat-test",
        private_key: "PEM",
        client_email: "fcm@sifat-test.iam.gserviceaccount.com",
      }),
    );
  });

  describe("onModuleInit + dev no-op", () => {
    it("does NOT call initializeApp when FCM_SERVICE_ACCOUNT_KEY_PATH is unset and send() is a no-op", async () => {
      const client = new FcmClient(
        makeConfig({ FCM_SERVICE_ACCOUNT_KEY_PATH: undefined }),
      );
      client.onModuleInit();

      expect(mockInitializeApp).not.toHaveBeenCalled();

      // send() must NOT throw and NOT touch FCM
      await expect(
        client.sendToToken("dGVzdC10b2tlbi1tdXN0LXBhc3M", {
          title: "Hi",
          body: "Hello",
        }),
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("calls initializeApp with cert(serviceAccount) when env IS set", () => {
      const client = new FcmClient(makeConfig());
      client.onModuleInit();

      expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/fcm-sa.json", "utf-8");
      expect(mockCert).toHaveBeenCalledTimes(1);
      expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendToToken success path", () => {
    it("forwards token + notification to firebase-admin messaging().send", async () => {
      const client = new FcmClient(makeConfig());
      client.onModuleInit();

      mockSend.mockResolvedValueOnce("projects/test/messages/abc");

      await client.sendToToken("device-token-abcdef12345678", {
        title: "Title",
        body: "Body",
        data: { url: "/top" },
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith({
        token: "device-token-abcdef12345678",
        notification: { title: "Title", body: "Body" },
        data: { url: "/top" },
      });
    });
  });

  describe("InvalidFcmTokenError on dead token", () => {
    it("throws InvalidFcmTokenError when FCM returns registration-token-not-registered", async () => {
      const client = new FcmClient(makeConfig());
      client.onModuleInit();

      mockSend.mockRejectedValueOnce({
        errorInfo: { code: "messaging/registration-token-not-registered" },
        message: "Requested entity was not found.",
      });

      await expect(
        client.sendToToken("dead-token", { title: "x", body: "y" }),
      ).rejects.toBeInstanceOf(InvalidFcmTokenError);
    });

    it("throws InvalidFcmTokenError when FCM returns invalid-registration-token", async () => {
      const client = new FcmClient(makeConfig());
      client.onModuleInit();

      mockSend.mockRejectedValueOnce({
        errorInfo: { code: "messaging/invalid-registration-token" },
        message: "Invalid token format",
      });

      await expect(
        client.sendToToken("bad-token", { title: "x", body: "y" }),
      ).rejects.toBeInstanceOf(InvalidFcmTokenError);
    });

    it("rethrows non-dead-token errors as-is", async () => {
      const client = new FcmClient(makeConfig());
      client.onModuleInit();

      mockSend.mockRejectedValueOnce({
        errorInfo: { code: "messaging/server-unavailable" },
        message: "Service unavailable",
      });

      await expect(
        client.sendToToken("token", { title: "x", body: "y" }),
      ).rejects.not.toBeInstanceOf(InvalidFcmTokenError);
    });
  });

  describe("sendToTopic", () => {
    it("no-ops when env unset", async () => {
      const client = new FcmClient(
        makeConfig({ FCM_SERVICE_ACCOUNT_KEY_PATH: undefined }),
      );
      client.onModuleInit();

      await expect(
        client.sendToTopic("admin-alerts", { title: "x", body: "y" }),
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("forwards topic + notification to firebase-admin messaging().send", async () => {
      const client = new FcmClient(makeConfig());
      client.onModuleInit();

      mockSend.mockResolvedValueOnce("projects/test/messages/topic-1");

      await client.sendToTopic("admin-alerts", {
        title: "Alert",
        body: "Tuman RI dropped",
        data: { severity: "KRITIK" },
      });

      expect(mockSend).toHaveBeenCalledWith({
        topic: "admin-alerts",
        notification: { title: "Alert", body: "Tuman RI dropped" },
        data: { severity: "KRITIK" },
      });
    });
  });

  describe("InvalidFcmTokenError shape", () => {
    it("captures the offending token on the error instance", () => {
      const err = new InvalidFcmTokenError("the-bad-token");
      expect(err.token).toBe("the-bad-token");
      expect(err.name).toBe("InvalidFcmTokenError");
      expect(err.message).toMatch(/not registered/);
    });
  });
});
