import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { existsSync } from "fs";
import type { Browser, Page } from "puppeteer-core";
// Plan 05-04 Task 2 — single source of truth for HTML escaping. The prior
// inline definition was deleted; all consumers (PdfService, notification
// email body builder, future Plan 05-05/05-08 templates) import from here.
import { escapeHtml } from "../../common/utils/escape-html.util";
import type { ReportData, ReportScope } from "../../modules/admin/report-data.service";

/**
 * AUDIT FIX H11 — ma'lum tizim Chromium yo'llari. Birinchi mavjudi (existsSync)
 * ishlatiladi. Alpine/musl prod image'da apk chromium /usr/bin/chromium-browser
 * ga o'rnatiladi — @sparticuz/chromium (glibc build) u yerda exec bo'lmaydi.
 */
const KNOWN_CHROMIUM_PATHS: readonly string[] = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable",
  // Lokal dev fallback'lari (Windows/macOS)
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  // Windows per-user Chrome/Edge (LOCALAPPDATA orqali — foydalanuvchi nomiga
  // bog'liq emas). Chrome ko'pincha shu yerga (admin huquqisiz) o'rnatiladi.
  ...(process.env.LOCALAPPDATA
    ? [
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ]
    : []),
  // Windows Edge (Chromium-asosli — Win10/11 da doim mavjud, ishonchli
  // fallback: Chrome o'rnatilmagan bo'lsa ham PDF generatsiya ishlaydi).
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/**
 * AUDIT FIX H11 — bir vaqtda nechta sahifa render bo'lishi mumkin.
 * Har bir render bitta Chromium tab — concurrent HTTP report download'lar
 * N ta to'liq Chromium fork qilmasligi uchun semafor bilan cheklanadi.
 */
const MAX_CONCURRENT_RENDERS = 2;

/**
 * PdfService — HTML shablondan PDF generatsiya qiladi.
 *
 * Ishlatilish:
 *   const pdf = await this.pdfService.generateFromHtml(html, { landscape: false });
 *   res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="hisobot.pdf"' });
 *   res.send(pdf);
 *
 * AUDIT FIX H11:
 *   - Executable tanlash tartibi: PUPPETEER_EXECUTABLE_PATH (Dockerfile
 *     o'rnatadi) → ma'lum tizim yo'llari (existsSync) → @sparticuz/chromium
 *     faqat oxirgi chora sifatida (glibc build — Alpine/musl da ishlamaydi).
 *   - Browser lazily-yaratiladigan singleton: har so'rovda yangi Chromium
 *     fork qilinmaydi; uzilib qolsa keyingi so'rovda qayta launch bo'ladi.
 *   - Semafor (MAX_CONCURRENT_RENDERS=2): sahifa renderlari cheklanadi.
 *   - Sahifa har doim finally da yopiladi; umumiy browser per-request yopilmaydi.
 */
