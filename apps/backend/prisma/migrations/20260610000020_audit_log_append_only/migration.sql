-- ═══════════════════════════════════════════════════════════════════════════
-- M7 (2026-06-10) — AiAuditLog append-only DB darajasida (§8.4 audit qoidasi)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- @prisma-skip-generate
-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║ RAW SQL MIGRATION — prisma migrate dev tomonidan generatsiya qilinmagan.║
-- ║                                                                          ║
-- ║ CLAUDE.md §8.4: audit log append-only — "hech kim (hatto Super Admin)   ║
-- ║ o'zgartira olmaydi". Shu paytgacha bu faqat aplikatsiya konventsiyasi    ║
-- ║ edi; ushbu migration uni DB darajasida majburiy qiladi.                  ║
-- ║                                                                          ║
-- ║ AiAuditLog — RANGE-partitioned jadval (20260609000000_phase7 ga qarang).║
-- ║ PG15 da partitioned PARENT ustida yaratilgan row-level trigger barcha    ║
-- ║ mavjud VA kelajakda yaratiladigan/biriktiriladigan partitionlarga        ║
-- ║ avtomatik klonlanadi (BEFORE row triggerlar PG13+ dan beri qo'llanadi). ║
-- ║                                                                          ║
-- ║ Qoidalar:                                                                ║
-- ║   * BEFORE DELETE  → har doim RAISE EXCEPTION (o'chirish taqiqlangan);  ║
-- ║   * BEFORE UPDATE  → faqat "resolved" ustuni o'zgargan bo'lsa ruxsat.   ║
-- ║     (Schema'da resolvedAt/resolvedBy ustunlari YO'Q — yagona mutable    ║
-- ║     ustun `resolved`; admin.service.resolveAlert va                     ║
-- ║     audit.service.resolveAuditLog faqat `resolved: true` yozadi.)       ║
-- ║                                                                          ║
-- ║ Partition lifecycle eslatmasi: oylik partitionlarni arxivlash           ║
-- ║ DETACH PARTITION / DROP TABLE DDL orqali bajariladi — DDL row-level     ║
-- ║ triggerlarni ISHGA TUSHIRMAYDI, shuning uchun rotatsiya/arxivlash       ║
-- ║ jarayoni bu triggerlardan mutlaqo ta'sirlanmaydi.                       ║
-- ║                                                                          ║
-- ║ DO NOT regenerate this migration.                                       ║
-- ╚═════════════════════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION sifat_ai_audit_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'AiAuditLog append-only: DELETE taqiqlangan (audit log o''zgarmas, CLAUDE.md §8.4)';
    END IF;

    -- UPDATE: "resolved" dan tashqari BARCHA ustunlar o'zgarmagan bo'lishi shart.
    -- IS DISTINCT FROM — NULL-xavfsiz taqqoslash.
    IF NEW."id"             IS DISTINCT FROM OLD."id"
       OR NEW."scope"          IS DISTINCT FROM OLD."scope"
       OR NEW."scopeId"        IS DISTINCT FROM OLD."scopeId"
       OR NEW."issueType"      IS DISTINCT FROM OLD."issueType"
       OR NEW."severity"       IS DISTINCT FROM OLD."severity"
       OR NEW."analysis"       IS DISTINCT FROM OLD."analysis"
       OR NEW."recommendation" IS DISTINCT FROM OLD."recommendation"
       OR NEW."createdAt"      IS DISTINCT FROM OLD."createdAt"
    THEN
        RAISE EXCEPTION
            'AiAuditLog append-only: faqat "resolved" ustunini o''zgartirish mumkin (CLAUDE.md §8.4)';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Partitioned parent ustidagi row-level triggerlar barcha partitionlarga klonlanadi.
DROP TRIGGER IF EXISTS ai_audit_log_no_delete ON "AiAuditLog";
CREATE TRIGGER ai_audit_log_no_delete
    BEFORE DELETE ON "AiAuditLog"
    FOR EACH ROW
    EXECUTE FUNCTION sifat_ai_audit_log_append_only();

DROP TRIGGER IF EXISTS ai_audit_log_guard_update ON "AiAuditLog";
CREATE TRIGGER ai_audit_log_guard_update
    BEFORE UPDATE ON "AiAuditLog"
    FOR EACH ROW
    EXECUTE FUNCTION sifat_ai_audit_log_append_only();
