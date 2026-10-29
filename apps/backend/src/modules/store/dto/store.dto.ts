/**
 * Store + StoreProduct DTOs — Phase 8, Plan 08-01
 *
 * Interfaces mirror the Prisma model shapes but only expose the fields
 * that callers may write. Validation (positive price, non-negative stock)
 * is enforced at the service layer per T-08-02.
 */

// ── Store DTOs ──────────────────────────────────────────────────────────────

export interface CreateStoreDto {
  name: string;
  slug: string;
  description?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lon?: number;
  workingHours?: Record<string, string>;
  tumanId: string;
  viloyatId: string;
}

export interface UpdateStoreDto {
  name?: string;
  slug?: string;
  description?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lon?: number;
  workingHours?: Record<string, string>;
  logoUrl?: string;
  tumanId?: string;
  viloyatId?: string;
  premiumBadge?: boolean;
}

// ── StoreProduct DTOs ───────────────────────────────────────────────────────

export interface CreateStoreProductDto {
  isbn: string;
  title: string;
  author: string;
  genre?: string;
  price: number;
  stockCount: number;
  coverUrl?: string;
  description?: string;
  lang?: string;
  pages?: number;
  year?: number;
}

export interface UpdateStoreProductDto {
  isbn?: string;
  title?: string;
  author?: string;
  genre?: string;
  price?: number;
  stockCount?: number;
  coverUrl?: string;
  description?: string;
  lang?: string;
  pages?: number;
  year?: number;
}

export interface StoreProductSearchDto {
  q?: string;
  storeId?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  genre?: string;
  page?: number;
  limit?: number;
}

// ── Import job data ─────────────────────────────────────────────────────────

export interface StoreProductImportJobData {
  storeId: string;
  operatorId: string;
  fileBase64: string;
}
