-- Audit MEDIUM M5 — OneID PINFL identity binding.
--
-- loginOrRegister linked OneID accounts by PHONE ONLY and discarded the
-- PINFL the provider returned. Phone numbers in O'zbekiston are recycled
-- and changed; a recycled number let the WRONG citizen into an existing
-- account, and there was no durable state-identity link at all.
--
-- Fix: persist the PINFL on User as a nullable unique column. Linking order
-- becomes pinfl-first (see iduz.service.loginOrRegister): existing users
-- without a pinfl get a one-time bind on their next OneID login; a phone
-- match with a DIFFERENT stored pinfl is rejected.
--
-- Index name matches Prisma's default for a field-level @unique on `pinfl`
-- (`User_pinfl_key`) so `migrate dev` never reports drift. Nullable unique:
-- PostgreSQL treats NULLs as distinct, so the millions of non-OneID users
-- (pinfl IS NULL) are never blocked.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pinfl" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_pinfl_key" ON "User"("pinfl");
