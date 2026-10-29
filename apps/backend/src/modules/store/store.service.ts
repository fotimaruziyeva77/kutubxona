import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import * as crypto from "crypto";
import * as ExcelJS from "exceljs";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CacheService } from "../../infra/cache/cache.service";
import { KafkaService, KAFKA_TOPICS } from "../../infra/kafka/kafka.service";
import { SearchService } from "../../infra/elasticsearch/elasticsearch.service";
import { STORE_PRODUCT_IMPORT_QUEUE } from "../../infra/queue/queue-names";
import type {
  UpdateStoreDto,
  CreateStoreProductDto,
  UpdateStoreProductDto,
  StoreProductSearchDto,
  StoreProductImportJobData,
} from "./dto/store.dto";

/**
 * Do'kon (Kitob do'koni) API integratsiyasi
 *
 * Phase 8 Plan 08-01 extends this service with:
 *   - Store CRUD (dedicated Store model, replaces Institution workaround)
 *   - Product catalog CRUD (StoreProduct)
 *   - Elasticsearch sync for store products
 *   - Excel product import via BullMQ
 *   - Premium badge management (SUPER_ADMIN only)
 *
 * Original jarayon (preserved):
 *   1. Do'kon HMAC-SHA256 imzo bilan POST /api/v1/purchases yuboradi
 *   2. Backend imzoni tekshiradi, duplicate ni rad etadi
 *   3. IsbnScan yaratadi (source: "STORE_MANUAL")
 *   4. Kitobxon 24 soat ichida tasdiqlaydi -> Reading Index yangilanadi
 *   5. Do'kon API ga "accepted" qaytariladi
 */
@Injectable()
export class StoreService {
  private readonly logger = new Logger(StoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly kafka: KafkaService,
    private readonly config: ConfigService,
    private readonly search: SearchService,
    @InjectQueue(STORE_PRODUCT_IMPORT_QUEUE)
    private readonly importQueue: Queue<StoreProductImportJobData>,
  ) {}

  // ── Xarid qabul qilish (do'kon webhooks) ─────────────────────────────────

  async receivePurchase(storeId: string, body: PurchasePayload, signature: string): Promise<PurchaseResult> {
    // 1. Imzo tekshiruvi
    await this._verifySignature(body, signature, storeId);

    // 2. order_id majburiy — idempotency kaliti (H4). Bo'sh qoldirilsa
    // @@unique([storeId, orderId]) NULL tufayli ishlamay qolardi.
    if (!body.order_id) {
      throw new BadRequestException("order_id majburiy");
    }

    // 3. Foydalanuvchini telefon raqami bilan topamiz
    const user = await this.prisma.user.findFirst({
      where: { phone: body.phone },
      select: { id: true, name: true, phone: true },
    });
    if (!user) {
      return { status: "user_not_found", message: "Bu telefon raqamli foydalanuvchi topilmadi" };
    }

    // 4. Idempotency — order_id kaliti bilan (audit HIGH H4).
    //
    // order_id HMAC payload ichida (_verifySignature), shuning uchun uchinchi
    // tomon ushlangan webhook'ni boshqa order_id bilan replay qila olmaydi —
    // imzo mos kelmaydi. Bir xil (storeId, orderId) qayta kelsa — bu webhook
    // retry: avvalgi natijani qaytaramiz (idempotent ack, xato EMAS).
    //
    // H4 qarori: bir xil user+isbn+store, lekin BOSHQA order_id = alohida
    // xaridlar, har biri alohida yoziladi (bir kitobni qayta sotib olish —
    // qonuniy savdo). Bir user uchun bir xil ISBN'ga Reading Index krediti
    // dedup'i scoring vaqtida hal qilinadi (C5 fix), bu yerda emas.
    const existing = await this.prisma.isbnScan.findFirst({
      where: { storeId, orderId: body.order_id },
    });
    if (existing) {
      return { status: "duplicate", message: "Bu xarid allaqachon qayd etilgan", scanId: existing.id };
    }

    // 5. ISBN dan kitob ma'lumotlarini olish (Open Library fallback)
    const bookInfo = await this._lookupIsbn(body.isbn);

    // 6. IsbnScan yaratish — orderId saqlanadi
    let scan: { id: string };
    try {
      scan = await this.prisma.isbnScan.create({
        data: {
          userId: user.id,
          isbn: body.isbn,
          title: bookInfo.title ?? body.isbn,
          author: bookInfo.author ?? "Noma'lum",
          source: "STORE_MANUAL",
          storeId,
          orderId: body.order_id,
          confirmed: false,
        },
      });
    } catch (err: any) {
      // P2002 @@unique([storeId, orderId]) — parallel retry findFirst bilan
      // create orasida yutib ketdi (race). Xuddi shu idempotent ack'ga
      // yo'naltiramiz, 409 chiqarmaymiz.
      if (err?.code === "P2002") {
        const winner = await this.prisma.isbnScan.findFirst({
          where: { storeId, orderId: body.order_id },
        });
        if (winner) {
          return { status: "duplicate", message: "Bu xarid allaqachon qayd etilgan", scanId: winner.id };
        }
      }
      throw err;
    }

    // 7. Kafka event — kitobxonga bildirishnoma yuboriladi (ISBN_SCANNED topic)
    await this.kafka.emit({
      topic: KAFKA_TOPICS.ISBN_SCANNED,
      key: user.id,
      value: { userId: user.id, scanId: scan.id, isbn: body.isbn, storeId, source: "STORE_MANUAL" },
    });

    this.logger.log(`Do'kon xaridi qabul qilindi: ${storeId}, User: ${user.id}, ISBN: ${body.isbn}`);

    return {
      status: "accepted",
      message: "Xarid muvaffaqiyatli qabul qilindi. Kitobxon tasdiqlashi kutilmoqda.",
      scanId: scan.id,
    };
  }

