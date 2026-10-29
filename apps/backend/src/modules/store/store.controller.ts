import {
  Controller, Post, Get, Put, Delete, Body, Param, Query,
  Headers, UseGuards, HttpCode, HttpStatus, Res
} from "@nestjs/common";
import type { Response } from "express";
import {
  ApiTags, ApiOperation, ApiBearerAuth, ApiHeader, ApiQuery
} from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { StoreService, PurchasePayload } from "./store.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type {
  CreateStoreProductDto,
  UpdateStoreProductDto,
  UpdateStoreDto,
} from "./dto/store.dto";

@ApiTags("store")
@Controller("store")
export class StoreController {
  constructor(private readonly store: StoreService) {}

  // ── Do'kon API (webhook, ochiq + HMAC himoyalangan) ───────────────────────

  /**
   * Do'kon kassasi xarid webhookini yuboradi.
   * Autentifikatsiya: X-Store-Signature (HMAC-SHA256).
   */
  @Public()
  @Post("purchases")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Do'kon xaridi webhook — HMAC imzo bilan" })
  @ApiHeader({ name: "X-Store-Signature", required: true, description: "HMAC-SHA256 imzo" })
  @ApiHeader({ name: "X-Store-Id", required: true, description: "Do'kon ID" })
  receivePurchase(
    @Headers("x-store-id") storeId: string,
    @Headers("x-store-signature") signature: string,
    @Body() body: PurchasePayload
  ) {
    return this.store.receivePurchase(storeId, body, signature);
  }

  // ── Kitobxon tasdiqlashi ──────────────────────────────────────────────────

