import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Logger, OnModuleDestroy } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";

/**
 * StatsGateway — real vaqt dashboard yangilanishlari uchun WebSocket gateway.
 *
 * Client ulanishi:
 *   const socket = io('http://localhost:3001', { path: '/ws', auth: { token: accessToken } });
 *   socket.emit('subscribe', { room: 'national' });
 *   socket.on('stats:update', (data) => console.log(data));
 *
 * Xonalar (legacy + Plan 05-07):
 *   'national'                — Milliy statistika (legacy stats:update)
 *   'viloyat:{id}'            — Viloyat statistikasi (legacy stats:update)
 *   'tuman:{id}'              — Tuman statistikasi (legacy stats:update + alert:new fan-out)
 *   'alerts'                  — Smart alertlar
 *   'top100:{month}'          — Top-100 o'zgarishlari
 *   'stats:national:UZ'       — Plan 05-07: per-scope stats:refresh
 *   'stats:viloyat:{id}'      — Plan 05-07: per-scope stats:refresh
 *   'stats:tuman:{id}'        — Plan 05-07: per-scope stats:refresh
 *   'stats:mahalla:{id}'      — Plan 05-07: per-scope stats:refresh
 *
 * ── AUDIT FIX C7 — WebSocket auth + xona ACL ─────────────────────────────────
 *
 * Ulanish paytida JWT (handshake.auth.token yoki Authorization header) tekshiriladi.
 * Yaroqsiz/yo'q token = anonim ulanish (uzilmaydi) — ommaviy /top sahifasi va
 * landing statistika real vaqt rejimida ishlashda davom etadi.
 *
 * Xona ACL jadvali (handleSubscribe):
 *   PUBLIC (anonim ham mumkin):
 *     'national'                       — landing sahifa agregat statistika
 *     'top100:YYYY-MM'                 — ommaviy /top sahifasi (publish + flag invalidate)
 *     'stats:{scope}:{id}'             — cron tomonidan isitilgan agregat hisoblagichlar
 *   AUTH (admin-tier: SUPER_ADMIN | VILOYAT_ADMIN | TUMAN_ADMIN):
 *     'alerts'                         — fraud intel (userId + riskScore + flags)
 *     'viloyat:{id}' / 'tuman:{id}'    — legacy region xonalari (alert:new fan-out oladi)
 *   AUTH (kutubxona xodimlari: admin-tier + MUASSASA_ADMIN + KUTUBXONACHI):
 *     'library:{id}'                   — transaction:new (userId bor — borrower privacy)
 *   AUTH (faqat o'zi yoki admin-tier):
 *     'user:{id}'                      — shaxsiy badge/notification xonasi
 */

/** AuthService.generateTokenPair tomonidan imzolangan JWT payload shakli. */
export interface WsJwtPayload {
  sub: string;
  phone?: string;
  role?: string;
}

/**
 * Admin-tier rollar — alert/fraud intel xonalariga kirish huquqi.
 * Smart Alert auditoriyasi (§VI.4): tuman/viloyat/super adminlar.
 */
const WS_ADMIN_ROLES: ReadonlySet<string> = new Set([
  "SUPER_ADMIN",
  "VILOYAT_ADMIN",
  "TUMAN_ADMIN",
]);

/** library:{id} xonasi — kutubxona xodimlari (transaction counter, userId payload). */
const WS_LIBRARY_STAFF_ROLES: ReadonlySet<string> = new Set([
  "SUPER_ADMIN",
  "VILOYAT_ADMIN",
  "TUMAN_ADMIN",
  "MUASSASA_ADMIN",
  "KUTUBXONACHI",
]);

/**
 * Plan 05-07 Task 1 — STATS_ROOM_KEYS namespace.
 *
 * Single source of truth for the per-scope stats:refresh rooms. Consumed
 * by the StatsAggregationProcessor (after each warm-X cron) and the
 * Plan 05-07 useStatsSocket hook on the frontend.
 *
 * The legacy `national` / `viloyat:{id}` / `tuman:{id}` rooms remain — they
 * carry the older `stats:update` event used by Phase 3 TopClient and
 * existing dashboard subscribers.
 */
