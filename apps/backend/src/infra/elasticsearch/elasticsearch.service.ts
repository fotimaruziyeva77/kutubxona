import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ElasticsearchService } from "@nestjs/elasticsearch";
import {
  BOOKS_INDEX_NAME,
  BOOKS_INDEX_MAPPING,
  USERS_INDEX_NAME,
  USERS_INDEX_MAPPING,
  STORE_PRODUCTS_INDEX_NAME,
  STORE_PRODUCTS_INDEX_MAPPING,
} from "./indices";

@Injectable()
export class SearchService implements OnModuleInit {
  private readonly logger = new Logger(SearchService.name);

  // ES o'chirilgan bo'lsa (ELASTICSEARCH_ENABLED=false) barcha ES amallari
  // no-op/throw bo'ladi va chaqiruvchilar Prisma fallback'ga o'tadi. Default
  // yoqilgan — production'da ES ishlaydi, faqat aniq "false" o'chiradi.
  private readonly enabled = process.env.ELASTICSEARCH_ENABLED !== "false";

  constructor(private readonly es: ElasticsearchService) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn(
        "Elasticsearch o'chirilgan (ELASTICSEARCH_ENABLED=false) — Prisma qidiruv ishlatiladi"
      );
      return;
    }
    await this.ensureIndices();
  }

  // ── Index yaratish ─────────────────────────────────────────────
  private async ensureIndices() {
    await this.createIndexIfNotExists(BOOKS_INDEX_NAME, BOOKS_INDEX_MAPPING);
    await this.createIndexIfNotExists(USERS_INDEX_NAME, USERS_INDEX_MAPPING);
    await this.createIndexIfNotExists(STORE_PRODUCTS_INDEX_NAME, STORE_PRODUCTS_INDEX_MAPPING);
  }

  private async createIndexIfNotExists(name: string, config: object) {
    try {
      const exists = await this.es.indices.exists({ index: name });
      if (exists) {
        this.logger.log(`Index mavjud: ${name}`);
        return;
      }
      await this.es.indices.create({ index: name, ...config });
      this.logger.log(`Index yaratildi: ${name}`);
    } catch (err) {
      this.logger.error(`Index yaratishda xato (${name}):`, err);
    }
  }

  // ── Kitob indekslash ────────────────────────────────────────────
  async indexBook(book: {
    id: string;
    isbn: string;
    title: string;
    author: string;
    genre: string;
    lang: string;
    pages: number;
    year: number;
    availableCount: number;
    libraryId: string;
    libraryName?: string;
    libraryType?: string;
    regionId?: string;
  }) {
    if (!this.enabled) return;
    return this.es.index({
      index: BOOKS_INDEX_NAME,
      id: book.id,
      document: { ...book, createdAt: new Date().toISOString() }
    });
  }

  // ── Kitob qidiruv (joylashuvga asoslangan) ─────────────────────
  async searchBooks(query: string, filters?: {
    lang?: string;
    genre?: string;
    regionId?: string;
    onlyAvailable?: boolean;
  }) {
    if (!this.enabled) return [];
    const must: object[] = [
      {
        multi_match: {
          query,
          fields: ["title^3", "title.cyrillic^3", "author^2", "author.cyrillic^2", "genre"],
          fuzziness: "AUTO",
          operator: "or"
        }
      }
    ];

    const filter: object[] = [];

    if (filters?.lang) filter.push({ term: { lang: filters.lang } });
    if (filters?.genre) filter.push({ term: { genre: filters.genre } });
    if (filters?.regionId) filter.push({ term: { regionId: filters.regionId } });
    if (filters?.onlyAvailable) filter.push({ range: { availableCount: { gt: 0 } } });

    const result = await this.es.search({
      index: BOOKS_INDEX_NAME,
      query: { bool: { must, filter } },
      size: 20,
      sort: [{ _score: { order: "desc" } }, { availableCount: { order: "desc" } }]
    });

    return result.hits.hits.map((h) => ({
      ...(h._source as object),
      score: h._score
    }));
  }

  // ── Autocomplete (title suggest) ───────────────────────────────
  async suggestBooks(prefix: string) {
    if (!this.enabled) return [] as string[];
    const result = await this.es.search({
      index: BOOKS_INDEX_NAME,
      suggest: {
        title_suggest: {
          prefix,
          completion: {
            field: "title.suggest",
            size: 5,
            skip_duplicates: true
          }
        }
      }
    });

    const options = result.suggest?.["title_suggest"]?.[0]?.options;
    const suggestions = Array.isArray(options) ? options : [];
    return suggestions.map((s: { text?: string }) => s.text ?? "");
  }

  // ── Kitob indeksdan o'chirish ──────────────────────────────────
  async removeBook(bookId: string) {
    if (!this.enabled) return;
    return this.es.delete({ index: BOOKS_INDEX_NAME, id: bookId });
  }

  // ── Foydalanuvchi indekslash ───────────────────────────────────
  async indexUser(user: {
    id: string;
    type: string;
    status: string;
    viloyatId?: string;
    tumanId?: string;
    mahallaId?: string;
    trustScore: number;
    readingScore?: number;
  }) {
    if (!this.enabled) return;
    return this.es.index({
      index: USERS_INDEX_NAME,
      id: user.id,
      document: { ...user, createdAt: new Date().toISOString() }
    });
  }

  // ── Store product indekslash (Phase 8 Plan 08-01, SHOP-07) ──
  async indexStoreProduct(product: {
    id: string;
    storeId: string;
    storeName: string;
    isbn: string;
    title: string;
    author: string;
    genre?: string;
    price: number;
    stockCount: number;
    active: boolean;
    location?: { lat: number; lon: number };
    premiumBadge: boolean;
    // Qidiruv natijasida muqova ko'rsatish uchun (frontend BookCover
    // haqiqiy rasm bo'lsa o'shani, bo'lmasa generatsiyani chizadi).
    // Ilgari bu maydon hujjatga yozilmasdi va qidiruv natijalari
    // muqovasiz qaytardi.
    coverUrl?: string;
    createdAt: string;
  }) {
    if (!this.enabled) return;
    return this.es.index({
      index: STORE_PRODUCTS_INDEX_NAME,
      id: product.id,
      document: product
    });
  }

  // ── Store product search (SHOP-04, SHOP-07 — Plan 08-02) ──────
  async searchStoreProducts(params: {
    query: object;
    sort: object[];
    from: number;
    size: number;
  }) {
    return this.es.search({
      index: STORE_PRODUCTS_INDEX_NAME,
      query: params.query,
      sort: params.sort as any,
      from: params.from,
      size: params.size,
    });
  }

  // ── Store product indeksdan o'chirish ──────────────────────────
  async removeStoreProduct(productId: string) {
    if (!this.enabled) return;
    try {
      return await this.es.delete({ index: STORE_PRODUCTS_INDEX_NAME, id: productId });
    } catch {
      // Silently ignore — product may not exist in index
    }
  }

  // ── Statistika ────────────────────────────────────────────────
  async getTopGenres(regionId?: string) {
    if (!this.enabled) return [] as Array<{ genre: string; count: number }>;
    const filter: object[] = regionId ? [{ term: { regionId } }] : [];

    const result = await this.es.search({
      index: BOOKS_INDEX_NAME,
      size: 0,
      query: { bool: { filter } },
      aggs: {
        genres: {
          terms: { field: "genre", size: 10 }
        }
      }
    });

    const buckets = (result.aggregations?.["genres"] as { buckets?: { key: string; doc_count: number }[] })?.buckets ?? [];
    return buckets.map((b) => ({ genre: b.key, count: b.doc_count }));
  }
}
