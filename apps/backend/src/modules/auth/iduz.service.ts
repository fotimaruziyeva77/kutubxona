import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infra/prisma/prisma.service";
import * as crypto from "crypto";

/**
 * OneID — O'zbekiston davlat identifikatsiya tizimi (sso.egov.uz) bilan
 * OAuth2.0 + PKCE asosida integratsiya.
 *
 * MUHIM (AUTH-03, RESEARCH Assumption A2): OneID standart OIDC emas. Bitta `.do`
 * endpoint ishlatiladi va grant_type qiymatlari nostandart:
 *   - authorize:  GET  {base}/sso/oauth/Authorization.do?response_type=one_code&...
 *   - token:      POST {base}/sso/oauth/Authorization.do  grant_type=one_authorization_code
 *   - identify:   POST {base}/sso/oauth/Authorization.do  grant_type=one_access_token_identify
 *
 * Identify javobida PINFL `pin` maydonida keladi (sub/pinfl emas — test/staging
 * provayderlari uchun fallback ham bor). Boshqa maydonlar: full_name, sur_name,
 * mid_name, birth_date (dd.mm.yyyy), mob_phone_no (raqamlar), pport_no.
 *
 * Live qabul qilinishidan oldin Task 2 (human-verify checkpoint) bajariladi —
 * grant_type stringlari yoki maydon nomlari farq qilsa, bu yerda bir-ikki satr
 * o'zgartiriladi.
 *
 * Konfiguratsiya (ConfigService / Vault):
 *   IDUZ_BASE_URL       — default 'https://sso.egov.uz'
 *   IDUZ_CLIENT_ID      — majburiy (prod da defaultsiz)
 *   IDUZ_CLIENT_SECRET  — majburiy (prod da defaultsiz)
 *   IDUZ_REDIRECT_URI   — default 'https://sifat.uz/auth/iduz/callback'
 */
@Injectable()
export class IduzService {
  private readonly logger = new Logger(IduzService.name);

  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  /** Yagona OneID endpoint (authorize + token + identify uchun bitta `.do`) */
  private readonly endpoint: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.baseUrl = (this.config.get<string>("IDUZ_BASE_URL") ?? "https://sso.egov.uz").replace(/\/+$/, "");
    this.endpoint = `${this.baseUrl}/sso/oauth/Authorization.do`;

    const isProd = (this.config.get<string>("NODE_ENV") ?? process.env.NODE_ENV) === "production";
    const clientIdRaw = this.config.get<string>("IDUZ_CLIENT_ID");
    if (isProd && !clientIdRaw) {
      throw new Error("IDUZ_CLIENT_ID prod da majburiy (defaultsiz)");
    }
    this.clientId = clientIdRaw ?? "dev-client";

    const clientSecretRaw = this.config.get<string>("IDUZ_CLIENT_SECRET");
    if (isProd && !clientSecretRaw) {
      throw new Error("IDUZ_CLIENT_SECRET prod da majburiy (defaultsiz)");
    }
    this.clientSecret = clientSecretRaw ?? "";

