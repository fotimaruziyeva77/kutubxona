import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { StatsGateway, STATS_ROOM_KEYS } from "../stats.gateway";

/**
 * Plan 05-07 Task 1 — StatsGateway extensions spec (STAT-01/02 + ALERT-01/02)
 * + AUDIT FIX C7 — WebSocket handshake auth + room ACL.
 *
 * Pins these contracts:
 *   1. `emitStatsRefresh(scope, scopeId, payload)` broadcasts on the
 *      room shape `stats:<scope>:<id>` with event `stats:refresh`.
 *   2. `emitTumanAlerted(tumanId, viloyatId, payload)` broadcasts on
 *      `tuman:<id>` (always) + `viloyat:<id>` (when viloyatId provided),
 *      with event `alert:new` (matches Phase 3 emitNewAlert wire format).
 *   3. The `subscribe` handler validates room name shapes and rejects
 *      injection attempts.
 *   4. C7 ACL: anonymous sockets can join ONLY public rooms (national,
 *      top100:YYYY-MM, stats:*). `alerts` + legacy region rooms require an
 *      admin-tier JWT; `user:{id}` requires own sub or admin-tier;
 *      `library:{id}` requires library-staff roles.
 *
 * The Redis adapter (afterInit) is NOT exercised here — that path is
 * production-only and indirectly covered by Phase 1 INFRA-07 tests.
 */

type EmitCall = { room: string; event: string; payload: unknown };

// ── JWT fixture'lar (C7) ────────────────────────────────────────────────────
const TOKENS: Record<string, { sub: string; role: string }> = {
  "super-admin-token": { sub: "admin-1", role: "SUPER_ADMIN" },
  "viloyat-admin-token": { sub: "vadmin-1", role: "VILOYAT_ADMIN" },
  "tuman-admin-token": { sub: "tadmin-1", role: "TUMAN_ADMIN" },
  "muassasa-admin-token": { sub: "madmin-1", role: "MUASSASA_ADMIN" },
  "librarian-token": { sub: "lib-9", role: "KUTUBXONACHI" },
  "reader-token": { sub: "user-77", role: "KITOBXON" },
};

const makeJwt = () =>
  ({
    verify: jest.fn((token: string) => {
      const payload = TOKENS[token];
      if (!payload) throw new Error("invalid token");
      return payload;
    }),
  }) as unknown as JwtService;

const makeConfig = () =>
  ({ get: jest.fn(() => "test-jwt-secret") }) as unknown as ConfigService;

const makeGateway = () => new StatsGateway(makeJwt(), makeConfig());

const makeServer = () => {
  const emits: EmitCall[] = [];
  const server = {
    to: jest.fn((room: string) => ({
      emit: jest.fn((event: string, payload: unknown) => {
        emits.push({ room, event, payload });
      }),
    })),
  };
  return { server, emits };
};

const makeClient = (token?: string) => {
  const joined: string[] = [];
  return {
    id: "client-1",
    data: {} as Record<string, unknown>,
    handshake: { auth: token ? { token } : {}, headers: {} as Record<string, string> },
    join: jest.fn((room: string) => joined.push(room)),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    joined,
  };
};

/** handleConnection orqali ulangan (auth qilingan/anonim) client yaratadi. */
const connectClient = (gateway: StatsGateway, token?: string) => {
  const client = makeClient(token);
  gateway.handleConnection(client as never);
  return client;
};