export const STATS_ROOM_KEYS = {
  national: (id: string = "UZ") => `stats:national:${id}`,
  viloyat: (id: string) => `stats:viloyat:${id}`,
  tuman: (id: string) => `stats:tuman:${id}`,
  mahalla: (id: string) => `stats:mahalla:${id}`,
} as const;

export type StatsRoomScope = keyof typeof STATS_ROOM_KEYS;
@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true
  },
  path: "/ws",
  namespace: "/stats"
})
export class StatsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(StatsGateway.name);

  // Ulanishlar sonini kuzatish
  private connections = 0;

  // Redis pub/sub klientlari (multi-replica adapter uchun)
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Server ishga tushganda @socket.io/redis-adapter ni ulaymiz.
   *
   * INFRA-07: Standart in-memory adapter bilan bir instansiyada emit qilingan
   * xabar boshqa instansiyadagi klientlarga yetib bormaydi. 3+ replika ortida
   * (Nginx) bu dashboard'larni eskirgan holatga keltiradi va alertlar klientlarning
   * faqat bir qismiga yetadi. Redis pub/sub adapter barcha replikalar o'rtasida
   * broadcast'ni tarqatadi.
   *
   * ⚠️ DEPLOY TALABI (bu plan doirasidan tashqari, lekin majburiy bog'liqlik):
   * Multi-replica WebSocket uchun Nginx'da `ip_hash` (sticky session) yoqilishi
   * shart — Socket.IO handshake'ning HTTP long-polling fallback'i bir klientni
   * doimiy bir replikaga bog'lashni talab qiladi. Redis adapter faqat broadcast
   * fan-out'ni hal qiladi; sticky session prod Nginx config'ida sozlanishi kerak.
   */
  afterInit(server: Server) {
    try {
      const url = process.env.REDIS_URL ?? "redis://localhost:6379";
      this.pubClient = new Redis(url, { maxRetriesPerRequest: null });
      this.subClient = this.pubClient.duplicate();

      this.pubClient.on("error", (err) =>
        this.logger.warn(`WS adapter pub Redis xatosi: ${err.message}`)
      );
      this.subClient.on("error", (err) =>
        this.logger.warn(`WS adapter sub Redis xatosi: ${err.message}`)
      );

      // Socket.IO v4 adapter setup — fail-soft so dev single-replica still boots
      if (typeof server.adapter === "function") {
        server.adapter(createAdapter(this.pubClient, this.subClient));
        this.logger.log("StatsGateway: Redis adapter ulandi (multi-replica fan-out)");
      } else {
        this.logger.warn(
          "StatsGateway: server.adapter() mavjud emas — in-memory adapter ishlatiladi (single-replica dev rejim)",
        );
      }
    } catch (err) {
      this.logger.warn(
        `StatsGateway: Redis adapter ulanmadi — in-memory adapter ishlatiladi: ${(err as Error).message}`,
      );
    }
  }

  handleConnection(client: Socket) {
    this.connections++;
    // C7: handshake'dagi JWT ni tekshiramiz. Yaroqsiz token = anonim (uzilmaydi),
    // chunki ommaviy xonalar (top100, stats:*) tokensiz ham ishlashi shart.
    const user = this.verifyHandshakeToken(client);
    if (user) {
      if (!client.data) {
        (client as unknown as { data: Record<string, unknown> }).data = {};
      }
      (client.data as Record<string, unknown>).user = user;
    }
    this.logger.debug(
      `Ulandi: ${client.id} | auth: ${user ? user.sub : "anonim"} | Jami: ${this.connections}`,
    );
  }

  handleDisconnect(client: Socket) {
    this.connections--;
    this.logger.debug(`Uzildi: ${client.id} | Jami: ${this.connections}`);
  }

  // ── Xonaga obuna bo'lish ──────────────────────────────────────────────────
  // Redis adapter bilan `join`/`leave` asinxron (a'zolik boshqa replikalarga
  // ham tarqatiladi). Kutmasdan "subscribed" yuborish klientga hali amalda
  // bo'lmagan obunani tasdiqlaydi — birinchi broadcast yo'qolishi mumkin.
  @SubscribeMessage("subscribe")
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { room: string }
  ) {
    const room = data?.room;
    if (typeof room !== "string" || !this.isAllowedRoom(room)) {
      client.emit("error", { message: `Noma'lum xona: ${room}` });
      return;
    }

    // C7 ACL: xona shakli to'g'ri bo'lsa ham, himoyalangan xonalar uchun
    // autentifikatsiya + rol tekshiriladi.
    const user = this.getSocketUser(client);
    if (!this.canJoinRoom(room, user)) {
      client.emit("error", {
        message: user
          ? `Ruxsat yo'q: '${room}' xonasi uchun vakolat yetarli emas`
          : `Avtorizatsiya talab qilinadi: '${room}' xonasi himoyalangan`,
      });
      this.logger.warn(
        `${client.id} → xona RAD ETILDI: ${room} (auth: ${user ? `${user.sub}/${user.role ?? "rolsiz"}` : "anonim"})`,
      );
      return;
    }

    await client.join(room);
    client.emit("subscribed", { room });
    this.logger.debug(`${client.id} → xona: ${room}`);
  }

  @SubscribeMessage("unsubscribe")
  async handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { room: string }
  ) {
    await client.leave(data.room);
    client.emit("unsubscribed", { room: data.room });
  }

  // ── Broadcast metodlari (servis tomonidan chaqiriladi) ───────────────────

  /** Milliy statistika yangilanganda */
  emitNationalStats(stats: unknown) {
    this.server.to("national").emit("stats:update", {
      type: "national",
      data: stats,
      ts: new Date().toISOString()
    });
  }

  /** Viloyat statistikasi yangilanganda */
  emitViloyatStats(viloyatId: string, stats: unknown) {
    this.server.to(`viloyat:${viloyatId}`).emit("stats:update", {
      type: "viloyat",
      viloyatId,
      data: stats,
      ts: new Date().toISOString()
    });
  }

  /** Tuman statistikasi yangilanganda */
  emitTumanStats(tumanId: string, stats: unknown) {
    this.server.to(`tuman:${tumanId}`).emit("stats:update", {
      type: "tuman",
      tumanId,
      data: stats,
      ts: new Date().toISOString()
    });
  }

  /** Yangi smart alert yaratilganda */
  emitNewAlert(alert: unknown) {
    this.server.to("alerts").emit("alert:new", {
      data: alert,
      ts: new Date().toISOString()
    });
  }

  /** Alert yechilganda */
  emitAlertResolved(alertId: string) {
    this.server.to("alerts").emit("alert:resolved", {
      id: alertId,
      ts: new Date().toISOString()
    });
  }

  /** Top-100 yangilanganda */
  emitTop100Update(month: string, entries: unknown) {
    this.server.to(`top100:${month}`).emit("top100:update", {
      month,
      data: entries,
      ts: new Date().toISOString()
    });
  }

  /**
   * Top-100 yozuvi flag/clear/reject qilinganda — admin review queue uchun
   * yengilroq payload (faqat o'zgargan userId va action).
   *
   * Plan 03-04 TOP-07: admin override endpointlari ham broadcast emit qiladi,
   * shunda /top sahifasi va /dashboard/top-review obunalari React Query
   * keshini invalidate qiladi.
   */
  emitTop100UserFlagged(
    month: string,
    userId: string,
    action: "flagged" | "cleared" | "rejected" | "confirmed",
  ) {
    this.server.to(`top100:${month}`).emit("top100:flag", {
      month,
      userId,
      action,
      ts: new Date().toISOString(),
    });
  }

  /**
   * Foydalanuvchiga badge berilganda — shaxsiy user:{userId} room ga emit.
   *
   * Plan 03-04 GAME-02: BadgeService.award Kafka BADGE_EARNED event emit qiladi,
   * KafkaConsumerService uni qabul qilib bu metodga uzatadi. Profile sahifasi
   * `user:${userId}` room ga obuna bo'lib jonli toast bildirishnoma ko'rsatadi.
   */
  emitBadgeEarned(userId: string, badgeCode: string) {
    this.server.to(`user:${userId}`).emit("badge:earned", {
      userId,
      badgeCode,
      ts: new Date().toISOString(),
    });
  }

  /**
   * Foydalanuvchi yangi darajaga ko'tarilganda — shaxsiy user:{userId} room ga.
   *
   * badge:earned bilan bir xil yo'l: XpService.award Kafka XP_LEVEL_UP emit
   * qiladi → KafkaConsumerService bu metodga uzatadi → profil sahifasi toast
   * ko'rsatadi. Daraja ko'tarilishi kitobxon uchun eng kuchli ijobiy signal,
   * lekin u faqat sahifani qayta ochganda ko'rinsa, ta'siri yo'qoladi.
   */
  emitXpLevelUp(userId: string, level: number, xp: number) {
    this.server.to(`user:${userId}`).emit("xp:levelup", {
      userId,
      level,
      xp,
      ts: new Date().toISOString(),
    });
  }

  /** Yangi tranzaksiya qo'shilganda (dashboard counter uchun) */
  emitTransactionCreated(libraryId: string, payload: { type: string; userId: string }) {
    this.server.to(`library:${libraryId}`).emit("transaction:new", {
      ...payload,
      ts: new Date().toISOString()
    });
  }

  // ── Plan 05-07 — Scope-rooms emit helpers (STAT-01/02 + ALERT-01/02) ───────

  /**
   * Plan 05-07 Task 1 (STAT-01/02) — broadcast a per-scope stats:refresh
   * event after the StatsAggregationProcessor warms a cache key.
   *
   * Frontends subscribed to `stats:{scope}:{scopeId}` (via useStatsSocket)
   * react by merging the payload into their React-Query cache, so dashboards
   * left open in another tab show live numbers without polling.
   *
   * Multi-replica fan-out is inherited from the Redis adapter (Phase 1 INFRA-07).
   * Best-effort emit: cron callers wrap in try/catch — cache populate is the
   * canonical state, the emit is delivery only (T-05-DISP-FAIL).
   */
  emitStatsRefresh(
    scope: StatsRoomScope,
    scopeId: string,
    payload: unknown,
  ): void {
    const room = STATS_ROOM_KEYS[scope](scopeId);
    this.server.to(room).emit("stats:refresh", {
      scope,
      scopeId,
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Plan 05-07 Task 1 (ALERT-01/02) — per-tuman + per-viloyat alert fan-out.
   *
   * Existing `emitNewAlert` broadcasts to the global `alerts` room and stays
   * the canonical channel for the /dashboard/alerts page. This new emitter
   * additionally targets the scope-narrowed `tuman:{id}` (always) and
   * `viloyat:{id}` (when known) rooms so tier admins subscribed to ONLY
   * their region receive the event without seeing sibling regions' noise.
   *
   * Event name `alert:new` matches `emitNewAlert` so frontend listeners are
   * reusable. The body shape is also `{ data, ts }` for the same reason.
   *
   * @param tumanId   — required; the affected tuman.
   * @param viloyatId — optional; when null, only the tuman room is emitted to.
   * @param payload   — the alert payload (id, issueType, severity, …).
   */
  emitTumanAlerted(
    tumanId: string,
    viloyatId: string | null,
    payload: unknown,
  ): void {
    const ts = new Date().toISOString();
    this.server.to(`tuman:${tumanId}`).emit("alert:new", {
      data: payload,
      ts,
    });
    if (viloyatId) {
      this.server.to(`viloyat:${viloyatId}`).emit("alert:new", {
        data: payload,
        ts,
      });
    }
  }

  // ── Ulanganlar sonini olish (monitoring uchun) ────────────────────────────
  getConnectionCount(): number {
    return this.connections;
  }

  // ── Resurslarni tozalash ──────────────────────────────────────────────────
  async onModuleDestroy() {
    await Promise.allSettled([
      this.pubClient?.quit(),
      this.subClient?.quit()
    ]);
  }

  // ── Ichki yordamchilar ────────────────────────────────────────────────────

  /**
   * C7: handshake'dan JWT olib JwtAuthGuard bilan bir xil secret orqali
   * tekshiradi. Token yo'q yoki yaroqsiz → null (anonim rejim, uzilmaydi).
   */
  private verifyHandshakeToken(client: Socket): WsJwtPayload | null {
    const token = this.extractHandshakeToken(client);
    if (!token) return null;
    try {
      const payload = this.jwtService.verify<WsJwtPayload>(token, {
        secret: this.config.get<string>("JWT_SECRET"),
      });
      if (!payload || typeof payload.sub !== "string") return null;
      return payload;
    } catch {
      // Yaroqsiz/muddati o'tgan token = anonim. Ommaviy xonalar ishlayveradi.
      return null;
    }
  }

  /** `auth: { token }` (socket.io standarti) yoki Authorization header. */
  private extractHandshakeToken(client: Socket): string | null {
    const auth = client.handshake?.auth as Record<string, unknown> | undefined;
    const raw = auth?.token;
    if (typeof raw === "string" && raw.length > 0) {
      return raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    }
    const header = client.handshake?.headers?.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      return header.slice(7);
    }
    return null;
  }

  /** handleConnection da saqlangan tekshirilgan payload (yo'q bo'lsa null). */
  private getSocketUser(client: Socket): WsJwtPayload | null {
    const data = client.data as { user?: WsJwtPayload } | undefined;
    const user = data?.user;
    return user && typeof user.sub === "string" ? user : null;
  }

  /**
   * C7 ACL — xona kimga ochiq?
   *
   *   PUBLIC:  national | top100:YYYY-MM | stats:{scope}:{id}
   *   ADMIN:   alerts | viloyat:{id} | tuman:{id}   (alert/fraud intel fan-out)
   *   STAFF:   library:{id}                          (admin-tier + MUASSASA_ADMIN + KUTUBXONACHI)
   *   SELF:    user:{id}                             (id === o'z sub yoki admin-tier)
   */
  private canJoinRoom(room: string, user: WsJwtPayload | null): boolean {
    // ── PUBLIC xonalar — anonim ham obuna bo'la oladi ──
    if (room === "national") return true;
    if (/^top100:\d{4}-\d{2}$/.test(room)) return true;
    if (/^stats:(national|viloyat|tuman|mahalla):[A-Za-z0-9_-]+$/.test(room)) {
      return true;
    }

    const role = user?.role ?? "";

    // ── user:{id} — faqat o'z xonasi yoki admin-tier ──
    const userMatch = /^user:([a-zA-Z0-9_-]+)$/.exec(room);
    if (userMatch) {
      if (!user) return false;
      return user.sub === userMatch[1] || WS_ADMIN_ROLES.has(role);
    }

    // ── alerts + legacy region xonalari — admin-tier (alert:new fan-out oladi) ──
    if (room === "alerts" || /^(viloyat|tuman):[A-Za-z0-9_-]+$/.test(room)) {
      return user !== null && WS_ADMIN_ROLES.has(role);
    }

    // ── library:{id} — kutubxona xodimlari (transaction:new payload'ida userId bor) ──
    if (/^library:[A-Za-z0-9_-]+$/.test(room)) {
      return user !== null && WS_LIBRARY_STAFF_ROLES.has(role);
    }

    // Default-deny: isAllowedRoom dan o'tgan, lekin ACL'da yo'q xona shakli.
    return false;
  }

  /**
   * Xona NOMI shakli validatsiyasi (T-05-WS-ROOM-INJ) — ACL emas, faqat
   * alfavit/format tekshiruvi. Kirish huquqi canJoinRoom da hal qilinadi.
   */
  private isAllowedRoom(room: string): boolean {
    if (room === "national" || room === "alerts") return true;
    // Legacy region rooms (Phase 3 + earlier) — accept upper/lower/digit/hyphen
    // so the geographic ID alphabet (e.g., "UZ-08", "UZ-08-012") fits.
    if (/^viloyat:[A-Za-z0-9_-]+$/.test(room)) return true;
    if (/^tuman:[A-Za-z0-9_-]+$/.test(room)) return true;
    if (/^library:[A-Za-z0-9_-]+$/.test(room)) return true;
    if (/^top100:\d{4}-\d{2}$/.test(room)) return true;
    // Plan 03-04 GAME-02: shaxsiy badge notification room.
    // C7: payload yengil (badgeCode), lekin xonaga kirish endi canJoinRoom
    // orqali faqat egasi/admin bilan cheklanadi (kuzatuv oldini olish).
    if (/^user:[a-zA-Z0-9_-]+$/.test(room)) return true;
    // Plan 05-07 — STATS_ROOM_KEYS shaped rooms (stats:<scope>:<id>).
    // T-05-WS-ROOM-INJ: regex narrows scope to the 4 known values and ID
    // to the geographic alphabet so client cannot inject arbitrary keys.
    if (/^stats:(national|viloyat|tuman|mahalla):[A-Za-z0-9_-]+$/.test(room))
      return true;
    return false;
  }
}
