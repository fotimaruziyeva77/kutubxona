/**
 * NLQ Template Registry (AI-01)
 *
 * Centralized SQL query templates for the Natural Language Query interface.
 * Each template maps user intent keywords (Uzbek language) to a parameterized
 * SQL template and a recommended chart type for the admin dashboard.
 *
 * Templates use Prisma-compatible $params placeholders that the NlqService
 * substitutes before execution via Prisma.$queryRawUnsafe or typed helpers.
 *
 * Security: All SQL templates use parameterized queries via Prisma tagged
 * template literals -- no string interpolation (T-07-09).
 */

export interface NlqTemplate {
  /** Unique intent identifier */
  intent: string;
  /** Uzbek keywords that trigger this template */
  keywords: string[];
  /** SQL template with $param placeholders */
  sqlTemplate: string;
  /** Human-readable description (Uzbek) */
  description: string;
  /** Recommended visualization type for admin dashboard */
  chartType: "line" | "bar" | "pie" | "table" | "number";
}

// ── Original 7 templates (migrated from inline nlq.service.ts) ──────────────

const ORIGINAL_TEMPLATES: NlqTemplate[] = [
  {
    intent: "region_stats",
    keywords: ["statistika", "qanday", "holat", "viloyat"],
    sqlTemplate: `
      SELECT
        COUNT(DISTINCT u.id) FILTER (WHERE u.status = 'ACTIVE') AS active_users,
        COUNT(DISTINCT bt.id) FILTER (WHERE bt.type = 'BORROW' AND bt."borrowedAt" >= $sinceDate) AS total_borrows,
        COALESCE(AVG(ri.score), 0) AS avg_ri
      FROM "User" u
      LEFT JOIN "Address" a ON a.id = u."addressId"
      LEFT JOIN "BookTransaction" bt ON bt."userId" = u.id
      LEFT JOIN "ReadingIndex" ri ON ri."userId" = u.id AND ri."calculatedAt" >= $sinceDate
      WHERE ($regionId IS NULL OR a."viloyatId" = $regionId)
    `,
    description: "Viloyat/hudud bo'yicha kitobxonlik statistikasi",
    chartType: "number",
  },
  {
    intent: "inactive_clubs",
    keywords: ["klub", "faolsiz", "debat", "jadidlar"],
    sqlTemplate: `
      SELECT c.id, c.name AS klub, i.name AS muassasa, COUNT(cm.id) AS azo,
        MAX(d."heldAt") AS oxirgi_debat
      FROM "Club" c
      LEFT JOIN "Institution" i ON i.id = c."institutionId"
      LEFT JOIN "ClubMember" cm ON cm."clubId" = c.id
      LEFT JOIN "Debate" d ON d."clubId" = c.id
      WHERE c.status = 'ACTIVE'
      GROUP BY c.id, c.name, i.name
      HAVING MAX(d."heldAt") IS NULL OR MAX(d."heldAt") < $cutoffDate
      ORDER BY MAX(d."heldAt") ASC NULLS FIRST
      LIMIT 20
    `,
    description: "45+ kun debat o'tkazmagan Jadidlar izidan klublari",
    chartType: "table",
  },
  {
    intent: "missing_books",
    keywords: ["kitob yo'q", "yetishmay", "topilmay", "fond yetishmovchiligi"],
    sqlTemplate: `
      SELECT b.title AS kitob, b.author AS muallif,
        COUNT(bt.id) AS sorovlar, b."availableCount" AS mavjud
      FROM "BookTransaction" bt
      JOIN "Book" b ON b.id = bt."bookId"
      WHERE bt.type = 'RESERVE' AND bt."borrowedAt" >= $sinceDate
      GROUP BY b.id, b.title, b.author, b."availableCount"
      ORDER BY COUNT(bt.id) DESC
      LIMIT 10
    `,
    description: "Eng ko'p so'ralgan lekin mavjud bo'lmagan kitoblar",
    chartType: "table",
  },
  {
    intent: "trend_analysis",
    keywords: ["trend", "pasay", "osh", "dinamika"],
    sqlTemplate: `
      SELECT
        TO_CHAR(bt."borrowedAt", 'YYYY-MM') AS oy,
        COUNT(*) AS kitoblar
      FROM "BookTransaction" bt
      JOIN "User" u ON u.id = bt."userId"
      LEFT JOIN "Address" a ON a.id = u."addressId"
      WHERE bt.type = 'BORROW' AND bt."borrowedAt" >= $sinceDate
        AND ($regionId IS NULL OR a."viloyatId" = $regionId)
      GROUP BY TO_CHAR(bt."borrowedAt", 'YYYY-MM')
      ORDER BY oy
    `,
    description: "Kitobxonlik trendi (oylik dinamika)",
    chartType: "line",
  },
  {
    intent: "top_readers",
    keywords: ["top", "eng ko'p", "yaxshi", "kitobxon"],
    sqlTemplate: `
      SELECT u.name AS ism, u."sifatId" AS id, ri.score AS ball
      FROM "ReadingIndex" ri
      JOIN "User" u ON u.id = ri."userId"
      LEFT JOIN "Address" a ON a.id = u."addressId"
      WHERE ri."calculatedAt" >= $sinceDate
        AND ($regionId IS NULL OR a."viloyatId" = $regionId)
      ORDER BY ri.score DESC
      LIMIT 10
    `,
    description: "Top kitobxonlar (eng yuqori Reading Index)",
    chartType: "table",
  },
  {
    intent: "library_stats",
    keywords: ["kutubxona", "fond", "soni"],
    sqlTemplate: `
      SELECT l.name, l.type, l."fundCount",
        COUNT(DISTINCT bt.id) AS tranzaksiyalar
      FROM "Library" l
      LEFT JOIN "BookTransaction" bt ON bt."bookId" IN (
        SELECT b.id FROM "Book" b WHERE b."libraryId" = l.id
      ) AND bt."borrowedAt" >= $sinceDate
      WHERE l.status = 'ACTIVE'
        AND ($regionId IS NULL OR l."tumanId" IN (
          SELECT t.id FROM "Tuman" t WHERE t."viloyatId" = $regionId
        ))
      GROUP BY l.id, l.name, l.type, l."fundCount"
      ORDER BY tranzaksiyalar DESC
      LIMIT 20
    `,
    description: "Kutubxona fondi va faollik statistikasi",
    chartType: "table",
  },
  {
    intent: "goal_progress",
    keywords: ["maqsad", "erishildi", "progress", "10 kitob"],
    sqlTemplate: `
      SELECT
        COUNT(DISTINCT u.id) AS jami_kitobxon,
        COUNT(DISTINCT u.id) FILTER (WHERE sub.cnt >= 10) AS maqsadga_erishgan
      FROM "User" u
      LEFT JOIN (
        SELECT "userId", COUNT(*) AS cnt
        FROM "BookTransaction"
        WHERE type = 'BORROW' AND "borrowedAt" >= $yearStart
        GROUP BY "userId"
      ) sub ON sub."userId" = u.id
      WHERE u.status = 'ACTIVE'
    `,
    description: "Yillik 10 kitob maqsadi erishganlar",
    chartType: "number",
  },
];

