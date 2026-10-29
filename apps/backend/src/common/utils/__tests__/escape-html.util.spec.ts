import { escapeHtml } from "../escape-html.util";

/**
 * Plan 05-04 Task 2 — single source of truth verification.
 *
 * Mirrors the 5 HTML-escape rules from RESEARCH §NOTIF-03 / T-05-07. The
 * regression coverage for PdfService.buildMonthlyReportHtml still lives in
 * pdf.service.spec; this spec pins the util in isolation.
 */
describe("escapeHtml util (Plan 05-04 single source of truth)", () => {
  it("escapes ampersand to &amp;", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than to &lt;", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes greater-than to &gt;", () => {
    expect(escapeHtml("x > 1")).toBe("x &gt; 1");
  });

  it("escapes double-quote to &quot;", () => {
    expect(escapeHtml('he said "hi"')).toBe("he said &quot;hi&quot;");
  });

  it("escapes single-quote to &#39;", () => {
    expect(escapeHtml("it's fine")).toBe("it&#39;s fine");
  });

  it("handles nullish input as empty string", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(escapeHtml(null as any)).toBe("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(escapeHtml(undefined as any)).toBe("");
  });

  it("neutralises a classic script-injection payload", () => {
    const payload = "<script>fetch('evil.io')</script>";
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&#39;evil.io&#39;");
  });

  // NOT idempotent on `&` — documented in the util's JSDoc.
  it("is NOT idempotent on ampersand (double-escape yields &amp;amp;)", () => {
    expect(escapeHtml(escapeHtml("&"))).toBe("&amp;amp;");
  });
});
