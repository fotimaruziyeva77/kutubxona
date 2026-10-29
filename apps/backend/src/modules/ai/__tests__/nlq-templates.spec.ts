import { NLQ_TEMPLATES } from "../nlq-templates";

describe("NLQ Templates Registry", () => {
  it("should have at least 20 template entries", () => {
    expect(NLQ_TEMPLATES.length).toBeGreaterThanOrEqual(20);
  });

  it("each template should have non-empty intent, keywords (length >= 1), sqlTemplate, description, chartType", () => {
    for (const tpl of NLQ_TEMPLATES) {
      expect(tpl.intent).toBeTruthy();
      expect(tpl.intent.length).toBeGreaterThan(0);

      expect(Array.isArray(tpl.keywords)).toBe(true);
      expect(tpl.keywords.length).toBeGreaterThanOrEqual(1);
      for (const kw of tpl.keywords) {
        expect(typeof kw).toBe("string");
        expect(kw.length).toBeGreaterThan(0);
      }

      expect(tpl.sqlTemplate).toBeTruthy();
      expect(tpl.sqlTemplate.trim().length).toBeGreaterThan(0);

      expect(tpl.description).toBeTruthy();
      expect(tpl.description.length).toBeGreaterThan(0);

      expect(["line", "bar", "pie", "table", "number"]).toContain(tpl.chartType);
    }
  });

  it("should have no duplicate intent values", () => {
    const intents = NLQ_TEMPLATES.map((t) => t.intent);
    const uniqueIntents = new Set(intents);
    expect(uniqueIntents.size).toBe(intents.length);
  });

  it("should preserve all original 7 intents", () => {
    const intents = new Set(NLQ_TEMPLATES.map((t) => t.intent));
    const original7 = [
      "region_stats",
      "inactive_clubs",
      "missing_books",
      "trend_analysis",
      "top_readers",
      "library_stats",
      "goal_progress",
    ];
    for (const intent of original7) {
      expect(intents.has(intent)).toBe(true);
    }
  });

  it("should include new Phase 5-6 module intents", () => {
    const intents = new Set(NLQ_TEMPLATES.map((t) => t.intent));
    const phase56Intents = [
      "school_coverage",
      "family_rankings",
      "org_reading_hour",
      "university_faculty",
      "donation_stats",
      "fraud_overview",
      "alert_summary",
      "badge_stats",
      "overdue_books",
      "store_purchases",
      "org_book_corner",
      "org_employee_ranking",
      "payment_status",
      "map_ri_overview",
      "school_club_activity",
      "school_pq9_status",
    ];
    for (const intent of phase56Intents) {
      expect(intents.has(intent)).toBe(true);
    }
  });
});