  @Post("confirm/:scanId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Kitobxon do'kon xaridini tasdiqlaydi" })
  confirmPurchase(
    @Param("scanId") scanId: string,
    @CurrentUser("id") userId: string
  ) {
    return this.store.confirmPurchase(scanId, userId);
  }

  // ── Admin: Do'kon ro'yxatdan o'tkazish ───────────────────────────────────

  @Post("register")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Yangi do'kon ro'yxatdan o'tkazish (Super Admin)" })
  registerStore(
    @Body() body: { name: string; phone?: string; address?: string },
    @CurrentUser("id") adminId: string
  ) {
    return this.store.registerStore({ ...body, adminId });
  }

  // ── Do'kon statistikasi ───────────────────────────────────────────────────

  @Get("stats/:storeId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Do'kon statistikasi" })
  getStoreStats(@Param("storeId") storeId: string) {
    return this.store.getStoreStats(storeId);
  }

  @Get("admin/stats")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Barcha do'konlar statistikasi (Super Admin)" })
  getAdminStoreStats() {
    return this.store.getAdminStoreStats();
  }

  @Get("purchases/:storeId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Do'kon xaridlari ro'yhati" })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  getStorePurchases(
    @Param("storeId") storeId: string,
    @Query("page") page = "1",
    @Query("limit") limit = "50"
  ) {
    return this.store.getStorePurchases(storeId, Number(page), Number(limit));
  }

  // Joriy operatorning do'koni — login'dan keyin CRM'ga yo'naltirish uchun.
  // "my" statik segment; ":storeId/crm"/"profile/:slug" ikki segmentli, to'qnashmaydi.
  @Get("my")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DOKON_OPERATOR, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Joriy operatorga biriktirilgan do'kon (slug + id)" })
  getMyStore(@CurrentUser("id") operatorId: string) {
    return this.store.getMyStore(operatorId);
  }

  // ── Phase 8 Plan 08-03: CRM Dashboard (SHOP-05) ──────────────────────────

  @Get(":storeId/crm")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DOKON_OPERATOR, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Do'kon CRM dashboard — sotuvlar, mijozlar, trendlar" })
  getCrmDashboard(
    @Param("storeId") storeId: string,
    @CurrentUser("id") userId: string
  ) {
    return this.store.getCrmDashboard(storeId, userId);
  }

  // ── Phase 8 Plan 08-01: Store CRUD endpoints ────────────────────────────

  // Barcha faol do'konlar ro'yxati (ommaviy "Barcha do'konlar" katalogi).
  // `@Get()` faqat `/store` ga aniq mos keladi — boshqa segmentli yo'llarga
  // to'qnashmaydi.
  @Public()
  @Get()
  @ApiOperation({ summary: "Barcha faol do'konlar ro'yxati (ommaviy)" })
  listStores() {
    return this.store.listStores();
  }

  @Public()
  @Get("profile/:slug")
  @ApiOperation({ summary: "Do'kon profili (ommaviy)" })
  getStoreBySlug(@Param("slug") slug: string) {
    return this.store.getStoreBySlug(slug);
  }

  @Put(":storeId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DOKON_OPERATOR, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Do'kon ma'lumotlarini tahrirlash" })
  updateStore(
    @Param("storeId") storeId: string,
    @Body() body: UpdateStoreDto,
    @CurrentUser("id") operatorId: string
  ) {
    return this.store.updateStore(storeId, operatorId, body);
  }

  @Put(":storeId/premium")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Premium badge berish/olish (Super Admin)" })
  setPremiumBadge(
    @Param("storeId") storeId: string,
    @Body() body: { isPremium: boolean }
  ) {
    return this.store.setPremiumBadge(storeId, body.isPremium);
  }

  // ── Phase 8 Plan 08-02: Store product search (SHOP-04, SHOP-07) ─────────

  @Public()
  @Get("products/search")
  @ApiOperation({ summary: "Do'kon mahsulotlarini qidirish (ommaviy, joylashuvga asoslangan)" })
  @ApiQuery({ name: "q", required: false, description: "Qidiruv so'rovi" })
  @ApiQuery({ name: "storeId", required: false, description: "Do'kon ID filtri" })
  @ApiQuery({ name: "genre", required: false, description: "Janr filtri" })
  @ApiQuery({ name: "minPrice", required: false, description: "Minimal narx (so'm)" })
  @ApiQuery({ name: "maxPrice", required: false, description: "Maksimal narx (so'm)" })
  @ApiQuery({ name: "inStock", required: false, description: "Faqat mavjud mahsulotlar" })
  @ApiQuery({ name: "lat", required: false, description: "Foydalanuvchi joylashuvi (latitude)" })
  @ApiQuery({ name: "lon", required: false, description: "Foydalanuvchi joylashuvi (longitude)" })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  searchProducts(
    @Query("q") q?: string,
    @Query("storeId") storeId?: string,
    @Query("genre") genre?: string,
    @Query("minPrice") minPrice?: string,
    @Query("maxPrice") maxPrice?: string,
    @Query("inStock") inStock?: string,
    @Query("lat") lat?: string,
    @Query("lon") lon?: string,
    @Query("page") page = "1",
    @Query("limit") limit = "20",
  ) {
    return this.store.searchStoreProducts({
      q,
      storeId,
      genre,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      inStock: inStock === "true",
      lat: lat ? Number(lat) : undefined,
      lon: lon ? Number(lon) : undefined,
      page: Number(page),
      limit: Number(limit),
    });
  }

  // ── Phase 8 Plan 08-01: Product catalog endpoints ───────────────────────

  @Post(":storeId/products")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DOKON_OPERATOR, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Do'konga mahsulot qo'shish" })
  createProduct(
    @Param("storeId") storeId: string,
    @Body() body: CreateStoreProductDto,
    @CurrentUser("id") operatorId: string
  ) {
    return this.store.createProduct(storeId, operatorId, body);
  }

  @Put("products/:productId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DOKON_OPERATOR, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mahsulot tahrirlash" })
  updateProduct(
    @Param("productId") productId: string,
    @Body() body: UpdateStoreProductDto,
    @CurrentUser("id") operatorId: string
  ) {
    return this.store.updateProduct(productId, operatorId, body);
  }

  @Delete("products/:productId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DOKON_OPERATOR, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mahsulot o'chirish (soft delete)" })
  deleteProduct(
    @Param("productId") productId: string,
    @CurrentUser("id") operatorId: string
  ) {
    return this.store.deleteProduct(productId, operatorId);
  }

  @Public()
  @Get(":storeId/products")
  @ApiOperation({ summary: "Do'kon mahsulotlari ro'yhati (ommaviy)" })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  listProducts(
    @Param("storeId") storeId: string,
    @Query("page") page = "1",
    @Query("limit") limit = "20"
  ) {
    return this.store.listProducts(storeId, Number(page), Number(limit));
  }

  @Post(":storeId/products/import")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DOKON_OPERATOR, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Excel dan mahsulotlar import qilish" })
  importProducts(
    @Param("storeId") storeId: string,
    @Body() body: { fileBase64: string },
    @CurrentUser("id") operatorId: string
  ) {
    return this.store.importProductsFromExcel(storeId, operatorId, body.fileBase64);
  }

  @Get("products/import/:jobId/status")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DOKON_OPERATOR, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Import jarayoni holati" })
  getImportStatus(@Param("jobId") jobId: string) {
    return this.store.getImportStatus(jobId);
  }

  // Import shabloni — ochiq (maxfiy ma'lumot yo'q), oddiy <a download> bilan
  // yuklab olinadi. Ustun nomlari import kutadigan sarlavhalarga aynan mos.
  @Public()
  @Get("products/template")
  @ApiOperation({ summary: "Mahsulot import shabloni (.xlsx) yuklab olish" })
  async downloadTemplate(@Res() res: Response) {
    const buf = await this.store.buildProductTemplate();
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="sifat-dokon-shablon.xlsx"',
      "Content-Length": String(buf.length),
    });
    res.end(buf);
  }
}