describe("StatsGateway (Plan 05-07 T1)", () => {
  let gateway: StatsGateway;
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    gateway = makeGateway();
    server = makeServer();
    (gateway as unknown as { server: unknown }).server = server.server as never;
  });

  describe("STATS_ROOM_KEYS namespace", () => {
    it("exports namespaced room key builders for all 4 scopes", () => {
      expect(STATS_ROOM_KEYS.national()).toBe("stats:national:UZ");
      expect(STATS_ROOM_KEYS.national("UZ")).toBe("stats:national:UZ");
      expect(STATS_ROOM_KEYS.viloyat("UZ-08")).toBe("stats:viloyat:UZ-08");
      expect(STATS_ROOM_KEYS.tuman("UZ-08-012")).toBe("stats:tuman:UZ-08-012");
      expect(STATS_ROOM_KEYS.mahalla("UZ-08-012-0045")).toBe(
        "stats:mahalla:UZ-08-012-0045",
      );
    });
  });

  describe("emitStatsRefresh", () => {
    it("broadcasts to the national room when scope='national'", () => {
      const payload = { users: { total: 5_000_000 } };
      gateway.emitStatsRefresh("national", "UZ", payload);

      expect(server.server.to).toHaveBeenCalledWith("stats:national:UZ");
      expect(server.emits).toHaveLength(1);
      expect(server.emits[0]).toMatchObject({
        room: "stats:national:UZ",
        event: "stats:refresh",
      });
      expect(server.emits[0].payload).toMatchObject({
        scope: "national",
        scopeId: "UZ",
        payload,
      });
      expect((server.emits[0].payload as { timestamp: string }).timestamp).toEqual(
        expect.any(String),
      );
    });

    it("broadcasts to the viloyat room when scope='viloyat'", () => {
      gateway.emitStatsRefresh("viloyat", "UZ-08", { readingIndex: 67.3 });
      expect(server.server.to).toHaveBeenCalledWith("stats:viloyat:UZ-08");
      expect(server.emits[0].event).toBe("stats:refresh");
    });

    it("broadcasts to the tuman room when scope='tuman'", () => {
      gateway.emitStatsRefresh("tuman", "UZ-08-012", { readingIndex: 78.1 });
      expect(server.server.to).toHaveBeenCalledWith("stats:tuman:UZ-08-012");
    });

    it("broadcasts to the mahalla room when scope='mahalla'", () => {
      gateway.emitStatsRefresh("mahalla", "UZ-08-012-0045", { users: 230 });
      expect(server.server.to).toHaveBeenCalledWith(
        "stats:mahalla:UZ-08-012-0045",
      );
    });
  });

  describe("emitTumanAlerted", () => {
    it("broadcasts to BOTH tuman and viloyat rooms when viloyatId provided", () => {
      const alert = { issueType: "LIBRARY_INACTIVE", severity: "CRITICAL" };
      gateway.emitTumanAlerted("UZ-08-012", "UZ-08", alert);

      expect(server.server.to).toHaveBeenCalledTimes(2);
      const rooms = server.emits.map((e) => e.room);
      expect(rooms).toEqual(
        expect.arrayContaining(["tuman:UZ-08-012", "viloyat:UZ-08"]),
      );
      for (const emit of server.emits) {
        expect(emit.event).toBe("alert:new");
        expect(emit.payload).toMatchObject({ data: alert });
      }
    });

    it("broadcasts ONLY to the tuman room when viloyatId is null", () => {
      gateway.emitTumanAlerted("UZ-08-012", null, { issueType: "RI_DROPPED" });
      expect(server.server.to).toHaveBeenCalledTimes(1);
      expect(server.emits).toHaveLength(1);
      expect(server.emits[0].room).toBe("tuman:UZ-08-012");
    });

    it("payload carries timestamp ISO string", () => {
      gateway.emitTumanAlerted("UZ-08-012", "UZ-08", { id: "a1" });
      const ts = (server.emits[0].payload as { ts: string }).ts;
      expect(typeof ts).toBe("string");
      expect(new Date(ts).toString()).not.toBe("Invalid Date");
    });
  });

  describe("subscribe handler — extended room validation", () => {
    it("accepts stats:national:UZ", async () => {
      const client = makeClient();
      await gateway.handleSubscribe(client as never, { room: "stats:national:UZ" });
      expect(client.joined).toContain("stats:national:UZ");
    });

    it("accepts stats:viloyat:UZ-08", async () => {
      const client = makeClient();
      await gateway.handleSubscribe(client as never, { room: "stats:viloyat:UZ-08" });
      expect(client.joined).toContain("stats:viloyat:UZ-08");
    });

    it("accepts stats:tuman:UZ-08-012", async () => {
      const client = makeClient();
      await gateway.handleSubscribe(client as never, {
        room: "stats:tuman:UZ-08-012",
      });
      expect(client.joined).toContain("stats:tuman:UZ-08-012");
    });

    it("accepts stats:mahalla:UZ-08-012-0045", async () => {
      const client = makeClient();
      await gateway.handleSubscribe(client as never, {
        room: "stats:mahalla:UZ-08-012-0045",
      });
      expect(client.joined).toContain("stats:mahalla:UZ-08-012-0045");
    });

    it("rejects injected room names (T-05-WS-ROOM-INJ)", async () => {
      const client = makeClient();
      await gateway.handleSubscribe(client as never, {
        room: "stats:hacker:'; DROP TABLE--",
      });
      expect(client.joined).toHaveLength(0);
      expect(client.emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({ message: expect.stringContaining("Noma'lum xona") }),
      );
    });

    it("legacy PUBLIC room 'national' still joins anonymously (backward compat)", async () => {
      const client = makeClient();
      await gateway.handleSubscribe(client as never, { room: "national" });
      expect(client.joined).toEqual(["national"]);
    });

    it("legacy protected rooms (alerts/viloyat/tuman) still join for admin-tier", async () => {
      const client = connectClient(gateway, "super-admin-token");
      await gateway.handleSubscribe(client as never, { room: "alerts" });
      await gateway.handleSubscribe(client as never, { room: "viloyat:UZ-08" });
      await gateway.handleSubscribe(client as never, { room: "tuman:UZ-08-012" });
      expect(client.joined).toEqual([
        "alerts",
        "viloyat:UZ-08",
        "tuman:UZ-08-012",
      ]);
    });
  });

  // ── AUDIT FIX C7 — handshake auth + room ACL ──────────────────────────────

  describe("C7 — handshake authentication", () => {
    it("valid token → payload socket.data.user ga saqlanadi", () => {
      const client = connectClient(gateway, "super-admin-token");
      expect(client.data.user).toMatchObject({
        sub: "admin-1",
        role: "SUPER_ADMIN",
      });
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it("yaroqsiz token → anonim sifatida qabul qilinadi (uzilMAYDI)", async () => {
      const client = connectClient(gateway, "garbage-token");
      expect(client.data.user).toBeUndefined();
      expect(client.disconnect).not.toHaveBeenCalled();
      // Anonim bo'lsa ham ommaviy xonaga qo'shila oladi
      await gateway.handleSubscribe(client as never, { room: "national" });
      expect(client.joined).toContain("national");
    });

    it("token Authorization header'dan ham o'qiladi (Bearer ...)", () => {
      const client = makeClient();
      client.handshake.headers.authorization = "Bearer tuman-admin-token";
      gateway.handleConnection(client as never);
      expect(client.data.user).toMatchObject({ role: "TUMAN_ADMIN" });
    });

    it("auth.token 'Bearer ' prefiksi bilan ham ishlaydi", () => {
      const client = makeClient("Bearer reader-token");
      gateway.handleConnection(client as never);
      expect(client.data.user).toMatchObject({ sub: "user-77" });
    });
  });

  describe("C7 — PUBLIC rooms (anonim ruxsat)", () => {
    it("anonim client top100:YYYY-MM xonasiga qo'shiladi (ommaviy /top sahifasi)", async () => {
      const client = connectClient(gateway); // tokensiz
      await gateway.handleSubscribe(client as never, { room: "top100:2026-06" });
      expect(client.joined).toContain("top100:2026-06");
      expect(client.emit).toHaveBeenCalledWith("subscribed", {
        room: "top100:2026-06",
      });
    });

    it("anonim client national + stats:* xonalariga qo'shiladi", async () => {
      const client = connectClient(gateway);
      await gateway.handleSubscribe(client as never, { room: "national" });
      await gateway.handleSubscribe(client as never, { room: "stats:viloyat:UZ-08" });
      expect(client.joined).toEqual(["national", "stats:viloyat:UZ-08"]);
    });
  });

  describe("C7 — 'alerts' room (fraud intel — admin-tier talab qilinadi)", () => {
    it("anonim client 'alerts' ga qo'shilA OLMAYDI — error event", async () => {
      const client = connectClient(gateway); // tokensiz
      await gateway.handleSubscribe(client as never, { room: "alerts" });
      expect(client.joined).toHaveLength(0);
      expect(client.emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          message: expect.stringContaining("Avtorizatsiya talab qilinadi"),
        }),
      );
    });

    it("KITOBXON roli bilan ham 'alerts' rad etiladi", async () => {
      const client = connectClient(gateway, "reader-token");
      await gateway.handleSubscribe(client as never, { room: "alerts" });
      expect(client.joined).toHaveLength(0);
      expect(client.emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          message: expect.stringContaining("Ruxsat yo'q"),
        }),
      );
    });

    it("SUPER_ADMIN token bilan 'alerts' ga qo'shiladi", async () => {
      const client = connectClient(gateway, "super-admin-token");
      await gateway.handleSubscribe(client as never, { room: "alerts" });
      expect(client.joined).toContain("alerts");
      expect(client.emit).toHaveBeenCalledWith("subscribed", { room: "alerts" });
    });

    it("VILOYAT_ADMIN va TUMAN_ADMIN ham 'alerts' ga kira oladi", async () => {
      for (const token of ["viloyat-admin-token", "tuman-admin-token"]) {
        const client = connectClient(gateway, token);
        await gateway.handleSubscribe(client as never, { room: "alerts" });
        expect(client.joined).toContain("alerts");
      }
    });
  });

  describe("C7 — legacy region rooms (alert:new fan-out — admin-tier)", () => {
    it("anonim client viloyat:/tuman: xonalariga qo'shilA OLMAYDI", async () => {
      const client = connectClient(gateway);
      await gateway.handleSubscribe(client as never, { room: "viloyat:UZ-08" });
      await gateway.handleSubscribe(client as never, { room: "tuman:UZ-08-012" });
      expect(client.joined).toHaveLength(0);
    });

    it("KITOBXON roli region xonalariga kira olmaydi", async () => {
      const client = connectClient(gateway, "reader-token");
      await gateway.handleSubscribe(client as never, { room: "tuman:UZ-08-012" });
      expect(client.joined).toHaveLength(0);
    });

    it("TUMAN_ADMIN region xonalariga kira oladi", async () => {
      const client = connectClient(gateway, "tuman-admin-token");
      await gateway.handleSubscribe(client as never, { room: "tuman:UZ-08-012" });
      expect(client.joined).toContain("tuman:UZ-08-012");
    });
  });

  describe("C7 — user:{id} room (faqat egasi yoki admin-tier)", () => {
    it("anonim client user:* xonasiga qo'shilA OLMAYDI", async () => {
      const client = connectClient(gateway);
      await gateway.handleSubscribe(client as never, { room: "user:user-77" });
      expect(client.joined).toHaveLength(0);
    });

    it("foydalanuvchi O'Z user:{sub} xonasiga qo'shiladi", async () => {
      const client = connectClient(gateway, "reader-token"); // sub: user-77
      await gateway.handleSubscribe(client as never, { room: "user:user-77" });
      expect(client.joined).toContain("user:user-77");
    });

    it("BOSHQA foydalanuvchining xonasi KITOBXON uchun rad etiladi", async () => {
      const client = connectClient(gateway, "reader-token"); // sub: user-77
      await gateway.handleSubscribe(client as never, { room: "user:someone-else" });
      expect(client.joined).toHaveLength(0);
      expect(client.emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          message: expect.stringContaining("Ruxsat yo'q"),
        }),
      );
    });

    it("admin-tier istalgan user:{id} xonasiga kira oladi", async () => {
      const client = connectClient(gateway, "super-admin-token");
      await gateway.handleSubscribe(client as never, { room: "user:user-77" });
      expect(client.joined).toContain("user:user-77");
    });
  });

  describe("C7 — library:{id} room (kutubxona xodimlari)", () => {
    it("anonim client library:* ga qo'shilA OLMAYDI", async () => {
      const client = connectClient(gateway);
      await gateway.handleSubscribe(client as never, { room: "library:LIB-GOV-08012-001" });
      expect(client.joined).toHaveLength(0);
    });

    it("KUTUBXONACHI va MUASSASA_ADMIN qo'shiladi", async () => {
      for (const token of ["librarian-token", "muassasa-admin-token"]) {
        const client = connectClient(gateway, token);
        await gateway.handleSubscribe(client as never, { room: "library:LIB-GOV-08012-001" });
        expect(client.joined).toContain("library:LIB-GOV-08012-001");
      }
    });

    it("KITOBXON library:* ga kira olmaydi", async () => {
      const client = connectClient(gateway, "reader-token");
      await gateway.handleSubscribe(client as never, { room: "library:LIB-GOV-08012-001" });
      expect(client.joined).toHaveLength(0);
    });
  });
});