// ── New Phase 5-6 templates (13+ additional intents) ────────────────────────

const PHASE56_TEMPLATES: NlqTemplate[] = [
  {
    intent: "school_coverage",
    keywords: ["maktab", "o'quvchi", "qamrov", "sinf"],
    sqlTemplate: `
      SELECT i.name AS maktab,
        COUNT(DISTINCT u.id) AS jami_oqvchi,
        COUNT(DISTINCT u.id) FILTER (WHERE ri.score IS NOT NULL AND ri.score > 0) AS faol,
        CASE WHEN COUNT(DISTINCT u.id) > 0
          THEN ROUND(COUNT(DISTINCT u.id) FILTER (WHERE ri.score IS NOT NULL AND ri.score > 0) * 100.0 / COUNT(DISTINCT u.id), 1)
          ELSE 0 END AS qamrov_foiz
      FROM "Institution" i
      JOIN "User" u ON u."institutionId" = i.id AND u.type = 'STUDENT'
      LEFT JOIN "ReadingIndex" ri ON ri."userId" = u.id AND ri."calculatedAt" >= $sinceDate
      WHERE i.type = 'SCHOOL'
      GROUP BY i.id, i.name
      ORDER BY qamrov_foiz DESC
      LIMIT 20
    `,
    description: "Maktablarda o'quvchi kitobxonlik qamrovi foizi",
    chartType: "bar",
  },
  {
    intent: "school_club_activity",
    keywords: ["klub", "debat", "jadidlar", "maktab faollik"],
    sqlTemplate: `
      SELECT c.name AS klub, i.name AS maktab,
        COUNT(d.id) AS debatlar_soni,
        COUNT(DISTINCT cm.id) AS azolar,
        MAX(d."heldAt") AS oxirgi_debat
      FROM "Club" c
      JOIN "Institution" i ON i.id = c."institutionId"
      LEFT JOIN "Debate" d ON d."clubId" = c.id AND d."heldAt" >= $sinceDate
      LEFT JOIN "ClubMember" cm ON cm."clubId" = c.id
      WHERE c.status = 'ACTIVE'
      GROUP BY c.id, c.name, i.name
      ORDER BY debatlar_soni DESC
      LIMIT 20
    `,
    description: "Jadidlar izidan klub debat faolligi statistikasi",
    chartType: "table",
  },
  {
    intent: "school_pq9_status",
    keywords: ["pq-9", "pq9", "maktab", "hisobot", "muvofiqlik"],
    sqlTemplate: `
      SELECT i.name AS maktab,
        EXISTS(SELECT 1 FROM "Club" c WHERE c."institutionId" = i.id AND c.status = 'ACTIVE') AS klub_mavjud,
        (SELECT COUNT(*) FROM "Debate" d JOIN "Club" c2 ON c2.id = d."clubId"
          WHERE c2."institutionId" = i.id AND d."heldAt" >= $sinceDate) AS debatlar,
        (SELECT ROUND(AVG(ri.score), 1) FROM "ReadingIndex" ri
          JOIN "User" u ON u.id = ri."userId"
          WHERE u."institutionId" = i.id AND ri."calculatedAt" >= $sinceDate) AS avg_ri
      FROM "Institution" i
      WHERE i.type = 'SCHOOL'
      ORDER BY i.name
      LIMIT 50
    `,
    description: "Maktablar PQ-9 muvofiqlik holati (klub, debat, RI)",
    chartType: "table",
  },
  {
    intent: "family_rankings",
    keywords: ["oila", "reyting", "oilaviy", "oila reytingi"],
    sqlTemplate: `
      SELECT f.id, f.name AS oila_nomi,
        COUNT(DISTINCT fm."userId") AS azolar,
        ROUND(AVG(ri.score), 1) AS avg_ri
      FROM "Family" f
      JOIN "FamilyMember" fm ON fm."familyId" = f.id
      LEFT JOIN "ReadingIndex" ri ON ri."userId" = fm."userId" AND ri."calculatedAt" >= $sinceDate
      GROUP BY f.id, f.name
      HAVING COUNT(DISTINCT fm."userId") >= 2
      ORDER BY avg_ri DESC NULLS LAST
      LIMIT 50
    `,
    description: "Top oilalar o'rtacha Reading Index bo'yicha",
    chartType: "table",
  },
  {
    intent: "org_reading_hour",
    keywords: ["idora", "o'qish soati", "tadbir", "soat"],
    sqlTemplate: `
      SELECT i.name AS idora,
        COUNT(rh.id) AS tadbirlar_soni,
        SUM(rh."attendeeCount") AS jami_ishtirokchi,
        MAX(rh."heldAt") AS oxirgi_tadbir
      FROM "Institution" i
      JOIN "ReadingHourEvent" rh ON rh."institutionId" = i.id
      WHERE rh."heldAt" >= $sinceDate
      GROUP BY i.id, i.name
      ORDER BY tadbirlar_soni DESC
      LIMIT 20
    `,
    description: "Idoralarda kitob o'qish soati tadbirlari statistikasi",
    chartType: "bar",
  },
  {
    intent: "org_book_corner",
    keywords: ["burchak", "kitob burchagi", "burchagi"],
    sqlTemplate: `
      SELECT i.name AS idora,
        bc.verified AS tasdiqlangan,
        bc."photoUrl" IS NOT NULL AS foto_mavjud,
        bc."verifiedAt" AS tasdiq_sanasi
      FROM "BookCorner" bc
      JOIN "Institution" i ON i.id = bc."institutionId"
      ORDER BY bc."verifiedAt" DESC NULLS LAST
      LIMIT 50
    `,
    description: "Kitob burchagi tasdiqlash holati",
    chartType: "table",
  },
  {
    intent: "org_employee_ranking",
    keywords: ["xodim", "reyting", "lavozim", "xodimlar"],
    sqlTemplate: `
      SELECT u.name AS xodim, u.position AS lavozim,
        i.name AS idora, ri.score AS ball
      FROM "ReadingIndex" ri
      JOIN "User" u ON u.id = ri."userId"
      JOIN "Institution" i ON i.id = u."institutionId"
      WHERE u.type = 'GOVERNMENT_EMPLOYEE' AND ri."calculatedAt" >= $sinceDate
      ORDER BY ri.score DESC
      LIMIT 20
    `,
    description: "Idora xodimlari Reading Index bo'yicha reyting",
    chartType: "table",
  },
  {
    intent: "university_faculty",
    keywords: ["otm", "fakultet", "talaba", "universitet"],
    sqlTemplate: `
      SELECT i.name AS otm, u.faculty AS fakultet,
        COUNT(DISTINCT u.id) AS talabalar,
        ROUND(AVG(ri.score), 1) AS avg_ri
      FROM "User" u
      JOIN "Institution" i ON i.id = u."institutionId"
      LEFT JOIN "ReadingIndex" ri ON ri."userId" = u.id AND ri."calculatedAt" >= $sinceDate
      WHERE u.type = 'STUDENT' AND i.type = 'UNIVERSITY'
      GROUP BY i.name, u.faculty
      ORDER BY avg_ri DESC NULLS LAST
      LIMIT 30
    `,
    description: "OTM fakultet darajasida kitobxonlik statistikasi",
    chartType: "bar",
  },
  {
    intent: "donation_stats",
    keywords: ["donat", "xayriya", "pul", "ehson"],
    sqlTemplate: `
      SELECT
        COUNT(*) AS jami_donatlar,
        COALESCE(SUM(d.amount), 0) AS jami_summa,
        COALESCE(SUM(d.amount) FILTER (WHERE d."allocatedTo" IS NOT NULL), 0) AS sarflangan,
        COUNT(DISTINCT d."donorId") AS donatchilar_soni
      FROM "Donation" d
      WHERE d."createdAt" >= $sinceDate
    `,
    description: "Donat (xayriya) yig'ilgan va sarflangan mablag'lar",
    chartType: "number",
  },
  {
    intent: "payment_status",
    keywords: ["to'lov", "obuna", "faktura", "subscription"],
    sqlTemplate: `
      SELECT s."planType" AS tarif,
        COUNT(*) AS jami,
        COUNT(*) FILTER (WHERE s.status = 'ACTIVE') AS faol,
        COUNT(*) FILTER (WHERE s.status = 'PENDING') AS kutilmoqda,
        COUNT(*) FILTER (WHERE s.status = 'FROZEN') AS muzlatilgan
      FROM "Subscription" s
      GROUP BY s."planType"
      ORDER BY jami DESC
    `,
    description: "Subscription to'lov holati (tarif bo'yicha)",
    chartType: "bar",
  },
  {
    intent: "fraud_overview",
    keywords: ["firibgarlik", "fraud", "shubhali", "xavf"],
    sqlTemplate: `
      SELECT
        COUNT(*) FILTER (WHERE fs."riskScore" BETWEEN 0 AND 24) AS xavfsiz,
        COUNT(*) FILTER (WHERE fs."riskScore" BETWEEN 25 AND 49) AS past_risk,
        COUNT(*) FILTER (WHERE fs."riskScore" BETWEEN 50 AND 69) AS tekshiruv,
        COUNT(*) FILTER (WHERE fs."riskScore" >= 70) AS bloklangan,
        COUNT(*) AS jami
      FROM "FraudScore" fs
    `,
    description: "Fraud risk darajalar bo'yicha taqsimot",
    chartType: "pie",
  },
  {
    intent: "alert_summary",
    keywords: ["ogohlantirish", "alert", "xabar", "bildirishnoma"],
    sqlTemplate: `
      SELECT
        al."issueType" AS turi,
        al.severity AS daraja,
        COUNT(*) AS soni,
        COUNT(*) FILTER (WHERE al.resolved = false) AS ochiq
      FROM "AiAuditLog" al
      WHERE al."createdAt" >= $sinceDate
      GROUP BY al."issueType", al.severity
      ORDER BY soni DESC
    `,
    description: "Smart alert xulosa (tur va daraja bo'yicha)",
    chartType: "table",
  },
  {
    intent: "badge_stats",
    keywords: ["nishon", "badge", "yutuq", "medal"],
    sqlTemplate: `
      SELECT ub."badgeCode" AS nishon,
        COUNT(*) AS berilgan_soni
      FROM "UserBadge" ub
      WHERE ub."earnedAt" >= $sinceDate
      GROUP BY ub."badgeCode"
      ORDER BY berilgan_soni DESC
    `,
    description: "Badge (nishon) taqsimoti foydalanuvchilar bo'yicha",
    chartType: "bar",
  },
  {
    intent: "map_ri_overview",
    keywords: ["xarita", "viloyat", "indeks", "hududiy"],
    sqlTemplate: `
      SELECT v.id AS viloyat_id, v.name AS viloyat,
        ROUND(AVG(ri.score), 1) AS avg_ri,
        COUNT(DISTINCT u.id) AS faol_kitobxon
      FROM "Viloyat" v
      LEFT JOIN "Address" a ON a."viloyatId" = v.id
      LEFT JOIN "User" u ON u."addressId" = a.id AND u.status = 'ACTIVE'
      LEFT JOIN "ReadingIndex" ri ON ri."userId" = u.id AND ri."calculatedAt" >= $sinceDate
      GROUP BY v.id, v.name
      ORDER BY avg_ri DESC NULLS LAST
    `,
    description: "Viloyatlar bo'yicha RI xarita ma'lumotlari",
    chartType: "bar",
  },
  {
    intent: "overdue_books",
    keywords: ["muddati", "o'tgan", "qaytarilmagan", "kechikkan"],
    sqlTemplate: `
      SELECT
        v.name AS viloyat,
        COUNT(*) AS muddati_otgan,
        ROUND(AVG(EXTRACT(DAY FROM NOW() - bt."borrowedAt" - INTERVAL '14 days')), 0) AS avg_kechikish_kun
      FROM "BookTransaction" bt
      JOIN "User" u ON u.id = bt."userId"
      JOIN "Address" a ON a.id = u."addressId"
      JOIN "Viloyat" v ON v.id = a."viloyatId"
      WHERE bt.type = 'BORROW' AND bt.status = 'BORROWED'
        AND bt."borrowedAt" < NOW() - INTERVAL '14 days'
        AND bt."returnedAt" IS NULL
      GROUP BY v.id, v.name
      ORDER BY muddati_otgan DESC
    `,
    description: "Muddati o'tgan qaytarilmagan kitoblar (viloyat bo'yicha)",
    chartType: "bar",
  },
  {
    intent: "store_purchases",
    keywords: ["do'kon", "sotib olish", "isbn", "harid"],
    sqlTemplate: `
      SELECT
        COUNT(*) AS jami_haridlar,
        COUNT(*) FILTER (WHERE sp.verified = true) AS tasdiqlangan,
        COUNT(*) FILTER (WHERE sp.verified = false) AS kutilmoqda,
        COUNT(DISTINCT sp."storeId") AS dokonlar_soni
      FROM "StorePurchase" sp
      WHERE sp."purchaseDate" >= $sinceDate
    `,
    description: "Kitob do'konlari orqali sotib olish statistikasi",
    chartType: "number",
  },
];

/** All 23 NLQ templates -- the centralized registry */
export const NLQ_TEMPLATES: NlqTemplate[] = [
  ...ORIGINAL_TEMPLATES,
  ...PHASE56_TEMPLATES,
];

/** Derive a union type of all valid intent names */
export type NlqIntent = (typeof NLQ_TEMPLATES)[number]["intent"];
