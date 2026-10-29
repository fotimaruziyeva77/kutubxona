import { apiClient } from "./client";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StoreProductItem {
  id: string;
  isbn: string;
  title: string;
  author: string;
  genre?: string;
  price: number;
  stockCount: number;
  coverUrl?: string;
  description?: string;
  createdAt: string;
}

export interface StoreProfile {
  id: string;
  name: string;
  slug: string;
  description?: string;
  phone?: string;
  address?: string;
  lat?: number | null;
  lon?: number | null;
  workingHours?: Record<string, string>;
  logoUrl?: string;
  premiumBadge: boolean;
  premiumSince?: string | null;
  productCount: number;
  products: StoreProductItem[];
}

export interface CrmDashboardData {
  totalCustomers: number;
  newThisMonth: number;
  returningCustomers: number;
  conversionRate: number;
  avgConfirmationTimeHours: number;
  expiredScans: number;
  topBooks: {
    isbn: string;
    title: string;
    author: string;
    salesCount: number;
    price: number | null;
  }[];
  monthlyTrend: {
    month: string;
    total: number;
    confirmed: number;
  }[];
  trafficSource: Record<string, number>;
}

export interface StoreProductSearchResult {
  id: string;
  isbn: string;
  title: string;
  author: string;
  genre?: string;
  price: number;
  stockCount: number;
  coverUrl?: string;
  storeName: string;
  slug: string;
  storeAddress?: string;
  distance?: number;
  premiumBadge?: boolean;
}

export interface StoreProductSearchParams {
  q?: string;
  lat?: number;
  lon?: number;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  genre?: string;
  page?: number;
  limit?: number;
}

// ── API Functions ────────────────────────────────────────────────────────────

// Barcha faol do'konlar ro'yxati (ommaviy katalog).
export interface StoreListItem {
  id: string;
  name: string;
  slug: string;
  address?: string | null;
  premiumBadge: boolean;
  logoUrl?: string | null;
  productCount: number;
}

export async function listStores(): Promise<StoreListItem[]> {
  const { data } = await apiClient.get<StoreListItem[]>("/store");
  return data;
}

export async function fetchStoreProfile(slug: string): Promise<StoreProfile> {
  const { data } = await apiClient.get<StoreProfile>(`/store/profile/${slug}`);
  return data;
}

// Joriy DOKON_OPERATOR'ning do'koni — login'dan keyin CRM'ga yo'naltirish uchun.
export interface MyStore {
  id: string;
  slug: string;
  name: string;
}
export async function fetchMyStore(): Promise<MyStore | null> {
  const { data } = await apiClient.get<MyStore | null>("/store/my");
  return data ?? null;
}

export async function fetchStoreProducts(
  storeId: string,
  page = 1,
  limit = 20
): Promise<{ items: StoreProductItem[]; total: number; page: number; limit: number }> {
  const { data } = await apiClient.get(`/store/${storeId}/products`, {
    params: { page, limit },
  });
  return data;
}

export async function fetchStoreCrm(storeId: string): Promise<CrmDashboardData> {
  const { data } = await apiClient.get<CrmDashboardData>(
    `/store/${storeId}/crm`
  );
  return data;
}

export async function searchStoreProducts(
  params: StoreProductSearchParams
): Promise<{ total: number; data: StoreProductSearchResult[] }> {
  const { data } = await apiClient.get(`/store/products/search`, { params });
  return data;
}

// ── Catalog management (DOKON_OPERATOR) ────────────────────────────────────────

export interface CreateStoreProductInput {
  isbn: string;
  title: string;
  author: string;
  genre?: string;
  price: number;
  stockCount: number;
  coverUrl?: string;
  description?: string;
}

export async function createStoreProduct(
  storeId: string,
  dto: CreateStoreProductInput
): Promise<StoreProductItem> {
  const { data } = await apiClient.post(`/store/${storeId}/products`, dto);
  return data;
}

export interface UpdateStoreProductInput {
  isbn?: string;
  title?: string;
  author?: string;
  genre?: string;
  price?: number;
  stockCount?: number;
  coverUrl?: string;
  description?: string;
}

export async function updateStoreProduct(
  productId: string,
  dto: UpdateStoreProductInput
): Promise<StoreProductItem> {
  const { data } = await apiClient.put(`/store/products/${productId}`, dto);
  return data;
}

export async function deleteStoreProduct(productId: string): Promise<void> {
  await apiClient.delete(`/store/products/${productId}`);
}

export async function importStoreProducts(
  storeId: string,
  fileBase64: string
): Promise<{ jobId: string; status: string }> {
  const { data } = await apiClient.post(`/store/${storeId}/products/import`, { fileBase64 });
  return data;
}

export interface StoreImportStatus {
  status: "queued" | "active" | "completed" | "failed" | "delayed" | "waiting" | "paused" | "unknown";
  processed: number;
  total: number;
  errors: { row: number; reason: string }[];
  progress: number;
}

export async function getStoreImportStatus(jobId: string): Promise<StoreImportStatus> {
  const { data } = await apiClient.get(`/store/products/import/${encodeURIComponent(jobId)}/status`);
  return data;
}

// Do'kon sozlamalari (operator o'zi tahrirlaydi) — PUT /store/:storeId.
export interface UpdateStoreInput {
  description?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lon?: number;
  workingHours?: Record<string, string>;
  logoUrl?: string;
}

export async function updateStore(
  storeId: string,
  dto: UpdateStoreInput,
): Promise<StoreProfile> {
  const { data } = await apiClient.put(`/store/${storeId}`, dto);
  return data;
}

// Import shablonini (.xlsx) yuklab olish — apiClient orqali (to'g'ri base + auth).
export async function downloadStoreTemplate(): Promise<void> {
  const res = await apiClient.get(`/store/products/template`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sifat-dokon-shablon.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
