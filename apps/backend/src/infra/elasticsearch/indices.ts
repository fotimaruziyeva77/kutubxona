// O'zbek tilini qo'llab-quvvatlovchi Elasticsearch index settings
export const UZBEK_ANALYZER_SETTINGS = {
  analysis: {
    analyzer: {
      uzbek_standard: {
        type: "custom",
        tokenizer: "standard",
        filter: ["lowercase", "uzbek_stop", "uzbek_stemmer", "asciifolding"]
      },
      uzbek_search: {
        type: "custom",
        tokenizer: "standard",
        filter: ["lowercase", "uzbek_stop", "asciifolding"]
      }
    },
    filter: {
      uzbek_stop: {
        type: "stop",
        stopwords: [
          "va", "yoki", "lekin", "ammo", "esa", "ham", "bu", "shu",
          "u", "biz", "siz", "ular", "men", "sen", "bir", "bo'ldi",
          "bor", "yo'q", "uchun", "bilan", "dan", "da", "ga", "ni"
        ]
      },
      uzbek_stemmer: {
        type: "stemmer",
        language: "english" // O'zbek stemmer mavjud emas, minimal fallback
      }
    }
  }
};

// ICU-based multi-script analyzer for Cyrillic-Latin cross-script search (I18N-03)
// Requires the analysis-icu plugin installed in Elasticsearch
export const MULTI_SCRIPT_SETTINGS = {
  analysis: {
    analyzer: {
      multi_script: {
        type: "custom",
        tokenizer: "icu_tokenizer",
        filter: ["lowercase", "icu_folding", "cyrillic_to_latin"]
      }
    },
    filter: {
      cyrillic_to_latin: {
        type: "icu_transform",
        id: "Cyrillic-Latin"
      }
    }
  }
};

// Deep-merge UZBEK_ANALYZER_SETTINGS and MULTI_SCRIPT_SETTINGS into a single analysis block
function mergeAnalysisSettings(
  ...configs: Array<{ analysis: { analyzer?: Record<string, unknown>; filter?: Record<string, unknown> } }>
): { analysis: { analyzer: Record<string, unknown>; filter: Record<string, unknown> } } {
  const merged = { analysis: { analyzer: {} as Record<string, unknown>, filter: {} as Record<string, unknown> } };
  for (const cfg of configs) {
    Object.assign(merged.analysis.analyzer, cfg.analysis.analyzer ?? {});
    Object.assign(merged.analysis.filter, cfg.analysis.filter ?? {});
  }
  return merged;
}

export const MERGED_ANALYSIS_SETTINGS = mergeAnalysisSettings(UZBEK_ANALYZER_SETTINGS, MULTI_SCRIPT_SETTINGS);

export const BOOKS_INDEX_NAME = "sifat_books";
export const USERS_INDEX_NAME = "sifat_users";

export const BOOKS_INDEX_MAPPING = {
  settings: {
    ...MERGED_ANALYSIS_SETTINGS,
    number_of_shards: 1,
    number_of_replicas: 0
  },
  mappings: {
    properties: {
      id: { type: "keyword" as const },
      isbn: { type: "keyword" as const },
      title: {
        type: "text" as const,
        analyzer: "uzbek_standard",
        search_analyzer: "uzbek_search",
        fields: {
          keyword: { type: "keyword" as const, ignore_above: 256 },
          suggest: { type: "completion" as const },
          cyrillic: { type: "text" as const, analyzer: "multi_script" }
        }
      },
      author: {
        type: "text" as const,
        analyzer: "uzbek_standard",
        fields: {
          keyword: { type: "keyword" as const, ignore_above: 256 },
          cyrillic: { type: "text" as const, analyzer: "multi_script" }
        }
      },
      genre: { type: "keyword" as const },
      lang: { type: "keyword" as const },
      pages: { type: "integer" as const },
      year: { type: "integer" as const },
      availableCount: { type: "integer" as const },
      libraryId: { type: "keyword" as const },
      libraryName: { type: "text" as const },
      libraryType: { type: "keyword" as const },
      regionId: { type: "keyword" as const },
      location: { type: "geo_point" as const },
      createdAt: { type: "date" as const }
    }
  }
};

// ── Phase 8 Plan 08-01: Store Products index (SHOP-07) ─────────────────────

export const STORE_PRODUCTS_INDEX_NAME = "sifat_store_products";

export const STORE_PRODUCTS_INDEX_MAPPING = {
  settings: {
    ...MERGED_ANALYSIS_SETTINGS,
    number_of_shards: 1,
    number_of_replicas: 0
  },
  mappings: {
    properties: {
      id: { type: "keyword" as const },
      storeId: { type: "keyword" as const },
      storeName: {
        type: "text" as const,
        analyzer: "uzbek_standard",
        fields: {
          keyword: { type: "keyword" as const, ignore_above: 256 },
          cyrillic: { type: "text" as const, analyzer: "multi_script" }
        }
      },
      isbn: { type: "keyword" as const },
      title: {
        type: "text" as const,
        analyzer: "uzbek_standard",
        search_analyzer: "uzbek_search",
        fields: {
          keyword: { type: "keyword" as const, ignore_above: 256 },
          suggest: { type: "completion" as const },
          cyrillic: { type: "text" as const, analyzer: "multi_script" }
        }
      },
      author: {
        type: "text" as const,
        analyzer: "uzbek_standard",
        fields: {
          keyword: { type: "keyword" as const, ignore_above: 256 },
          cyrillic: { type: "text" as const, analyzer: "multi_script" }
        }
      },
      genre: { type: "keyword" as const },
      price: { type: "integer" as const },
      stockCount: { type: "integer" as const },
      active: { type: "boolean" as const },
      location: { type: "geo_point" as const },
      premiumBadge: { type: "boolean" as const },
      createdAt: { type: "date" as const }
    }
  }
};

export const USERS_INDEX_MAPPING = {
  settings: {
    ...UZBEK_ANALYZER_SETTINGS,
    number_of_shards: 1,
    number_of_replicas: 0
  },
  mappings: {
    properties: {
      id: { type: "keyword" as const },
      // Shaxsiy ma'lumotlar indekslanmaydi — faqat qidiruv uchun kerakli fieldlar
      type: { type: "keyword" as const },
      status: { type: "keyword" as const },
      viloyatId: { type: "keyword" as const },
      tumanId: { type: "keyword" as const },
      mahallaId: { type: "keyword" as const },
      trustScore: { type: "integer" as const },
      readingScore: { type: "float" as const },
      createdAt: { type: "date" as const }
    }
  }
};
