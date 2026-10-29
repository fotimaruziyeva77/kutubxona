import { apiClient } from "./client";

export interface Library {
  id: string;
  code: string;
  type: "GOV" | "SCH" | "UNI" | "ORG" | "MAH";
  name: string;
  regionId: string;
  tumanId?: string;
  viloyatId?: string;
  address?: string;
  phone?: string;
  workHours?: string;
  latitude?: number;
  longitude?: number;
  fundCount: number;
  status: "PENDING" | "ACTIVE" | "FROZEN" | "DELETED";
  frozenReason?: string;
  approvalLogs?: { action: string; note?: string; createdAt: string }[];
  books?: Book[];
  createdAt: string;
}

export interface Book {
  id: string;
  isbn: string;
  title: string;
  author: string;
  genre: string;
  lang: string;
  pages: number;
  year: number;
  coverUrl?: string;
  description?: string | null;
  totalCount: number;
  availableCount: number;
  libraryId: string;
  library?: { id: string; name: string };
  createdAt: string;
}

export interface CreateLibraryDto {
  type: Library["type"];
  name: string;
  regionId: string;
  tumanId?: string;
  viloyatId?: string;
  address?: string;
  phone?: string;
  workHours?: string;
  latitude?: number;
  longitude?: number;
}

export interface InventoryReport {
  libraryId: string;
  declaredFundCount: number;
  dbBookCount: number;
  availableCount: number;
  borrowedCount: number;
  discrepancy: number;
  discrepancyPct: number;
  alert: boolean;
}

export interface NearbyLibrary extends Library {
  distanceKm: number;
}

// ── Libraries API ─────────────────────────────────────────────────────────────

export const getLibraries = (params?: {
  status?: string;
  type?: string;
  tumanId?: string;
}) => apiClient.get<Library[]>("/libraries", { params }).then((r) => r.data);

// RBAC FIX: caller-scoped library list (auth required). Returns ONLY the
// libraries the current user may manage — a KUTUBXONACHI / MUASSASA_ADMIN
// gets just their own library, not every library in the system. Use this for
// management dropdowns (Muassasa paneli, Kitob fondi) instead of getLibraries.
export const getMyLibraries = () =>
  apiClient.get<Library[]>("/libraries/mine").then((r) => r.data);

// Kitobxonning (talaba/o'quvchi/xodim) muassasa kutubxonasi — navigatsiyadagi
// "Mening kutubxonam" havolasi uchun. Muassasasiz fuqaroda null qaytadi.
export interface MyInstitutionLibrary {
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;
}
export const getMyInstitutionLibrary = () =>
  apiClient
    .get<MyInstitutionLibrary | null>("/libraries/my-institution")
    .then((r) => r.data);

export const getLibrary = (id: string) =>
  apiClient.get<Library>(`/libraries/${id}`).then((r) => r.data);

export const getLibraryByCode = (code: string) =>
  apiClient.get<Library>(`/libraries/code/${code}`).then((r) => r.data);

// Kitobxon kitobni bron qiladi — backend bron qiluvchini JWT'dan oladi
// (IDOR-C3), shuning uchun faqat bookId yuboriladi. Status: PENDING →
// kutubxonachi tasdiqlaydi (RESERVED).
export const reserveBook = (bookId: string) =>
  apiClient
    .post<{ id: string; status: string }>("/transactions/reserve", { bookId })
    .then((r) => r.data);

export const createLibrary = (dto: CreateLibraryDto) =>
  apiClient.post<Library>("/libraries", dto).then((r) => r.data);

export const updateLibrary = (id: string, dto: Partial<CreateLibraryDto>) =>
  apiClient.put<Library>(`/libraries/${id}`, dto).then((r) => r.data);

export const approveByTuman = (id: string) =>
  apiClient.patch(`/libraries/${id}/approve/tuman`).then((r) => r.data);

export const approveBySuperAdmin = (id: string) =>
  apiClient.patch(`/libraries/${id}/approve/super`).then((r) => r.data);