  // ── Kitobxon tasdiqlashi ──────────────────────────────────────────────────
  //
  // STORE-01 (Plan 02-04): a 24-hour gate prevents stale confirmations.
  // After 24h from createdAt the scan can no longer be confirmed —
  // protects against social-engineering scans where a kitobxon is asked to
  // confirm an old/disputed purchase.

  async confirmPurchase(scanId: string, userId: string): Promise<{ confirmed: boolean }> {
    const scan = await this.prisma.isbnScan.findFirst({
      where: { id: scanId, userId },
    });
    if (!scan) throw new BadRequestException("Xarid topilmadi");
    if (scan.confirmed) return { confirmed: true };

    // STORE-01: 24h expiry gate (server-side time comparison — clock-skew
    // tolerant because both sides of the comparison are server time).
    const ageMs = Date.now() - scan.createdAt.getTime();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    if (ageMs > TWENTY_FOUR_HOURS) {
      throw new BadRequestException(
        "Mahalliy do'kon yozuvi 24 soatdan eski — bekor qilingan"
      );
    }

    await this.prisma.isbnScan.update({
      where: { id: scanId },
      data: { confirmed: true, confirmedAt: new Date() },
    });

    return { confirmed: true };
  }

  // ── Do'kon ro'yxatdan o'tkazish ──────────────────────────────────────────
  // Phase 8: creates a dedicated Store record (replaces Institution workaround).

  async registerStore(data: {
    name: string;
    phone?: string;
    address?: string;
    adminId: string;
    tumanId?: string;
    viloyatId?: string;
  }) {
    // StoreSecret — HMAC kalit generatsiya
    const secret = crypto.randomBytes(32).toString("hex");

    // Generate URL-safe slug from name
    const slug = await this._generateSlug(data.name);

    const store = await this.prisma.store.create({
      data: {
        name: data.name,
        slug,
        phone: data.phone,
        address: data.address,
        operatorId: data.adminId,
        hmacSecret: secret,
        tumanId: data.tumanId ?? "default",
        viloyatId: data.viloyatId ?? "default",
        status: "ACTIVE",
      },
    });

    return { storeId: store.id, name: store.name, slug: store.slug, secret: store.hmacSecret };
  }

  // ── Store CRUD (Phase 8 Plan 08-01) ──────────────────────────────────────

