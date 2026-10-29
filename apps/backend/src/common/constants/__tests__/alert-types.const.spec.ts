import {
  ALERT_TYPES,
  ALERT_SEVERITY,
  AlertType,
  AlertSeverity,
} from "../alert-types.const";

describe("ALERT_TYPES (Plan 05-01 Task 3; extended by Plans 06-05 + 07-04)", () => {
  // Plan 05-01 seeded the base 8; Plan 06-05 ORG-04 added BOOK_CORNER_REMINDER
  // (idora kitob burchagi 90-day reminder) and Plan 07-04 AI-03 added
  // ROOT_CAUSE_ANALYSIS (audit.service RCA trigger). Count = 10.
  it("exports exactly 10 issue types (8 base + ORG-04 + AI-03)", () => {
    expect(Object.keys(ALERT_TYPES)).toHaveLength(10);
  });

  it("contains every alert vocabulary entry (05-05/05-04 base + 06-05 + 07-04)", () => {
    expect(ALERT_TYPES).toEqual({
      LIBRARY_INACTIVE: "LIBRARY_INACTIVE",
      RI_DROPPED: "RI_DROPPED",
      FUND_SHORTAGE: "FUND_SHORTAGE",
      CLUB_INACTIVE: "CLUB_INACTIVE",
      RI_RISING: "RI_RISING",
      SYSTEM_DOWN: "SYSTEM_DOWN",
      INVENTORY_DISCREPANCY: "INVENTORY_DISCREPANCY",
      ORDER_REQUEST: "ORDER_REQUEST",
      BOOK_CORNER_REMINDER: "BOOK_CORNER_REMINDER",
      ROOT_CAUSE_ANALYSIS: "ROOT_CAUSE_ANALYSIS",
    });
  });

  it("each value is unique", () => {
    const values = Object.values(ALERT_TYPES);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("each value matches /^[A-Z_]+$/ (uppercase + underscores only)", () => {
    for (const v of Object.values(ALERT_TYPES)) {
      expect(v).toMatch(/^[A-Z_]+$/);
    }
  });

  // ── FRAUD-08 regression guard ──────────────────────────────────────────
  // Plan 03-01 FRAUD-08 emits the literal "INVENTORY_DISCREPANCY" from the
  // fraud engine. The Plan 05-05 alert consolidation must preserve that exact
  // string so existing rows + downstream queues don't break.
  it("INVENTORY_DISCREPANCY string is preserved verbatim (FRAUD-08 regression guard)", () => {
    expect(ALERT_TYPES.INVENTORY_DISCREPANCY).toBe("INVENTORY_DISCREPANCY");
  });

  it("AlertType union accepts every value (compile-time smoke)", () => {
    const a: AlertType = ALERT_TYPES.LIBRARY_INACTIVE;
    const b: AlertType = ALERT_TYPES.ORDER_REQUEST;
    const c: AlertType = ALERT_TYPES.BOOK_CORNER_REMINDER;
    const d: AlertType = ALERT_TYPES.ROOT_CAUSE_ANALYSIS;
    expect([a, b, c, d]).toEqual([
      "LIBRARY_INACTIVE",
      "ORDER_REQUEST",
      "BOOK_CORNER_REMINDER",
      "ROOT_CAUSE_ANALYSIS",
    ]);
  });
});

describe("ALERT_SEVERITY (Plan 05-01 Task 3)", () => {
  it("exports the three CLAUDE.md §VI.4 buckets", () => {
    expect(ALERT_SEVERITY).toEqual({
      KRITIK: "KRITIK",
      OGOHLANTIRISH: "OGOHLANTIRISH",
      AXBOROT: "AXBOROT",
    });
  });

  it("AlertSeverity union accepts each bucket", () => {
    const s: AlertSeverity = ALERT_SEVERITY.KRITIK;
    expect(s).toBe("KRITIK");
  });
});
