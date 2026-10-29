import {
  MULTI_SCRIPT_SETTINGS,
  BOOKS_INDEX_MAPPING,
  MERGED_ANALYSIS_SETTINGS,
} from "../indices";

describe("Multi-script ICU analyzer configuration (I18N-03)", () => {
  it("MULTI_SCRIPT_SETTINGS has analyzer.multi_script with icu_tokenizer", () => {
    const analyzer = MULTI_SCRIPT_SETTINGS.analysis.analyzer.multi_script;
    expect(analyzer).toBeDefined();
    expect(analyzer.type).toBe("custom");
    expect(analyzer.tokenizer).toBe("icu_tokenizer");
    expect(analyzer.filter).toEqual(
      expect.arrayContaining(["lowercase", "icu_folding", "cyrillic_to_latin"]),
    );
  });

  it("MULTI_SCRIPT_SETTINGS has filter.cyrillic_to_latin with icu_transform Cyrillic-Latin", () => {
    const filter = MULTI_SCRIPT_SETTINGS.analysis.filter.cyrillic_to_latin;
    expect(filter).toBeDefined();
    expect(filter.type).toBe("icu_transform");
    expect(filter.id).toBe("Cyrillic-Latin");
  });

  it("BOOKS_INDEX_MAPPING title field has .cyrillic sub-field with multi_script analyzer", () => {
    const titleFields = BOOKS_INDEX_MAPPING.mappings.properties.title.fields;
    expect(titleFields.cyrillic).toBeDefined();
    expect(titleFields.cyrillic.type).toBe("text");
    expect(titleFields.cyrillic.analyzer).toBe("multi_script");
  });

  it("BOOKS_INDEX_MAPPING author field has .cyrillic sub-field with multi_script analyzer", () => {
    const authorFields = BOOKS_INDEX_MAPPING.mappings.properties.author.fields;
    expect(authorFields.cyrillic).toBeDefined();
    expect(authorFields.cyrillic.type).toBe("text");
    expect(authorFields.cyrillic.analyzer).toBe("multi_script");
  });

  it("MERGED_ANALYSIS_SETTINGS contains both uzbek and multi_script analyzers", () => {
    const analyzers = MERGED_ANALYSIS_SETTINGS.analysis.analyzer;
    expect(analyzers).toHaveProperty("uzbek_standard");
    expect(analyzers).toHaveProperty("uzbek_search");
    expect(analyzers).toHaveProperty("multi_script");

    const filters = MERGED_ANALYSIS_SETTINGS.analysis.filter;
    expect(filters).toHaveProperty("uzbek_stop");
    expect(filters).toHaveProperty("uzbek_stemmer");
    expect(filters).toHaveProperty("cyrillic_to_latin");
  });
});