export const rejectLibrary = (id: string, reason: string) =>
  apiClient.patch(`/libraries/${id}/reject`, { reason }).then((r) => r.data);

export const freezeLibrary = (id: string, reason: string) =>
  apiClient.patch(`/libraries/${id}/freeze`, { reason }).then((r) => r.data);

export const unfreezeLibrary = (id: string) =>
  apiClient.patch(`/libraries/${id}/unfreeze`).then((r) => r.data);

export const deleteLibrary = (id: string) =>
  apiClient.delete(`/libraries/${id}`, { data: { confirmation: "ROZIMAN" } }).then((r) => r.data);

export const getInventoryReport = (id: string) =>
  apiClient.get<InventoryReport>(`/libraries/${id}/inventory`).then((r) => r.data);

export const getNearbyLibraries = (lat: number, lon: number, radius = 10, book?: string) =>
  apiClient
    .get<NearbyLibrary[]>("/libraries/nearby", { params: { lat, lon, radius, book } })
    .then((r) => r.data);

// ── Books API ─────────────────────────────────────────────────────────────────

export const getBooks = (libraryId?: string, page?: number, limit?: number) =>
  apiClient
    .get<Book[]>("/books", { params: { libraryId, page, limit } })
    .then((r) => r.data);

// Kitob import shabloni (.xlsx) yuklab olish — kutubxonachi/muassasa admini.
export async function downloadBookTemplate(): Promise<void> {
  const res = await apiClient.get(`/books/template`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sifat-kitob-shablon.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const searchBooks = (params: {
  q?: string;
  genre?: string;
  lang?: string;
  libraryId?: string;
  available?: boolean;
  page?: number;
  limit?: number;
}) =>
  apiClient
    .get<{ total: number; page: number; limit: number; data: Book[] }>("/books/search", { params })
    .then((r) => r.data);

export const lookupIsbn = (isbn: string) =>
  apiClient
    .get<
      | (Partial<{
          isbn: string;
          title: string;
          author: string;
          pages: number;
          year: number;
          genre: string;
          lang: string;
          coverUrl: string;
          description: string;
        }> & { source?: "local" | "external" })
      | null
    >(`/books/isbn/${isbn}`)
    .then((r) => r.data);

export const createBook = (dto: Omit<Book, "id" | "createdAt" | "library">) =>
  apiClient.post<Book>("/books", dto).then((r) => r.data);

export const updateBook = (id: string, dto: Partial<Book>) =>
  apiClient.put<Book>(`/books/${id}`, dto).then((r) => r.data);

export const deleteBook = (id: string) =>
  apiClient.delete(`/books/${id}`).then((r) => r.data);

// BOOK-01 (Plan 02-04): import is async — POST returns 202 + { jobId },
// then the UI polls getImportStatus until status === 'completed' | 'failed'.
export interface BookImportEnqueueResult {
  jobId: string;
  status: "queued";
}

export interface BookImportStatusResult {
  status: "queued" | "active" | "completed" | "failed" | "delayed" | "waiting" | "paused" | "unknown";
  processed: number;
  total: number;
  errors: { row: number; reason: string }[];
  progress: number;
}

export const importBooksExcel = (file: File, libraryId: string): Promise<BookImportEnqueueResult> => {
  const form = new FormData();
  form.append("file", file);
  return apiClient
    .post<BookImportEnqueueResult>(
      `/books/import?libraryId=${libraryId}`,
      form,
      { headers: { "Content-Type": "multipart/form-data" } }
    )
    .then((r) => r.data);
};

export const getBookImportStatus = (jobId: string): Promise<BookImportStatusResult> =>
  apiClient
    .get<BookImportStatusResult>(`/books/import/${encodeURIComponent(jobId)}/status`)
    .then((r) => r.data);

export const scanUserQr = (sifatId: string) =>
  apiClient
    .get<{
      id: string;
      name: string;
      sifatId: string;
      type: string;
      status: string;
      trustScore: number;
      transactions: { status: string; book: { title: string; author: string } }[];
    }>(`/books/scan/${sifatId}`)
    .then((r) => r.data);