  async updateStore(storeId: string, operatorId: string, dto: UpdateStoreDto) {
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException("Do'kon topilmadi");
    if (store.operatorId !== operatorId) {
      throw new ForbiddenException("Bu do'konga ruxsat yo'q");
    }

    const updateData: Record<string, unknown> = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.slug !== undefined) updateData.slug = dto.slug;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.phone !== undefined) updateData.phone = dto.phone;
    if (dto.address !== undefined) updateData.address = dto.address;
    if (dto.lat !== undefined) updateData.lat = dto.lat;
    if (dto.lon !== undefined) updateData.lon = dto.lon;
    if (dto.workingHours !== undefined) updateData.workingHours = dto.workingHours;
    if (dto.logoUrl !== undefined) updateData.logoUrl = dto.logoUrl;
    if (dto.tumanId !== undefined) updateData.tumanId = dto.tumanId;
    if (dto.viloyatId !== undefined) updateData.viloyatId = dto.viloyatId;

    // Premium badge can ONLY be set via the dedicated setPremiumBadge endpoint (SUPER_ADMIN only)
    // Silently ignore premiumBadge in updateStore to prevent privilege escalation

    return this.prisma.store.update({ where: { id: storeId }, data: updateData });
  }

  // Joriy operatorga biriktirilgan do'kon (login'da CRM'ga yo'naltirish uchun).
  // Topilmasa null — frontend /dashboard'ga qaytadi.
  async getMyStore(operatorId: string) {
    return this.prisma.store.findFirst({
      where: { operatorId },
      select: { id: true, slug: true, name: true },
    });
  }

  async getStoreBySlug(slug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: {
        products: {
          where: { active: true },
          take: 20,
          orderBy: { title: "asc" },
        },
      },
    });
    if (!store) throw new NotFoundException("Do'kon topilmadi");

    const productCount = await this.prisma.storeProduct.count({
      where: { storeId: store.id, active: true },
    });

    // Strip sensitive fields from public response
    const { hmacSecret, operatorId, ...safeStore } = store;
    return { ...safeStore, productCount };
  }

  // Barcha faol do'konlar ro'yxati (ommaviy katalog / "Barcha do'konlar").
  // Maxfiy maydonlar (hmacSecret, operatorId) chiqarilmaydi.
  async listStores() {
    const stores = await this.prisma.store.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        slug: true,
        address: true,
        premiumBadge: true,
        logoUrl: true,
        lat: true,
        lon: true,
        _count: { select: { products: true } },
      },
      orderBy: [{ premiumBadge: "desc" }, { name: "asc" }],
    });
    return stores.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      address: s.address,
      premiumBadge: s.premiumBadge,
      logoUrl: s.logoUrl,
      lat: s.lat,
      lon: s.lon,
      productCount: s._count.products,
    }));
  }

  // ── Product CRUD ─────────────────────────────────────────────────────────

  async createProduct(storeId: string, operatorId: string, dto: CreateStoreProductDto) {
    const store = await this._verifyStoreOwnership(storeId, operatorId);

    // T-08-02: validate price and stockCount
    if (dto.price <= 0) throw new BadRequestException("Narx musbat son bo'lishi kerak");
    if (dto.stockCount < 0) throw new BadRequestException("Mavjud soni manfiy bo'lishi mumkin emas");

    const product = await this.prisma.storeProduct.create({
      data: {
        storeId,
        isbn: dto.isbn,
        title: dto.title,
        author: dto.author,
        genre: dto.genre,
        price: dto.price,
        stockCount: dto.stockCount,
        coverUrl: dto.coverUrl,
        description: dto.description,
        lang: dto.lang ?? "uz",
        pages: dto.pages ?? 0,
        year: dto.year ?? 0,
      },
    });

    await this._indexStoreProduct(product, store);
    return product;
  }

  async updateProduct(productId: string, operatorId: string, dto: UpdateStoreProductDto) {
    const product = await this.prisma.storeProduct.findUnique({
      where: { id: productId },
      include: { store: true },
    });
    if (!product) throw new NotFoundException("Mahsulot topilmadi");
    if (product.store.operatorId !== operatorId) {
      throw new ForbiddenException("Bu mahsulotga ruxsat yo'q");
    }

    // T-08-02: validate price and stockCount if provided
    if (dto.price !== undefined && dto.price <= 0) {
      throw new BadRequestException("Narx musbat son bo'lishi kerak");
    }
    if (dto.stockCount !== undefined && dto.stockCount < 0) {
      throw new BadRequestException("Mavjud soni manfiy bo'lishi mumkin emas");
    }

    const updateData: Record<string, unknown> = {};
    if (dto.isbn !== undefined) updateData.isbn = dto.isbn;
    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.author !== undefined) updateData.author = dto.author;
    if (dto.genre !== undefined) updateData.genre = dto.genre;
    if (dto.price !== undefined) updateData.price = dto.price;
    if (dto.stockCount !== undefined) updateData.stockCount = dto.stockCount;
    if (dto.coverUrl !== undefined) updateData.coverUrl = dto.coverUrl;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.lang !== undefined) updateData.lang = dto.lang;
    if (dto.pages !== undefined) updateData.pages = dto.pages;
    if (dto.year !== undefined) updateData.year = dto.year;

    const updated = await this.prisma.storeProduct.update({
      where: { id: productId },
      data: updateData,
      include: { store: true },
    });

    await this._indexStoreProduct(updated, updated.store);
    return updated;
  }

  async deleteProduct(productId: string, operatorId: string) {
    const product = await this.prisma.storeProduct.findUnique({
      where: { id: productId },
      include: { store: true },
    });
    if (!product) throw new NotFoundException("Mahsulot topilmadi");
    if (product.store.operatorId !== operatorId) {
      throw new ForbiddenException("Bu mahsulotga ruxsat yo'q");
    }

    // Soft delete
    await this.prisma.storeProduct.update({
      where: { id: productId },
      data: { active: false },
    });

    await this._removeStoreProductFromIndex(productId);
    return { message: "Mahsulot o'chirildi" };
  }

  async listProducts(storeId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.storeProduct.findMany({
        where: { storeId, active: true },
        orderBy: { title: "asc" },
        skip,
        take: limit,
      }),
      this.prisma.storeProduct.count({ where: { storeId, active: true } }),
    ]);
    return { items, total, page, limit };
  }

  // ── Excel import (SHOP-01) ───────────────────────────────────────────────

  async importProductsFromExcel(storeId: string, operatorId: string, fileBase64: string) {
    await this._verifyStoreOwnership(storeId, operatorId);

    const job = await this.importQueue.add(
      "store-product-import",
      { storeId, operatorId, fileBase64 },
      {
        attempts: 2,
        backoff: { type: "fixed", delay: 10000 },
        removeOnComplete: { count: 50 },
        removeOnFail: false,
      },
    );

    return { jobId: String(job.id), status: "queued" };
  }

  async getImportStatus(jobId: string) {
    const job = await this.importQueue.getJob(jobId);
    if (!job) {
      return { status: "unknown", processed: 0, total: 0, errors: [], progress: 0 };
    }

    const state = await job.getState();
    const data = (job.data ?? {}) as Partial<StoreProductImportJobData & {
      processed?: number;
      total?: number;
      errors?: { row: number; reason: string }[];
    }>;
    const progressRaw = job.progress;
    const progress =
      typeof progressRaw === "number"
        ? progressRaw
        : typeof progressRaw === "object" && progressRaw !== null && "percent" in progressRaw
          ? Number((progressRaw as { percent: number }).percent)
          : 0;

    return {
      status: state,
      processed: data.processed ?? 0,
      total: data.total ?? 0,
      errors: data.errors ?? [],
      progress: Math.round(progress),
    };
  }

  // ── Import shabloni (.xlsx) ───────────────────────────────────────────────
  // Do'kon operatori saytdan yuklab oladi, to'ldiradi va import qiladi. Ustun
  // nomlari import processori kutadigan sarlavhalarga AYNAN mos (ISBN, Title,
  // Author, Genre, Price, StockCount). 2 ta namuna qator ko'rsatma sifatida.
  async buildProductTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = "SIFAT LIBRARY";
    const ws = wb.addWorksheet("Kitoblar");

    ws.columns = [
      { header: "ISBN", key: "isbn", width: 20 },
      { header: "Title", key: "title", width: 36 },
      { header: "Author", key: "author", width: 26 },
      { header: "Genre", key: "genre", width: 18 },
      { header: "Price", key: "price", width: 14 },
      { header: "StockCount", key: "stockCount", width: 14 },
    ];

    // Sarlavha qatori — qalin, ko'k fon, oq matn.
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
    head.alignment = { vertical: "middle", horizontal: "left" };
    head.height = 22;

    // Namuna qatorlar (operator o'chirib o'rniga o'zinikini yozadi).
    ws.addRow({ isbn: "9789943000012", title: "Cho'l gulini sug'orma", author: "Abdulla Oripov", genre: "She'riyat", price: 45000, stockCount: 12 });
    ws.addRow({ isbn: "9789943111222", title: "O'tkan kunlar", author: "Abdulla Qodiriy", genre: "Roman", price: 60000, stockCount: 8 });

    const arrayBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ── Premium badge (SHOP-06, SUPER_ADMIN only) ────────────────────────────

  async setPremiumBadge(storeId: string, isPremium: boolean) {
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException("Do'kon topilmadi");

    const updateData: Record<string, unknown> = { premiumBadge: isPremium };
    if (isPremium && !store.premiumBadge) {
      updateData.premiumSince = new Date();
    }

    const updated = await this.prisma.store.update({
      where: { id: storeId },
      data: updateData,
    });

    // Reindex all store products to update premiumBadge field in ES (batched)
    const products = await this.prisma.storeProduct.findMany({
      where: { storeId, active: true },
    });
    const BATCH_SIZE = 50;
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map((product) => this._indexStoreProduct(product, updated))
      );
    }

    return updated;
  }

  // ── Do'kon statistikasi ───────────────────────────────────────────────────

  async getStoreStats(storeId: string) {
    const cacheKey = `store:stats:${storeId}`;
    return this.cache.remember(cacheKey, 300, async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [total, thisMonth, confirmed, pending, topBooks] = await Promise.all([
        this.prisma.isbnScan.count({ where: { storeId } }),
        this.prisma.isbnScan.count({ where: { storeId, createdAt: { gte: monthStart } } }),
        this.prisma.isbnScan.count({ where: { storeId, confirmed: true } }),
        this.prisma.isbnScan.count({ where: { storeId, confirmed: false } }),
        this.prisma.isbnScan.groupBy({
          by: ["isbn", "title", "author"],
          where: { storeId },
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
          take: 10,
        }),
      ]);

      // Oylik trend (oxirgi 6 oy)
      const monthlyTrend = await this._monthlyTrend(storeId, 6);

      return {
        total,
        thisMonth,
        confirmed,
        pending,
        confirmRate: total > 0 ? Math.round((confirmed / total) * 100) : 0,
        topBooks: topBooks.map((b) => ({
          isbn: b.isbn,
          title: b.title,
          author: b.author,
          count: b._count.id,
        })),
        monthlyTrend,
      };
    });
  }

  async getAdminStoreStats() {
    return this.cache.remember("store:admin:stats", 600, async () => {
      const [totalPurchases, confirmed, byStore] = await Promise.all([
        this.prisma.isbnScan.count({ where: { source: "STORE_MANUAL" } }),
        this.prisma.isbnScan.count({ where: { source: "STORE_MANUAL", confirmed: true } }),
        this.prisma.isbnScan.groupBy({
          by: ["storeId"],
          where: { source: "STORE_MANUAL", storeId: { not: null } },
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
          take: 20,
        }),
      ]);

      return {
        totalPurchases,
        confirmed,
        confirmRate: totalPurchases > 0 ? Math.round((confirmed / totalPurchases) * 100) : 0,
        byStore: byStore.map((s) => ({ storeId: s.storeId, count: s._count.id })),
      };
    });
  }

  async getStorePurchases(storeId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.isbnScan.findMany({
        where: { storeId },
        include: {
          user: { select: { id: true, name: true, phone: true, sifatId: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.isbnScan.count({ where: { storeId } }),
    ]);
    return { items, total, page, limit };
  }

  // ── CRM Dashboard (SHOP-05) ────────────────────────────────────────────────

  async getCrmDashboard(storeId: string, operatorId: string): Promise<CrmDashboardResult> {
    // 1. Ownership check with SUPER_ADMIN bypass
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException("Do'kon topilmadi");

    if (store.operatorId !== operatorId) {
      // Check if the user is SUPER_ADMIN
      const user = await this.prisma.user.findUnique({
        where: { id: operatorId },
        select: { role: true },
      });
      if (!user || user.role !== "SUPER_ADMIN") {
        throw new ForbiddenException("Siz bu do'kon egasi emassiz");
      }
    }

    const cacheKey = `store:crm:${storeId}`;
    return this.cache.remember(cacheKey, 600, async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // 2. Platform-driven customers
      const confirmedScans = await this.prisma.isbnScan.findMany({
        where: { storeId, confirmed: true },
        select: { userId: true },
      });
      const uniqueCustomerIds = new Set(confirmedScans.map((s) => s.userId));
      const totalCustomers = uniqueCustomerIds.size;

      const newThisMonthScans = await this.prisma.isbnScan.findMany({
        where: { storeId, confirmed: true, createdAt: { gte: monthStart } },
        select: { userId: true },
      });
      const newThisMonth = new Set(newThisMonthScans.map((s) => s.userId)).size;

      // Returning customers: users with 2+ confirmed purchases
      const userPurchaseCounts = new Map<string, number>();
      for (const scan of confirmedScans) {
        userPurchaseCounts.set(scan.userId, (userPurchaseCounts.get(scan.userId) ?? 0) + 1);
      }
      let returningCustomers = 0;
      for (const count of userPurchaseCounts.values()) {
        if (count > 1) returningCustomers++;
      }

      // 3. Monthly sales trends (last 12 months)
      const monthlyTrend = await this._crmMonthlyTrend(storeId, 12);

      // 4. Top-selling books (top 10)
      const topBooksRaw = await this.prisma.isbnScan.groupBy({
        by: ["isbn", "title", "author"],
        where: { storeId, confirmed: true },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      });

      // Batch price lookup to avoid N+1 queries
      const topIsbns = topBooksRaw.map((b) => b.isbn);
      const priceProducts = await this.prisma.storeProduct.findMany({
        where: { storeId, isbn: { in: topIsbns } },
        select: { isbn: true, price: true },
      });
      const isbnPriceMap = new Map(priceProducts.map((p) => [p.isbn, p.price]));

      const topBooks: CrmTopBook[] = topBooksRaw.map((b) => ({
        isbn: b.isbn,
        title: b.title,
        author: b.author,
        salesCount: b._count.id,
        price: isbnPriceMap.get(b.isbn) ?? null,
      }));

      // 5. Conversion metrics
      const totalScans = await this.prisma.isbnScan.count({ where: { storeId } });
      const confirmedScansCount = await this.prisma.isbnScan.count({
        where: { storeId, confirmed: true },
      });
      const conversionRate = totalScans > 0
        ? Math.round((confirmedScansCount / totalScans) * 100)
        : 0;

      // Average confirmation time (hours)
      const confirmedWithTimes = await this.prisma.isbnScan.findMany({
        where: { storeId, confirmed: true, confirmedAt: { not: null } },
        select: { createdAt: true, confirmedAt: true },
      });

      let avgConfirmationTimeHours = 0;
      if (confirmedWithTimes.length > 0) {
        let totalMs = 0;
        for (const scan of confirmedWithTimes) {
          if (scan.confirmedAt) {
            totalMs += scan.confirmedAt.getTime() - scan.createdAt.getTime();
          }
        }
        avgConfirmationTimeHours = Math.round(
          (totalMs / confirmedWithTimes.length / (1000 * 60 * 60)) * 100
        ) / 100;
      }

      // Expired scans (not confirmed within 24h)
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const expiredScans = await this.prisma.isbnScan.count({
        where: {
          storeId,
          confirmed: false,
          createdAt: { lt: twentyFourHoursAgo },
        },
      });

      // 6. Traffic source (V1 simplified)
      const directCount = await this.prisma.isbnScan.count({
        where: { storeId, source: "STORE_MANUAL" },
      });

      return {
        totalCustomers,
        newThisMonth,
        returningCustomers,
        conversionRate,
        avgConfirmationTimeHours,
        expiredScans,
        topBooks,
        monthlyTrend,
        trafficSource: {
          direct: directCount,
          platformSearch: 0, // V2: search impressions tracking
        },
      };
    });
  }

  private async _crmMonthlyTrend(storeId: string, months: number) {
    const result: CrmMonthlyTrendEntry[] = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const nextD = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

      const [total, confirmed] = await Promise.all([
        this.prisma.isbnScan.count({
          where: { storeId, createdAt: { gte: d, lt: nextD } },
        }),
        this.prisma.isbnScan.count({
          where: { storeId, confirmed: true, createdAt: { gte: d, lt: nextD } },
        }),
      ]);

      result.push({ month, total, confirmed });
    }
    return result;
  }

  // ── Imzo tekshiruvi ───────────────────────────────────────────────────────
  // Phase 8: reads hmacSecret from prisma.store (not config/cache fallback).

  private async _verifySignature(body: PurchasePayload, signature: string, storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { hmacSecret: true },
    });
    if (!store) {
      throw new UnauthorizedException("Do'kon topilmadi");
    }

    const payload = `${body.phone}${body.isbn}${body.order_id}${body.purchase_date}`;
    const expected = crypto.createHmac("sha256", store.hmacSecret).update(payload).digest("hex");

    if (signature !== expected) {
      throw new UnauthorizedException("Noto'g'ri HMAC imzo");
    }
  }

  // ── ISBN ma'lumotlarini Open Library dan olish ────────────────────────────

  private async _lookupIsbn(isbn: string): Promise<{ title?: string; author?: string }> {
    try {
      const cached = await this.cache.get<{ title: string; author: string }>(`isbn:${isbn}`);
      if (cached) return cached;

      const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
      if (!res.ok) return {};

      const data: any = await res.json();
      const book = data[`ISBN:${isbn}`];
      if (!book) return {};

      const result = {
        title: book.title,
        author: book.authors?.[0]?.name,
      };

      await this.cache.set(`isbn:${isbn}`, result, 86400); // 24 soat cache
      return result;
    } catch {
      return {};
    }
  }

  private async _monthlyTrend(storeId: string, months: number) {
    const result = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const nextD = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const count = await this.prisma.isbnScan.count({
        where: { storeId, createdAt: { gte: d, lt: nextD } },
      });
      result.push({ month, count });
    }
    return result;
  }

  // ── Elasticsearch store product indexing (SHOP-07) ───────────────────────

  private async _indexStoreProduct(
    product: { id: string; isbn: string; title: string; author: string; genre: string | null; price: number; stockCount: number; active: boolean; coverUrl?: string | null; createdAt: Date },
    store: { id: string; name: string; lat: number | null; lon: number | null; premiumBadge: boolean },
  ) {
    try {
      await this.search.indexStoreProduct({
        id: product.id,
        storeId: store.id,
        storeName: store.name,
        isbn: product.isbn,
        title: product.title,
        author: product.author,
        genre: product.genre ?? undefined,
        price: product.price,
        stockCount: product.stockCount,
        active: product.active,
        location: store.lat != null && store.lon != null ? { lat: store.lat, lon: store.lon } : undefined,
        premiumBadge: store.premiumBadge,
        coverUrl: product.coverUrl ?? undefined,
        createdAt: product.createdAt.toISOString(),
      });
    } catch (err) {
      this.logger.warn(`ES index failed for store product ${product.id}: ${(err as Error).message}`);
    }
  }

  private async _removeStoreProductFromIndex(productId: string) {
    try {
      await this.search.removeStoreProduct(productId);
    } catch {
      // No throw on missing — soft-delete may race with ES
    }
  }

  // ── Store product search (SHOP-04, SHOP-07) ──────────────────────────────

  async searchStoreProducts(dto: StoreProductSearchDto & { lat?: number; lon?: number }): Promise<StoreProductSearchResult> {
    const { q, storeId, genre, inStock, minPrice, maxPrice, lat, lon, page = 1, limit = 20 } = dto;
    const from = (page - 1) * limit;

    // ES o'chirilgan bo'lsa darhol Prisma fallback — o'lik ES portiga ~8s
    // osilishning oldini oladi (warning log spam'isiz, erta qaytamiz).
    if (!this.search.isEnabled) return this.searchStoreProductsFallback(dto);

    try {
      const must: object[] = [];
      const filter: object[] = [{ term: { active: true } }];

      if (q) {
        must.push({
          multi_match: {
            query: q,
            fields: ["title^3", "title.cyrillic^3", "author^2", "author.cyrillic^2", "isbn", "storeName"],
            fuzziness: "AUTO",
          },
        });
      }
      if (storeId) filter.push({ term: { storeId } });
      if (genre) filter.push({ term: { genre } });
      if (inStock) filter.push({ range: { stockCount: { gt: 0 } } });
      if (minPrice !== undefined) filter.push({ range: { price: { gte: minPrice } } });
      if (maxPrice !== undefined) filter.push({ range: { price: { lte: maxPrice } } });

      // Build sort: geo_distance first (if lat/lon), then _score, then premiumBadge
      const sort: object[] = [];
      const hasGeo = lat !== undefined && lon !== undefined;
      if (hasGeo) {
        sort.push({
          _geo_distance: { location: { lat, lon }, order: "asc", unit: "km" },
        });
      }
      sort.push({ _score: { order: "desc" } });
      sort.push({ premiumBadge: { order: "desc" } });

      const esResult = await this.search.searchStoreProducts({
        query: {
          bool: {
            must: must.length ? must : [{ match_all: {} }],
            filter,
          },
        },
        sort,
        from,
        size: limit,
      });

      const hits = esResult.hits.hits as Array<{
        _id: string;
        _source: Record<string, unknown>;
        _score: number | null;
        sort?: unknown[];
      }>;

      return {
        total: typeof esResult.hits.total === "object"
          ? (esResult.hits.total as { value: number }).value
          : esResult.hits.total,
        page,
        limit,
        data: hits.map((h) => ({
          id: h._id,
          ...h._source,
          distance: hasGeo && h.sort?.[0] !== undefined ? h.sort[0] : undefined,
        })),
      };
    } catch (err) {
      this.logger.warn(`ES store product search failed, using Prisma fallback: ${(err as Error).message}`);
      return this.searchStoreProductsFallback(dto);
    }
  }

  private async searchStoreProductsFallback(dto: StoreProductSearchDto & { lat?: number; lon?: number }): Promise<StoreProductSearchResult> {
    const { q, storeId, genre, inStock, minPrice, maxPrice, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { active: true };

    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { author: { contains: q, mode: "insensitive" } },
        { isbn: { contains: q } },
      ];
    }
    if (storeId) where.storeId = storeId;
    if (genre) where.genre = genre;
    if (inStock) where.stockCount = { gt: 0 };

    // Price range filter
    if (minPrice !== undefined || maxPrice !== undefined) {
      const priceFilter: Record<string, number> = {};
      if (minPrice !== undefined) priceFilter.gte = minPrice;
      if (maxPrice !== undefined) priceFilter.lte = maxPrice;
      where.price = priceFilter;
    }

    const [items, total] = await Promise.all([
      this.prisma.storeProduct.findMany({
        where,
        include: {
          store: {
            select: { name: true, slug: true, lat: true, lon: true, premiumBadge: true },
          },
        },
        skip,
        take: limit,
        orderBy: { title: "asc" },
      }),
      this.prisma.storeProduct.count({ where }),
    ]);

    return {
      total,
      page,
      limit,
      data: items.map((item) => ({
        id: item.id,
        storeId: item.storeId,
        storeName: (item as any).store?.name,
        isbn: item.isbn,
        title: item.title,
        author: item.author,
        genre: item.genre,
        price: item.price,
        stockCount: item.stockCount,
        premiumBadge: (item as any).store?.premiumBadge ?? false,
        slug: (item as any).store?.slug,
        // Muqova fallback javobida ham bo'lsin — ES bilan bir xil shakl.
        coverUrl: item.coverUrl ?? undefined,
      })),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async _verifyStoreOwnership(storeId: string, operatorId: string) {
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException("Do'kon topilmadi");
    if (store.operatorId !== operatorId) {
      // Allow SUPER_ADMIN to manage any store
      const user = await this.prisma.user.findUnique({
        where: { id: operatorId },
        select: { role: true },
      });
      if (!user || user.role !== "SUPER_ADMIN") {
        throw new ForbiddenException("Bu do'konga ruxsat yo'q");
      }
    }
    return store;
  }

  private async _generateSlug(name: string): Promise<string> {
    // Transliterate Cyrillic to Latin for meaningful slugs
    const cyrillicMap: Record<string, string> = {
      "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
      "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
      "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
      "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
      "ъ": "", "ы": "i", "ь": "", "э": "e", "ю": "yu", "я": "ya",
      "ў": "o", "қ": "q", "ғ": "g", "ҳ": "h",
      "ә": "a", "ө": "o", "ү": "u", "ң": "ng",
    };

    const transliterated = name
      .toLowerCase()
      .split("")
      .map((ch) => cyrillicMap[ch] ?? ch)
      .join("");

    const base = transliterated
      .replace(/[''`ʻ]/g, "") // Remove apostrophes (o'zbek -> ozbek)
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    const slug = base || "store";

    // Retry loop with unique constraint handling (TOCTOU-safe)
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? slug : `${slug}-${Date.now().toString(36).slice(-4)}`;
      const existing = await this.prisma.store.findUnique({ where: { slug: candidate } });
      if (!existing) return candidate;
    }

    // Final fallback with timestamp
    return `${slug}-${Date.now().toString(36)}`;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PurchasePayload {
  phone: string;
  isbn: string;
  order_id: string;
  purchase_date: string;
  store_id: string;
  signature?: string;
}

export interface PurchaseResult {
  status: "accepted" | "duplicate" | "user_not_found" | "error";
  message: string;
  scanId?: string;
}

export interface StoreProductSearchResult {
  total: number | unknown;
  page: number;
  limit: number;
  data: Record<string, unknown>[];
}

export interface CrmTopBook {
  isbn: string;
  title: string;
  author: string;
  salesCount: number;
  price: number | null;
}

export interface CrmMonthlyTrendEntry {
  month: string;
  total: number;
  confirmed: number;
}

export interface CrmDashboardResult {
  totalCustomers: number;
  newThisMonth: number;
  returningCustomers: number;
  conversionRate: number;
  avgConfirmationTimeHours: number;
  expiredScans: number;
  topBooks: CrmTopBook[];
  monthlyTrend: CrmMonthlyTrendEntry[];
  trafficSource: {
    direct: number;
    platformSearch: number;
  };
}