@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfService.name);

  /** H11: umumiy lazily-yaratiladigan singleton browser. */
  private browser: Browser | null = null;
  /** Parallel launch'larni birlashtirish (faqat bitta launch yuradi). */
  private launchPromise: Promise<Browser> | null = null;

  /** H11 semafor holati. */
  private activeRenders = 0;
  private readonly renderWaiters: Array<() => void> = [];

  async generateFromHtml(
    html: string,
    options: { landscape?: boolean; format?: "A4" | "A3" } = {}
  ): Promise<Buffer> {
    await this.acquireRenderSlot();
    let page: Page | null = null;

    try {
      const browser = await this.getBrowser();
      page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });

      const pdf = await page.pdf({
        format: options.format ?? "A4",
        landscape: options.landscape ?? false,
        printBackground: true,
        margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" }
      });

      return Buffer.from(pdf);
    } catch (err) {
      this.logger.error("PDF generatsiyada xato:", err);
      throw err;
    } finally {
      // Sahifa HAR DOIM yopiladi; umumiy browser esa per-request yopilmaydi
      // (singleton — onModuleDestroy da yopiladi).
      if (page) {
        await page.close().catch(() => undefined);
      }
      this.releaseRenderSlot();
    }
  }

  /** Graceful shutdown (H6 enableShutdownHooks bilan birga ishlaydi). */
  async onModuleDestroy(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      await browser.close().catch(() => undefined);
      this.logger.log("PDF browser yopildi (shutdown)");
    }
  }

  // ── H11 ichki yordamchilar ───────────────────────────────────────────────

  /** Semafor: bo'sh slot bo'lsa darhol, aks holda navbatda kutadi. */
  private acquireRenderSlot(): Promise<void> {
    if (this.activeRenders < MAX_CONCURRENT_RENDERS) {
      this.activeRenders++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.renderWaiters.push(resolve));
  }

  /**
   * Slot-transfer pattern: navbatda kutuvchi bo'lsa slot unga to'g'ridan-to'g'ri
   * o'tadi (activeRenders o'zgarmaydi) — yangi kelgan so'rov navbat oldidan
   * slot o'g'irlay olmaydi.
   */
  private releaseRenderSlot(): void {
    const next = this.renderWaiters.shift();
    if (next) {
      next();
    } else {
      this.activeRenders = Math.max(0, this.activeRenders - 1);
    }
  }

  /** Singleton browser; uzilib qolgan bo'lsa qayta launch qilinadi. */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.isBrowserConnected(this.browser)) {
      return this.browser;
    }
    this.browser = null;

    if (!this.launchPromise) {
      this.launchPromise = this.launchBrowser()
        .then((b) => {
          this.browser = b;
          return b;
        })
        .finally(() => {
          this.launchPromise = null;
        });
    }
    return this.launchPromise;
  }

  /** puppeteer-core v21+ `connected` getter / eski `isConnected()` ikkalasini qo'llab-quvvatlaydi. */
  private isBrowserConnected(browser: Browser): boolean {
    const b = browser as unknown as {
      connected?: boolean;
      isConnected?: () => boolean;
    };
    if (typeof b.isConnected === "function") return b.isConnected();
    if (typeof b.connected === "boolean") return b.connected;
    return true;
  }

  private async launchBrowser(): Promise<Browser> {
    const puppeteer = await import("puppeteer-core");
    const executablePath = await this.resolveExecutablePath();

    const browser = await puppeteer.default.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    this.logger.log(`PDF browser ishga tushdi: ${executablePath}`);
    return browser as unknown as Browser;
  }

  /**
   * H11 tanlash tartibi:
   *   1. PUPPETEER_EXECUTABLE_PATH — Dockerfile/operator o'rnatgan yo'l har
   *      doim ustun (noto'g'ri bo'lsa launch baland ovozda yiqiladi — jim
   *      glibc-fallback'dan yaxshi).
   *   2. Ma'lum tizim yo'llari (existsSync bilan tekshiriladi).
   *   3. @sparticuz/chromium — faqat oxirgi chora (glibc build).
   */
  private async resolveExecutablePath(): Promise<string> {
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && envPath.trim().length > 0) {
      return envPath;
    }

    for (const candidate of KNOWN_CHROMIUM_PATHS) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    try {
      const chromium = await import("@sparticuz/chromium");
      return await chromium.default.executablePath();
    } catch (err) {
      throw new Error(
        "Chromium topilmadi: PUPPETEER_EXECUTABLE_PATH env o'zgaruvchisini o'rnating " +
          "yoki tizimga chromium o'rnating (apk add chromium / apt install chromium). " +
          `Oxirgi chora @sparticuz/chromium ham yuklanmadi: ${(err as Error).message}`,
      );
    }
  }

  // ── Tayyor shablon: Admin statistika hisoboti ─────────────────────────────
  //
  // Plan 05-08 RPT-01 — scope-parameterized monthly report HTML template.
  //
  // Overload variants (preserves backward compatibility with Plan 04-03 callers):
  //   buildMonthlyReportHtml(legacy)                    — simple key/value table
  //   buildMonthlyReportHtml(ReportData, scope, scopeId?) — extended PDF with
  //     scope label, gender + age buckets (k-anonymity respected), top-5
  //     libraries, top-5 readers (already maskNameIfMinor-applied upstream).
  //
  // SECURITY: every interpolation passes through `escapeHtml`. DB-sourced
  // fields (data.title, data.scopeLabel, table labels, library/reader names)
  // are particularly important — without escaping, a library named
  // `<script>fetch('evil.io')</script>` would execute under Puppeteer and
  // end up baked into the PDF (Plan 04-03 audit-fix FIX A).
  buildMonthlyReportHtml(
    data:
      | {
          title: string;
          period: string;
          stats: Record<string, number | string>;
          tableRows?: { label: string; value: string | number }[];
          generatedAt?: string;
        }
      | ReportData,
    scope?: ReportScope,
    scopeId?: string,
  ): string {
    // Detect the extended ReportData shape vs the legacy shape.
    const isExtended = scope !== undefined &&
      "scopeLabel" in (data as ReportData) &&
      Array.isArray((data as ReportData).genderBuckets);

    const date =
      (data as { generatedAt?: string }).generatedAt ??
      new Date().toLocaleDateString("uz-UZ");
    const safeTitle = escapeHtml(data.title);
    const safePeriod = escapeHtml(data.period);
    const safeDate = escapeHtml(date);

    if (!isExtended) {
      const legacy = data as {
        title: string;
        period: string;
        stats: Record<string, number | string>;
        tableRows?: { label: string; value: string | number }[];
      };
      const rows =
        legacy.tableRows ??
        Object.entries(legacy.stats).map(([label, value]) => ({ label, value }));
      const safeRows = rows.map((r) => ({
        label: escapeHtml(String(r.label)),
        value: escapeHtml(String(r.value)),
      }));

      return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8"/>
  <style>${this._reportStyles()}</style>
</head>
<body>
  <div class="header">
    <div class="logo">SIFAT LIBRARY</div>
    <h1>${safeTitle}</h1>
    <p>Milliy kutubxonlik monitoringi tizimi</p>
    <div class="badge">📅 ${safePeriod}</div>
  </div>
  <div class="body">
    <div class="section-title">📊 Ko'rsatkichlar</div>
    <table>
      <thead>
        <tr><th>Ko'rsatkich</th><th class="value">Qiymat</th></tr>
      </thead>
      <tbody>
        ${safeRows.map((r) => `<tr><td>${r.label}</td><td class="value">${r.value}</td></tr>`).join("")}
      </tbody>
    </table>
    <div class="footer">
      <span>Yaratilgan: ${safeDate}</span>
      <span>O'zbekiston Respublikasi · Yoshlar ishlari agentligi</span>
    </div>
  </div>
  <div class="watermark">PQ-9 muvofiqlik hisoboti · SIFAT LIBRARY v1.0</div>
</body>
</html>`;
    }

    // Extended ReportData shape — full scope-parameterized PDF.
    const ext = data as ReportData;
    const safeScopeLabel = escapeHtml(ext.scopeLabel);
    const safeRows = ext.tableRows.map((r) => ({
      label: escapeHtml(String(r.label)),
      value: escapeHtml(String(r.value)),
    }));

    const isDev = (process.env.NODE_ENV ?? "").toLowerCase() !== "production";
    const watermarkExtra = isDev ? " · DEV PREVIEW" : "";
    const scopeIdTag = scopeId ? ` · ${escapeHtml(scopeId)}` : "";

    return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8"/>
  <style>${this._reportStyles()}</style>
</head>
<body>
  <div class="header">
    <div class="logo">SIFAT LIBRARY</div>
    <h1>${safeTitle}</h1>
    <p>${safeScopeLabel} · Milliy kutubxonlik monitoringi</p>
    <div class="badge">📅 ${safePeriod}${scopeIdTag}</div>
  </div>
  <div class="body">
    <div class="section-title">📊 Asosiy ko'rsatkichlar</div>
    <table>
      <thead>
        <tr><th>Ko'rsatkich</th><th class="value">Qiymat</th></tr>
      </thead>
      <tbody>
        ${safeRows.map((r) => `<tr><td>${r.label}</td><td class="value">${r.value}</td></tr>`).join("")}
      </tbody>
    </table>

    <div class="section-title" style="margin-top: 24px;">👥 Gender taqsimoti</div>
    ${this._renderBucketTable(ext.genderBuckets, "Toifa")}
    ${this._renderBarChartSvg(
      ext.genderBuckets
        .filter((b) => !b.suppressed)
        .map((b) => ({ label: b.label, value: b.count })),
    )}

    <div class="section-title" style="margin-top: 24px;">📚 Yosh guruhi</div>
    ${this._renderBucketTable(ext.ageBuckets, "Yosh")}
    ${this._renderBarChartSvg(
      ext.ageBuckets
        .filter((b) => !b.suppressed)
        .map((b) => ({ label: b.label, value: b.count })),
    )}

    <div class="section-title" style="margin-top: 24px;">🏛️ Eng faol kutubxonalar (Top-5)</div>
    ${ext.topLibraries.length > 0
      ? `<table>
           <thead><tr><th>#</th><th>Kutubxona</th><th class="value">Tranzaksiyalar</th></tr></thead>
           <tbody>
             ${ext.topLibraries
               .map(
                 (l) =>
                   `<tr><td>${l.rank}</td><td>${escapeHtml(l.name)}</td><td class="value">${escapeHtml(
                     l.transactions.toLocaleString("uz-UZ"),
                   )}</td></tr>`,
               )
               .join("")}
           </tbody>
         </table>`
      : `<p class="muted">Ma'lumot yo'q</p>`}

    <div class="section-title" style="margin-top: 24px;">⭐ Eng faol kitobxonlar (Top-5)</div>
    ${ext.topReaders.length > 0
      ? `<table>
           <thead><tr><th>#</th><th>Kitobxon</th><th class="value">Reading Index</th></tr></thead>
           <tbody>
             ${ext.topReaders
               .map(
                 (rd) =>
                   `<tr><td>${rd.rank}</td><td>${escapeHtml(rd.name)}</td><td class="value">${escapeHtml(
                     String(rd.score),
                   )}</td></tr>`,
               )
               .join("")}
           </tbody>
         </table>`
      : `<p class="muted">Ma'lumot yo'q</p>`}

    <div class="footer">
      <span>Yaratilgan: ${safeDate}</span>
      <span>O'zbekiston Respublikasi · Yoshlar ishlari agentligi</span>
    </div>
  </div>
  <div class="watermark">PQ-9 muvofiqlik hisoboti · SIFAT LIBRARY v1.0${watermarkExtra}</div>
</body>
</html>`;
  }

  // ── Plan 05-08 T1 internals ─────────────────────────────────────────────

  private _reportStyles(): string {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Arial', sans-serif; color: #1a1a1a; background: #fff; }
      .header { background: linear-gradient(135deg, #1e40af 0%, #3b82f6 100%); color: white; padding: 32px 40px; }
      .header h1 { font-size: 24px; font-weight: 800; }
      .header p  { font-size: 13px; opacity: 0.8; margin-top: 6px; }
      .badge { display: inline-block; background: rgba(255,255,255,0.2); border-radius: 20px; padding: 4px 14px; font-size: 12px; margin-top: 10px; }
      .body { padding: 32px 40px; }
      .section-title { font-size: 16px; font-weight: 700; color: #1e40af; border-bottom: 2px solid #dbeafe; padding-bottom: 8px; margin-bottom: 16px; }
      table { width: 100%; border-collapse: collapse; }
      th { background: #f0f9ff; color: #1e40af; text-align: left; padding: 10px 14px; font-size: 13px; }
      td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #f1f5f9; }
      tr:last-child td { border-bottom: none; }
      tr:hover td { background: #f8fafc; }
      .value { font-weight: 700; color: #1a1a1a; text-align: right; }
      .muted { font-size: 12px; color: #94a3b8; margin: 12px 0; }
      .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between; }
      .logo { font-weight: 800; color: #1e40af; font-size: 14px; }
      .watermark { font-size: 9px; color: #e2e8f0; text-align: center; margin-top: 20px; }
      svg.barchart { display: block; margin: 12px 0 4px; }
    `;
  }

  private _renderBucketTable(
    buckets: Array<{ label: string; count: number; readingIndex: number; suppressed: boolean }>,
    headerLabel: string,
  ): string {
    if (buckets.length === 0) return `<p class="muted">Ma'lumot yo'q</p>`;
    return `<table>
      <thead>
        <tr><th>${escapeHtml(headerLabel)}</th><th class="value">Foydalanuvchilar</th><th class="value">Reading Index</th></tr>
      </thead>
      <tbody>
        ${buckets
          .map((b) =>
            b.suppressed
              ? `<tr><td>${escapeHtml(b.label)}</td><td class="value">—</td><td class="value">—</td></tr>`
              : `<tr><td>${escapeHtml(b.label)}</td><td class="value">${escapeHtml(
                  b.count.toLocaleString("uz-UZ"),
                )}</td><td class="value">${escapeHtml(String(b.readingIndex))}</td></tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
  }

  /**
   * Plan 05-08 T1 — inline SVG bar chart for embedded bucket visualisation.
   * No external deps (matches Plan 05-08 D-6 "pick SVG for simplicity").
   * All labels are escapeHtml-ed; chart geometry is hardcoded.
   */
  private _renderBarChartSvg(values: Array<{ label: string; value: number }>): string {
    if (values.length === 0) return "";
    const W = 520;
    const H = 140;
    const padLeft = 80;
    const padBottom = 28;
    const padTop = 12;
    const max = Math.max(1, ...values.map((v) => v.value));
    const barGap = 8;
    const innerW = W - padLeft - 12;
    const barW = Math.max(8, innerW / values.length - barGap);

    const bars = values
      .map((v, i) => {
        const ratio = v.value / max;
        const h = Math.max(1, (H - padTop - padBottom) * ratio);
        const x = padLeft + i * (barW + barGap);
        const y = H - padBottom - h;
        const safeLabel = escapeHtml(v.label);
        const safeVal = escapeHtml(v.value.toLocaleString("uz-UZ"));
        return `
          <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="#3b82f6" rx="3"/>
          <text x="${x + barW / 2}" y="${H - padBottom + 14}" font-size="10" fill="#475569" text-anchor="middle">${safeLabel}</text>
          <text x="${x + barW / 2}" y="${y - 4}" font-size="10" fill="#1e40af" text-anchor="middle">${safeVal}</text>
        `;
      })
      .join("");

    return `<svg class="barchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bar chart">
      <line x1="${padLeft}" y1="${H - padBottom}" x2="${W - 4}" y2="${H - padBottom}" stroke="#cbd5e1" stroke-width="1"/>
      ${bars}
    </svg>`;
  }

  /**
   * Plan 05-08 RPT-01 — Convenience wrapper: takes scope-parameterized
   * ReportData and renders it directly to a PDF Buffer. Used by
   * AdminController.downloadMonthlyReport + ReportEmailProcessor.
   */
  async generateMonthlyReport(data: ReportData, scope: ReportScope, scopeId?: string): Promise<Buffer> {
    const html = this.buildMonthlyReportHtml(data, scope, scopeId);
    return this.generateFromHtml(html);
  }

  // ── Plan 06-02 SCH-08 — School PQ-9 Report HTML Template ───────────────
  //
  // Renders the school PQ-9 PDF with the Jadidlar Izidan section. Every
  // DB-sourced string (schoolName, club.name, classBuckets[].className) flows
  // through `escapeHtml`. Numerics through Number(). K-anonymity suppression
  // for small classes renders "—" instead of avgRi.
  //
  // The PDF template is decoupled from the Plan 05-08 RPT-01 monthly report
  // so school-specific extensions (per-club debate count, 20-book aggregate)
  // can evolve without bloating the core admin report.
  generateSchoolPq9Report(data: {
    title: string;
    period: string;
    generatedAt: string;
    schoolName: string;
    stats: {
      totalStudents: number;
      activeStudents: number;
      coverageRate: number;
      avgRi: number;
      activeClubs: number;
      monthlyTransactions: number;
    };
    classBuckets: Array<{
      className: string;
      total: number;
      pending?: number;
      active?: number;
      avgRi: number | null;
      kAnonymitySuppressed: boolean;
    }>;
    jadidlarSection: {
      clubs: Array<{
        name: string;
        memberCount: number;
        quarterDebates: number;
        lastDebateAt: string | null;
      }>;
      inactiveClubs: Array<{ name: string; daysSince: number }>;
    };
    goalAchievement: { target: number; achieved: number; rate: number };
    ranking?: { rank: number | null; totalScore: number };
  }): string {
    const safeTitle = escapeHtml(data.title);
    const safePeriod = escapeHtml(data.period);
    const safeDate = escapeHtml(data.generatedAt);
    const safeSchoolName = escapeHtml(data.schoolName);

    const isDev = (process.env.NODE_ENV ?? "").toLowerCase() !== "production";
    const watermarkExtra = isDev ? " · DEV PREVIEW" : "";

    // KPI table rows
    const kpiRows = [
      { label: "Jami o'quvchilar", value: Number(data.stats.totalStudents).toLocaleString("uz-UZ") },
      { label: "Faol o'quvchilar", value: `${Number(data.stats.activeStudents).toLocaleString("uz-UZ")} (${Number(data.stats.coverageRate)}%)` },
      { label: "O'rtacha Reading Index", value: `${Number(data.stats.avgRi)} ball` },
      { label: "20 kitob maqsadi", value: `${Number(data.goalAchievement.achieved)} kishi (${Number(data.goalAchievement.rate)}%)` },
      { label: "Faol Jadidlar izidan klublari", value: Number(data.stats.activeClubs).toLocaleString("uz-UZ") },
      { label: "Bu oy tranzaksiyalar", value: Number(data.stats.monthlyTransactions).toLocaleString("uz-UZ") },
      { label: "Respublika reytingi", value: data.ranking?.rank ? `${Number(data.ranking.rank)}-o'rin` : "Hisoblanmagan" },
    ].map((r) => ({ label: escapeHtml(r.label), value: escapeHtml(r.value) }));

    // Class buckets section
    const classRows = (data.classBuckets ?? []).map((c) => {
      const safeClass = escapeHtml(c.className);
      const total = Number(c.total);
      const avgRi = c.kAnonymitySuppressed
        ? "—"
        : escapeHtml(String(Number(c.avgRi ?? 0)));
      return `<tr><td>${safeClass}</td><td class="value">${escapeHtml(total.toLocaleString("uz-UZ"))}</td><td class="value">${avgRi}</td></tr>`;
    }).join("");

    // Jadidlar Izidan section — per-club table with escape on every DB string.
    const jadidlarRows = (data.jadidlarSection?.clubs ?? []).map((c) => {
      const safeName = escapeHtml(c.name);
      const memberCount = Number(c.memberCount);
      const quarterDebates = Number(c.quarterDebates);
      const last = c.lastDebateAt ? escapeHtml(String(c.lastDebateAt)) : "—";
      return `<tr><td>${safeName}</td><td class="value">${escapeHtml(memberCount.toLocaleString("uz-UZ"))}</td><td class="value">${escapeHtml(quarterDebates.toLocaleString("uz-UZ"))}</td><td class="value">${last}</td></tr>`;
    }).join("");

    const inactiveRows = (data.jadidlarSection?.inactiveClubs ?? []).map((c) => {
      const safeName = escapeHtml(c.name);
      const days = Number(c.daysSince);
      return `<tr><td>${safeName}</td><td class="value">${escapeHtml(days.toLocaleString("uz-UZ"))} kun</td></tr>`;
    }).join("");

    return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8"/>
  <style>${this._reportStyles()}</style>
</head>
<body>
  <div class="header">
    <div class="logo">SIFAT LIBRARY</div>
    <h1>${safeTitle}</h1>
    <p>${safeSchoolName} · PQ-9 Muvofiqlik Hisoboti</p>
    <div class="badge">📅 ${safePeriod}</div>
  </div>
  <div class="body">
    <div class="section-title">📊 Asosiy ko'rsatkichlar</div>
    <table>
      <thead><tr><th>Ko'rsatkich</th><th class="value">Qiymat</th></tr></thead>
      <tbody>
        ${kpiRows.map((r) => `<tr><td>${r.label}</td><td class="value">${r.value}</td></tr>`).join("")}
      </tbody>
    </table>

    <div class="section-title" style="margin-top: 24px;">🎓 Sinf bo'yicha o'quvchilar</div>
    ${classRows.length > 0
      ? `<table>
           <thead><tr><th>Sinf</th><th class="value">Jami</th><th class="value">O'rtacha RI</th></tr></thead>
           <tbody>${classRows}</tbody>
         </table>
         <p class="muted">Maxfiylik chegarasi (k&lt;5) — kichik sinflarda o'rtacha RI yashirilgan.</p>`
      : `<p class="muted">Sinf ma'lumoti yo'q</p>`}

    <div class="section-title" style="margin-top: 24px;">📚 Jadidlar Izidan klublari</div>
    ${jadidlarRows.length > 0
      ? `<table>
           <thead><tr><th>Klub</th><th class="value">A'zolar</th><th class="value">Choraklik debat</th><th class="value">Oxirgi debat</th></tr></thead>
           <tbody>${jadidlarRows}</tbody>
         </table>`
      : `<p class="muted">Klub ma'lumoti yo'q</p>`}

    ${inactiveRows.length > 0
      ? `<div class="section-title" style="margin-top: 16px;">⚠️ Faolsiz klublar (30+ kun)</div>
         <table>
           <thead><tr><th>Klub</th><th class="value">Oxirgi debatdan beri</th></tr></thead>
           <tbody>${inactiveRows}</tbody>
         </table>`
      : ""}

    <div class="footer">
      <span>Yaratilgan: ${safeDate}</span>
      <span>O'zbekiston Respublikasi · Yoshlar ishlari agentligi</span>
    </div>
  </div>
  <div class="watermark">PQ-9 Maktab hisoboti · SIFAT LIBRARY v1.0${watermarkExtra}</div>
</body>
</html>`;
  }

  // ── Plan 06-05 ORG-06 — Idora PQ-9 Report HTML Template ────────────────
  //
  // Renders the idora PQ-9 PDF with sections: bookCorner (active badge + last
  // verified date + 3 thumbnails), readingHours (count + last event), mvp
  // (PQ-9 §9b(d) mukofot taklifi), rankingTop10, profBooks. EVERY DB string
  // (institutionName, mvp.userName, mvp.department, profBooks[].title/.author,
  // rankingTop10[].userName/.department) flows through `escapeHtml`. Numerics
  // through Number(). K-anonymity is enforced upstream by IdoraService.
  generateIdoraPq9Report(data: {
    title: string;
    period: string;
    generatedAt: string;
    institutionName: string;
    bookCorner: {
      isActive: boolean;
      lastVerifiedAt: Date | string | null;
      nextReminderAt: Date | string | null;
      photos: string[];
    };
    readingHours: {
      thisMonth: number;
      total: number;
      lastEventAt: Date | string | null;
      daysSinceLastEvent: number | null;
    };
    mvp: {
      userName: string;
      department: string | null;
      avgRi: number;
      booksRead: number;
    } | null;
    rankingTop10: Array<{
      rank: number;
      userName: string;
      department: string | null;
      avgRi: number;
      booksRead: number;
    }>;
    profBooks: Array<{
      title: string;
      author: string;
      isRequired: boolean;
    }>;
    employeeCount: number;
    mukofotHistory?: Array<{ createdAt: Date | string; analysis: string }>;
  }): string {
    const safeTitle = escapeHtml(data.title);
    const safePeriod = escapeHtml(data.period);
    const safeDate = escapeHtml(data.generatedAt);
    const safeInstitutionName = escapeHtml(data.institutionName);

    const isDev = (process.env.NODE_ENV ?? "").toLowerCase() !== "production";
    const watermarkExtra = isDev ? " · DEV PREVIEW" : "";

    const kpiCards = [
      { label: "Jami xodimlar", value: Number(data.employeeCount).toLocaleString("uz-UZ") },
      { label: "Bu oy o'qish soati", value: Number(data.readingHours.thisMonth).toLocaleString("uz-UZ") },
      { label: "Jami tadbirlar", value: Number(data.readingHours.total).toLocaleString("uz-UZ") },
      { label: "Kasb adabiyotlar", value: Number(data.profBooks.length).toLocaleString("uz-UZ") },
    ];

    const cornerStatus = data.bookCorner.isActive
      ? `<span class="idora-badge green">✓ Faol</span>`
      : `<span class="idora-badge red">✗ Yangilanishi kerak</span>`;
    const cornerLast = data.bookCorner.lastVerifiedAt
      ? escapeHtml(new Date(data.bookCorner.lastVerifiedAt).toLocaleDateString("uz-UZ"))
      : "—";
    const cornerNext = data.bookCorner.nextReminderAt
      ? escapeHtml(new Date(data.bookCorner.nextReminderAt).toLocaleDateString("uz-UZ"))
      : "—";

    const readingHoursLast = data.readingHours.lastEventAt
      ? escapeHtml(new Date(data.readingHours.lastEventAt).toLocaleDateString("uz-UZ"))
      : "Hali yo'q";
    const readingHoursDays =
      data.readingHours.daysSinceLastEvent != null
        ? escapeHtml(String(Number(data.readingHours.daysSinceLastEvent)))
        : "—";

    const profBookRows = (data.profBooks ?? []).slice(0, 10).map((b, i) => {
      const safeBookTitle = escapeHtml(b.title);
      const safeBookAuthor = escapeHtml(b.author);
      const reqBadge = b.isRequired
        ? `<span class="idora-badge green">Ha</span>`
        : `<span class="idora-badge">Yo'q</span>`;
      return `<tr><td>${i + 1}</td><td>${safeBookTitle}</td><td>${safeBookAuthor}</td><td>${reqBadge}</td></tr>`;
    }).join("");

    const rankingRows = (data.rankingTop10 ?? []).map((r) => {
      const safeName = escapeHtml(r.userName);
      const safeDept = escapeHtml(r.department ?? "—");
      return `<tr>
        <td>${Number(r.rank)}</td>
        <td>${safeName}</td>
        <td>${safeDept}</td>
        <td class="value">${Number(r.avgRi).toFixed(1)}</td>
        <td class="value">${Number(r.booksRead)}</td>
      </tr>`;
    }).join("");

    const mvpSection = data.mvp
      ? `<table>
          <thead><tr><th>Ism</th><th>Bo'lim</th><th class="value">Reading Index</th><th class="value">Kitoblar</th></tr></thead>
          <tbody>
          <tr>
            <td>🏆 ${escapeHtml(data.mvp.userName)}</td>
            <td>${escapeHtml(data.mvp.department ?? "—")}</td>
            <td class="value">${Number(data.mvp.avgRi).toFixed(1)}</td>
            <td class="value">${Number(data.mvp.booksRead)}</td>
          </tr>
          </tbody>
        </table>
        <p class="muted">🏆 PQ-9 §9b(d) mukofot taklifi — HR admin tasdiqlaganidan so'ng tashqi tartibda mukofotlanadi.</p>`
      : `<p class="muted">Bu oy ma'lumot mavjud emas.</p>`;

    const mukofotRows = (data.mukofotHistory ?? []).slice(0, 5).map((m) => {
      const safeDate = escapeHtml(new Date(m.createdAt).toLocaleDateString("uz-UZ"));
      const safeAnalysis = escapeHtml(m.analysis);
      return `<tr><td>${safeDate}</td><td>${safeAnalysis}</td></tr>`;
    }).join("");

    return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8"/>
  <style>${this._reportStyles()}
    .idora-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; background: #f1f5f9; color: #475569; }
    .idora-badge.green { background: #dcfce7; color: #166534; }
    .idora-badge.red { background: #fee2e2; color: #991b1b; }
    .kpi-row { display: flex; gap: 12px; margin-bottom: 20px; }
    .kpi-card { flex: 1; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; text-align: center; }
    .kpi-card .num { font-size: 22px; font-weight: 800; color: #1e40af; }
    .kpi-card .label { font-size: 11px; color: #6b7280; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">SIFAT LIBRARY</div>
    <h1>${safeTitle}</h1>
    <p>${safeInstitutionName} · PQ-9 Muvofiqlik Hisoboti</p>
    <div class="badge">📅 ${safePeriod}</div>
  </div>
  <div class="body">
    <div class="section-title">📊 Asosiy ko'rsatkichlar</div>
    <div class="kpi-row">
      ${kpiCards.map((c) => `<div class="kpi-card"><div class="num">${escapeHtml(String(c.value))}</div><div class="label">${escapeHtml(c.label)}</div></div>`).join("")}
    </div>

    <div class="section-title" style="margin-top: 20px;">📚 1. Kitob Burchagi (PQ-9 §9b(b))</div>
    <table>
      <thead><tr><th>Holat</th><th>Oxirgi tekshiruv</th><th>Keyingi eslatma</th></tr></thead>
      <tbody>
        <tr>
          <td>${cornerStatus}</td>
          <td>${cornerLast}</td>
          <td>${cornerNext}</td>
        </tr>
      </tbody>
    </table>

    <div class="section-title" style="margin-top: 20px;">📖 2. Kitob O'qish Soati (PQ-9 §9b(c))</div>
    <table>
      <thead><tr><th class="value">Jami</th><th class="value">Bu oy</th><th>Oxirgi tadbir</th><th class="value">Kunlar o'tdi</th></tr></thead>
      <tbody>
        <tr>
          <td class="value">${Number(data.readingHours.total)}</td>
          <td class="value">${Number(data.readingHours.thisMonth)}</td>
          <td>${readingHoursLast}</td>
          <td class="value">${readingHoursDays}</td>
        </tr>
      </tbody>
    </table>

    <div class="section-title" style="margin-top: 20px;">📋 3. Kasb Adabiyotlari (PQ-9 §9b(g))</div>
    ${profBookRows.length > 0
      ? `<table>
          <thead><tr><th>#</th><th>Kitob nomi</th><th>Muallif</th><th>Majburiy</th></tr></thead>
          <tbody>${profBookRows}</tbody>
        </table>`
      : `<p class="muted">Kasb adabiyotlar qo'shilmagan</p>`}

    <div class="section-title" style="margin-top: 20px;">🏆 4. Eng Faol Xodim (PQ-9 §9b(d) Mukofot taklifi)</div>
    ${mvpSection}

    <div class="section-title" style="margin-top: 20px;">⭐ 5. Top-10 Xodim Reytingi</div>
    ${rankingRows.length > 0
      ? `<table>
          <thead><tr><th>#</th><th>Ism</th><th>Bo'lim</th><th class="value">Reading Index</th><th class="value">Kitoblar</th></tr></thead>
          <tbody>${rankingRows}</tbody>
        </table>`
      : `<p class="muted">Reyting hisoblanmagan</p>`}

    ${mukofotRows.length > 0
      ? `<div class="section-title" style="margin-top: 20px;">📜 Mukofot taklifi tarixi</div>
         <table>
           <thead><tr><th>Sana</th><th>Tafsilot</th></tr></thead>
           <tbody>${mukofotRows}</tbody>
         </table>`
      : ""}

    <div class="footer">
      <span>Yaratilgan: ${safeDate}</span>
      <span>O'zbekiston Respublikasi · Yoshlar ishlari agentligi</span>
    </div>
  </div>
  <div class="watermark">PQ-9 Idora hisoboti · SIFAT LIBRARY v1.0${watermarkExtra}</div>
</body>
</html>`;
  }

  // ── Plan 06-07 UNI-03 — OTM Akkreditatsiya Hisoboti HTML Template ──────
  //
  // Renders the OTM akkreditatsiya report with sections: per-faculty
  // breakdown (aggregated only — NO per-student PII per D-Q7), digital
  // library checklist (PASS/FAIL color-coded), and the prof books table.
  // EVERY DB-sourced string (institution.name, byFaculty[].faculty,
  // checklist[].criterion/.note, profBooks[].title/.author/.genre) flows
  // through `escapeHtml`. Numerics coerced via Number(). K-anonymity is
  // enforced upstream by OtmService.composeAccreditationData.
  generateAkkreditatsiyaReport(data: {
    scope: "OTM";
    institution: { id: string; name: string };
    academicYear: string;
    quarter: string;
    generatedAt: string;
    summary: {
      totalStudents: number;
      activeStudents: number;
      pendingStudents: number;
      coverageRate: number;
      avgRi: number;
      activeClubs: number;
      monthlyTransactions: number;
      goalAchievement: { target: number; achieved: number; rate: number };
    };
    byFaculty: Array<{
      faculty: string;
      studentCount: number;
      avgRi: number | null;
      kAnonymitySuppressed: boolean;
    }>;
    digitalLibraryChecklist: Array<{
      criterion: string;
      status: "PASS" | "FAIL";
      note?: string;
    }>;
    profBooks: Array<{
      title: string;
      author: string;
      genre: string | null;
      isRequired: boolean;
    }>;
  }): string {
    const safeInstitutionName = escapeHtml(data.institution.name);
    const safeAcademicYear = escapeHtml(data.academicYear);
    const safeQuarter = escapeHtml(data.quarter);
    const safeDate = escapeHtml(
      new Date(data.generatedAt).toLocaleDateString("uz-UZ"),
    );

    const isDev = (process.env.NODE_ENV ?? "").toLowerCase() !== "production";
    const watermarkExtra = isDev ? " · DEV PREVIEW" : "";

    // KPI cards
    const kpiCards = [
      { label: "Jami talabalar", value: Number(data.summary.totalStudents).toLocaleString("uz-UZ") },
      { label: "Faol talabalar", value: Number(data.summary.activeStudents).toLocaleString("uz-UZ") },
      { label: "Qamrov %", value: `${Number(data.summary.coverageRate)}%` },
      { label: "O'rtacha RI", value: `${Number(data.summary.avgRi)}` },
      { label: "10+ kitob o'qigan", value: Number(data.summary.goalAchievement.achieved).toLocaleString("uz-UZ") },
      { label: "Faol klublar", value: Number(data.summary.activeClubs).toLocaleString("uz-UZ") },
    ];

    // Plan 06-07 UNI-03 — per-faculty rows. K-anon suppressed avgRi → "—".
    const facultyRows = (data.byFaculty ?? []).map((f) => {
      const safeFaculty = escapeHtml(f.faculty);
      const count = Number(f.studentCount);
      const avgRi = f.kAnonymitySuppressed
        ? "—"
        : escapeHtml(String(Number(f.avgRi ?? 0)));
      return `<tr><td>${safeFaculty}</td><td class="value">${escapeHtml(count.toLocaleString("uz-UZ"))}</td><td class="value">${avgRi}</td></tr>`;
    }).join("");

    // Checklist rows — PASS green, FAIL red. note text DB-sourced → escape.
    const checklistRows = (data.digitalLibraryChecklist ?? []).map((c) => {
      const safeCriterion = escapeHtml(c.criterion);
      const safeNote = escapeHtml(c.note ?? "");
      const badge = c.status === "PASS"
        ? `<span class="akk-badge green">✓ PASS</span>`
        : `<span class="akk-badge red">✗ FAIL</span>`;
      return `<tr><td>${safeCriterion}</td><td>${badge}</td><td class="muted-cell">${safeNote}</td></tr>`;
    }).join("");

    // Prof books — every string escaped.
    const profBookRows = (data.profBooks ?? []).slice(0, 20).map((b, i) => {
      const safeTitle = escapeHtml(b.title);
      const safeAuthor = escapeHtml(b.author);
      const safeGenre = escapeHtml(b.genre ?? "—");
      const required = b.isRequired
        ? `<span class="akk-badge green">Ha</span>`
        : `<span class="akk-badge">Yo'q</span>`;
      return `<tr><td>${i + 1}</td><td>${safeTitle}</td><td>${safeAuthor}</td><td>${safeGenre}</td><td>${required}</td></tr>`;
    }).join("");

    return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8"/>
  <style>${this._reportStyles()}
    .akk-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: bold; background: #f1f5f9; color: #475569; }
    .akk-badge.green { background: #dcfce7; color: #166534; }
    .akk-badge.red { background: #fee2e2; color: #991b1b; }
    .akk-kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 18px; }
    .akk-kpi { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; text-align: center; }
    .akk-kpi .num { font-size: 20px; font-weight: 800; color: #1e40af; }
    .akk-kpi .label { font-size: 11px; color: #6b7280; margin-top: 4px; }
    .muted-cell { color: #64748b; font-size: 11px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">SIFAT LIBRARY</div>
    <h1>OTM Akkreditatsiya Hisoboti</h1>
    <p>${safeInstitutionName} · ${safeAcademicYear} o'quv yili</p>
    <div class="badge">📅 ${safeQuarter}</div>
  </div>
  <div class="body">
    <div class="section-title">📊 Asosiy ko'rsatkichlar</div>
    <div class="akk-kpi-row">
      ${kpiCards.map((c) => `<div class="akk-kpi"><div class="num">${escapeHtml(String(c.value))}</div><div class="label">${escapeHtml(c.label)}</div></div>`).join("")}
    </div>

    <div class="section-title" style="margin-top: 20px;">🎓 Fakultetlar bo'yicha</div>
    ${facultyRows.length > 0
      ? `<table>
          <thead><tr><th>Fakultet</th><th class="value">Talabalar</th><th class="value">O'rtacha RI</th></tr></thead>
          <tbody>${facultyRows}</tbody>
        </table>
        <p class="muted">Maxfiylik chegarasi (k&lt;5) — kichik fakultetlar uchun o'rtacha RI yashirilgan. PII (ism, telefon) hisobotga kiritilmagan.</p>`
      : `<p class="muted">Fakultet ma'lumoti yo'q</p>`}

    <div class="section-title" style="margin-top: 20px;">✅ Raqamli kutubxona tekshiruv ro'yhati</div>
    ${checklistRows.length > 0
      ? `<table>
          <thead><tr><th>Mezon</th><th>Holat</th><th>Izoh</th></tr></thead>
          <tbody>${checklistRows}</tbody>
        </table>`
      : `<p class="muted">Tekshiruv ro'yhati bo'sh</p>`}

    <div class="section-title" style="margin-top: 20px;">📚 Tavsiya etiladigan ilmiy adabiyotlar</div>
    ${profBookRows.length > 0
      ? `<table>
          <thead><tr><th>#</th><th>Sarlavha</th><th>Muallif</th><th>Janr</th><th>Majburiy</th></tr></thead>
          <tbody>${profBookRows}</tbody>
        </table>`
      : `<p class="muted">Hali ilmiy adabiyot qo'shilmagan</p>`}

    <div class="footer">
      <span>Yaratilgan: ${safeDate}</span>
      <span>O'zbekiston Respublikasi · Yoshlar ishlari agentligi</span>
    </div>
  </div>
  <div class="watermark">PQ-9 OTM Akkreditatsiya hisoboti · SIFAT LIBRARY v1.0${watermarkExtra}</div>
</body>
</html>`;
  }
}
