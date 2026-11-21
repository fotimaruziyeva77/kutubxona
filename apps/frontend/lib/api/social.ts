import { apiClient } from "./client";

export interface BookReview {
  id: string;
  rating: number;
  text: string | null;
  createdAt: string;
  edited?: boolean;
  author: string;
}

export interface ReviewsPage {
  total: number;
  average: number | null;
  /** [1★, 2★, 3★, 4★, 5★] soni */
  distribution: number[];
  page: number;
  limit: number;
  data: BookReview[];
}

export interface MyReview {
  id: string;
  rating: number;
  text: string | null;
  createdAt: string;
}

export interface FavoriteBookItem {
  id: string;
  title: string;
  author: string;
  genre: string;
  hasCover: boolean;
  availableCount: number;
  totalCount: number;
  library?: { name: string; code?: string | null } | null;
  savedAt: string;
}

export const getBookReviews = (bookId: string, page = 1) =>
  apiClient
    .get<ReviewsPage>(`/books/${encodeURIComponent(bookId)}/reviews`, { params: { page, limit: 10 } })
    .then((r) => r.data);

export const getMyReview = (bookId: string) =>
  apiClient.get<MyReview | null>(`/books/${encodeURIComponent(bookId)}/reviews/mine`).then((r) => r.data || null);

export const saveReview = (bookId: string, body: { rating: number; text?: string }) =>
  apiClient.post<MyReview>(`/books/${encodeURIComponent(bookId)}/reviews`, body).then((r) => r.data);

export const deleteReview = (reviewId: string) =>
  apiClient.delete(`/reviews/${encodeURIComponent(reviewId)}`).then(() => undefined);

export const getFavoriteStatus = (bookId: string) =>
  apiClient.get<{ favorite: boolean }>(`/books/${encodeURIComponent(bookId)}/favorite`).then((r) => r.data);

export const setFavorite = (bookId: string, on: boolean) =>
  (on
    ? apiClient.put<{ favorite: boolean }>(`/books/${encodeURIComponent(bookId)}/favorite`)
    : apiClient.delete<{ favorite: boolean }>(`/books/${encodeURIComponent(bookId)}/favorite`)
  ).then((r) => r.data);

export const getFavorites = () => apiClient.get<FavoriteBookItem[]>(`/favorites`).then((r) => r.data);
