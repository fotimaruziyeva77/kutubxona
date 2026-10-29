-- Phase 4 Plan 04-03 Task 1 — Subscription audit-fields migration (PAY-08)
--
-- Purpose: persist the WHO/WHEN/WHY for FROZEN and DELETED Subscription
-- transitions, per CLAUDE.md §XIII.3 ("muzlatish va o'chirish — sabab majburiy").
--
-- All 6 new columns are nullable — backward-compatible with existing rows
-- (NULL on legacy data, no DEFAULT migration cost). The audit columns are
-- written by `SubscriptionService.updateStatus` inside `prisma.$transaction`
-- alongside an `AiAuditLog` STATE_TRANSITION row (D-PAY-06 / D-PAY-08).
--
-- Audit columns are intentionally plain `TEXT` (not foreign keys to User)
-- mirroring the existing `Library.frozenReason` pattern — keeps cascading
-- delete semantics simple if the admin user later leaves.

ALTER TABLE "Subscription" ADD COLUMN "frozenReason" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "frozenAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "frozenBy" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "deletedReason" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "deletedBy" TEXT;