    this.redirectUri = this.config.get<string>("IDUZ_REDIRECT_URI") ?? "https://sifat.uz/auth/iduz/callback";
  }

  // ── 1. Authorization URL yaratish ─────────────────────────────────────────

  /**
   * Frontend `code_verifier` yaratadi, uning S256 hash'ini `code_challenge`
   * sifatida shu yerga uzatadi. Tuzilgan URL ga foydalanuvchi yo'naltiriladi.
   */
  buildAuthUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      response_type: "one_code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: "openid profile phone pinfl",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `${this.endpoint}?${params.toString()}`;
  }

  // ── 2. Token olish (`grant_type=one_authorization_code`) ─────────────────

  async exchangeCode(code: string, codeVerifier: string): Promise<IduzTokens> {
    const body = new URLSearchParams({
      grant_type: "one_authorization_code",
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: codeVerifier,
    });

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`OneID token xatosi: ${err}`);
      throw new UnauthorizedException("OneID autentifikatsiyasi muvaffaqiyatsiz");
    }

    return res.json() as Promise<IduzTokens>;
  }

  // ── 3. Foydalanuvchi ma'lumotlari (`grant_type=one_access_token_identify`)

  async getUserInfo(accessToken: string): Promise<IduzUserInfo> {
    const body = new URLSearchParams({
      grant_type: "one_access_token_identify",
      access_token: accessToken,
    });

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new UnauthorizedException("OneID foydalanuvchi ma'lumotlarini olishda xato");
    }

    const raw = (await res.json()) as IduzRawUserInfo;
    return this._normalizeUserInfo(raw);
  }

  // ── 4. Platformada login yoki ro'yhat ────────────────────────────────────

  /**
   * M5 fix — PINFL-birinchi bog'lash tartibi.
   *
   * Eski versiya FAQAT telefon bo'yicha qidirardi va provayder qaytargan
   * PINFL ni tashlab yuborardi: raqam qayta ishlatilsa/almashtirilsa BOSHQA
   * fuqaro mavjud akkauntga kirib qolardi va davlat identifikatori bilan
   * durable bog' umuman yo'q edi.
   *
   * Yangi tartib:
   *   1) PINFL bo'yicha findUnique → topilsa o'sha foydalanuvchi login
   *      (provayder telefoni o'zgargan bo'lsa — yangilab, log yoziladi);
   *   2) aks holda telefon bo'yicha findFirst:
   *        - PINFL i YO'Q bo'lsa → hozir bir martalik biriktiriladi (log);
   *        - BOSHQA PINFL bo'lsa → REJECT (shaxs mos kelmadi — kirgizilmaydi);
   *   3) aks holda yangi foydalanuvchi PINFL bilan yaratiladi.
   */
  async loginOrRegister(userInfo: IduzUserInfo): Promise<{ userId: string; isNew: boolean }> {
    const phone = this._normalizePhone(userInfo.phone_number);
    const pinfl = (userInfo.pinfl ?? "").trim();

    // 1) PINFL — davlat shaxs identifikatori, birlamchi qidiruv kaliti.
    if (pinfl) {
      const byPinfl = await this.prisma.user.findUnique({
        where: { pinfl },
        select: { id: true, phone: true },
      });

      if (byPinfl) {
        if (phone && byPinfl.phone !== phone) {
          // Provayder telefon o'zgarganini bildirdi — identity PINFL bo'yicha
          // tasdiqlangan, telefonni yangilaymiz. Yangi raqam boshqa akkauntda
          // band bo'lsa (unique to'qnashuv) — yangilamay, faqat log yozamiz:
          // login baribir PINFL egasiga tegishli.
          try {
            await this.prisma.user.update({
              where: { id: byPinfl.id },
              data: { phone },
            });
            this.logger.warn(
              `OneID: telefon yangilandi (PINFL mos) — ${byPinfl.id}: ${byPinfl.phone} → ${phone}`,
            );
          } catch (err) {
            this.logger.warn(
              `OneID: telefonni yangilab bo'lmadi (${byPinfl.id}): ${(err as Error).message}`,
            );
          }
        }
        this.logger.log(`OneID login (PINFL): ${byPinfl.id}`);
        return { userId: byPinfl.id, isNew: false };
      }
    }

    // 2) Telefon bo'yicha qidiruv — legacy akkauntlar uchun.
    const byPhone = await this.prisma.user.findFirst({
      where: { phone },
      select: { id: true, pinfl: true },
    });

    if (byPhone) {
      if (pinfl && byPhone.pinfl && byPhone.pinfl !== pinfl) {
        // Telefon mavjud akkauntga tegishli, lekin u BOSHQA fuqaroning PINFL i
        // bilan bog'langan — raqam qayta ishlatilgan. Kirgizish MUMKIN EMAS.
        this.logger.warn(
          `OneID: PINFL mos kelmadi — ${phone} raqami boshqa shaxs akkauntiga bog'langan (${byPhone.id})`,
        );
        throw new UnauthorizedException(
          "Shaxsiy ma'lumotlar mos kelmadi: bu telefon raqami boshqa fuqaroning hisobiga bog'langan. Iltimos, qo'llab-quvvatlash xizmatiga murojaat qiling.",
        );
      }

      if (pinfl && !byPhone.pinfl) {
        // Bir martalik bog'lash: telefon mos, PINFL hali yozilmagan.
        await this.prisma.user.update({
          where: { id: byPhone.id },
          data: { pinfl },
        });
        this.logger.log(`OneID: PINFL biriktirildi (bir martalik) — ${byPhone.id}`);
      }

      this.logger.log(`OneID login: ${byPhone.id} (${phone})`);
      return { userId: byPhone.id, isNew: false };
    }

    // 3) OneID orqali tasdiqlangan davlat foydalanuvchisi — avtomatik ACTIVE.
    const genderMap: Record<string, "MALE" | "FEMALE"> = { male: "MALE", female: "FEMALE" };
    const gender = genderMap[userInfo.gender ?? ""] ?? "MALE";
    const dob = userInfo.birthdate ? new Date(userInfo.birthdate) : new Date("1990-01-01");

    const newUser = await this.prisma.user.create({
      data: {
        phone,
        pinfl: pinfl || null,
        name: `${userInfo.given_name ?? ""} ${userInfo.family_name ?? ""}`.trim() || "Noma'lum",
        dob,
        gender,
        status: "ACTIVE",
        type: "CITIZEN",
        trustScore: 0,
      },
    });

    this.logger.log(`OneID yangi foydalanuvchi: ${newUser.id} (${phone})`);
    return { userId: newUser.id, isNew: true };
  }

  // ── PKCE / CSRF yordamchi funksiyalar ────────────────────────────────────

  /**
   * Server tomonida state yaratish (CSRF himoya).
   * Cookie ichida `iduz_state` sifatida saqlanadi, callback da bu cookie
   * qaytib kelgan `state` qiymati bilan timing-safe taqqoslanadi.
   */
  generateState(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  /**
   * State tekshiruvi — timing-safe.
   * `received` callback orqali kelgan parametr, `expected` esa
   * iduz_state HttpOnly cookie ichidagi qiymat.
   */
  verifyState(received: string, expected: string): boolean {
    if (!received || !expected) return false;
    if (received.length !== expected.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(received, "utf8"),
      Buffer.from(expected, "utf8"),
    );
  }

  // ── Yordamchi: OneID raw javobini IduzUserInfo ga normalizatsiya ─────────

  private _normalizeUserInfo(raw: IduzRawUserInfo): IduzUserInfo {
    // PINFL: OneID `pin` maydonida — fallback sub/pinfl test provayderlari uchun
    const pinfl = raw.pin ?? raw.pinfl ?? raw.sub ?? "";

    // Telefon: OneID `mob_phone_no` raqamlar (998901234567) yoki standart `phone_number`
    const phoneSrc = raw.mob_phone_no ?? raw.phone_number ?? "";
    const phone_number = this._normalizePhone(phoneSrc);

    // Ism / familiya: OneID alohida maydonlardan yoki full_name dan parse
    let given_name = raw.given_name;
    let family_name = raw.family_name ?? raw.sur_name;
    if (!given_name && raw.full_name) {
      const parts = raw.full_name.split(/\s+/);
      // full_name: "Familiya Ism Otasining-ismi" → ism o'rta so'z, agar 3 ta bo'lsa
      if (parts.length >= 2) given_name = parts[1];
      if (!family_name && parts.length >= 1) family_name = parts[0];
    }

    // Tug'ilgan sana: `birth_date` OneID formati dd.mm.yyyy → ISO yyyy-mm-dd
    let birthdate = raw.birthdate;
    if (!birthdate && raw.birth_date) {
      const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw.birth_date);
      birthdate = m ? `${m[3]}-${m[2]}-${m[1]}` : raw.birth_date;
    }

    // Gender: OneID "1"=male, "2"=female (taxminiy; test sahna farq qilishi mumkin)
    let gender: "male" | "female" | undefined = raw.gender as "male" | "female" | undefined;
    if (gender === ("1" as unknown)) gender = "male";
    else if (gender === ("2" as unknown)) gender = "female";

    return {
      pinfl,
      sub: pinfl,
      given_name,
      family_name,
      phone_number,
      birthdate,
      gender,
    };
  }

  private _normalizePhone(raw?: string): string {
    if (!raw) return "";
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("998")) return `+${digits}`;
    if (digits.length === 9) return `+998${digits}`;
    return `+${digits}`;
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface IduzTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/**
 * OneID `identify` javobining xom shakli — provayder kontrakti hali to'liq
 * tasdiqlanmagan (Task 2 live checkpoint). Maydonlar ixtiyoriy, normalizatsiya
 * `_normalizeUserInfo` da bo'ladi.
 */
export interface IduzRawUserInfo {
  // OneID egov.uz maydonlari (RESEARCH Assumption A2)
  pin?: string;             // PINFL
  full_name?: string;       // "Familiya Ism Otasining-ismi"
  sur_name?: string;        // Familiya
  mid_name?: string;        // Otasining ismi
  birth_date?: string;      // "dd.mm.yyyy"
  mob_phone_no?: string;    // raqamlar
  pport_no?: string;        // pasport

  // Standart OIDC fallback maydonlari (test/staging provayderlari uchun)
  sub?: string;
  pinfl?: string;
  given_name?: string;
  family_name?: string;
  phone_number?: string;
  birthdate?: string;       // ISO

  // Gender — OneID da "1"/"2" yoki "male"/"female"
  gender?: string;
}

export interface IduzUserInfo {
  /** PINFL yoki unikal ID (OneID `pin` yoki fallback `sub`/`pinfl`) */
  sub: string;
  /** Aniq PINFL — `pin` maydonidan yoki fallback */
  pinfl: string;
  given_name?: string;
  family_name?: string;
  phone_number?: string;
  birthdate?: string;
  gender?: "male" | "female";
}
