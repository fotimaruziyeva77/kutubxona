/**
 * Plan 05-02 Task 1 — Tier-admin scope-assertion helpers (STAT-01 + OQ-6).
 *
 * Defense-in-depth: RolesGuard tiers WHO can hit a stats endpoint, but the
 * service must still verify that a VILOYAT_ADMIN is not reading SOMEONE
 * ELSE'S viloyat. Mirrors Phase 4-04-fix `assertLibraryInScope` from
 * payment.controller.ts:180-209 — same fail-CLOSED on null scope pattern
 * established by Plan 04-04-fix-followup (FIX D follow-up).
 *
 * Pure functions — no DB calls. The caller resolves the request-target's
 * viloyatId via a lookup (Tuman.viloyatId for tuman-scope, Mahalla→Tuman
 * for mahalla-scope) and passes it through `options.resolvedViloyatId`.
 *
 * Threat model:
 * - T-05-01  EoP: VILOYAT_ADMIN reads sibling viloyat stats   → throw
 * - T-05-01b EoP: TUMAN_ADMIN reads sibling tuman stats        → throw
 * - T-05-01c EoP: VILOYAT_ADMIN reads tuman in OTHER viloyat   → throw
 *                 (only when resolvedViloyatId is supplied)
 * - T-05-02  Tamper: scope assert runs BEFORE cache.remember
 *                 so a forbidden user does not poison the cache
 */
import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";

export interface ScopedUser {
  role: UserRole | string;
  address?: { viloyatId?: string | null; tumanId?: string | null } | null;
}

/**
 * SUPER_ADMIN + BUXGALTER bypass (global financial / monitoring scope).
 * VILOYAT_ADMIN: must have a non-null viloyatId AND it must match `requestedViloyatId`.
 * TUMAN_ADMIN: NOT allowed to query viloyat-scope (their scope is narrower).
 * Anything else: throw (KITOBXON/KUTUBXONACHI/etc. must not reach this endpoint).
 *
 * Fail-CLOSED: a VILOYAT_ADMIN whose address row is null falls through to a
 * 403 rather than silently bypassing — mirrors Plan 04-04-fix-followup.
 */
export function assertViloyatInScope(
  user: ScopedUser,
  requestedViloyatId: string,
): void {
  const role = user.role as UserRole;
  if (role === UserRole.SUPER_ADMIN || role === UserRole.BUXGALTER) {
    return;
  }
  if (role === UserRole.VILOYAT_ADMIN) {
    const callerViloyatId = user.address?.viloyatId ?? null;
    if (!callerViloyatId) {
      throw new ForbiddenException(
        "Hudud aniqlanmagan — administrator manzilini sozlang",
      );
    }
    if (callerViloyatId !== requestedViloyatId) {
      throw new ForbiddenException(
        "Scope mismatch: viloyat doirasidan tashqarida",
      );
    }
    return;
  }
  throw new ForbiddenException(
    "Scope mismatch: viloyatga ruxsat yo'q",
  );
}

/**
 * SUPER_ADMIN + BUXGALTER bypass.
 * VILOYAT_ADMIN: must have a non-null viloyatId AND callsite must supply
 *                `options.resolvedViloyatId` (the Tuman.viloyatId of the
 *                requested tuman) AND it must match.
 * TUMAN_ADMIN: must have a non-null tumanId AND it must match `requestedTumanId`.
 * Anything else: throw.
 */
export function assertTumanInScope(
  user: ScopedUser,
  requestedTumanId: string,
  options: { resolvedViloyatId?: string | null } = {},
): void {
  const role = user.role as UserRole;
  if (role === UserRole.SUPER_ADMIN || role === UserRole.BUXGALTER) {
    return;
  }
  if (role === UserRole.VILOYAT_ADMIN) {
    const callerViloyatId = user.address?.viloyatId ?? null;
    if (!callerViloyatId) {
      throw new ForbiddenException(
        "Hudud aniqlanmagan — administrator manzilini sozlang",
      );
    }
    const resolved = options.resolvedViloyatId ?? null;
    if (!resolved) {
      throw new ForbiddenException(
        "Scope mismatch: tuman viloyati aniqlanmagan",
      );
    }
    if (callerViloyatId !== resolved) {
      throw new ForbiddenException(
        "Scope mismatch: tuman boshqa viloyatda",
      );
    }
    return;
  }
  if (role === UserRole.TUMAN_ADMIN) {
    const callerTumanId = user.address?.tumanId ?? null;
    if (!callerTumanId) {
      throw new ForbiddenException(
        "Hudud aniqlanmagan — administrator manzilini sozlang",
      );
    }
    if (callerTumanId !== requestedTumanId) {
      throw new ForbiddenException(
        "Scope mismatch: tuman doirasidan tashqarida",
      );
    }
    return;
  }
  throw new ForbiddenException(
    "Scope mismatch: tumanga ruxsat yo'q",
  );
}

// ── Plan 06-01 Task 1 — assertInstitutionInScope ────────────────────────────
//
// Mirrors the same fail-CLOSED scope pattern as assertViloyatInScope and
// assertTumanInScope. SUPER_ADMIN + BUXGALTER bypass globally. MUASSASA_ADMIN
// must own the institution by FK (schoolId / universityId / organizationId).
// VILOYAT_ADMIN / TUMAN_ADMIN are scoped via `resolved` (which the caller looks
// up from the Institution row — tumanId + viloyatId). Anything else throws.
//
// Threat model:
// - T-06-06 EoP: MUASSASA_ADMIN with null FK falls through to a 403
//                rather than silently bypassing (FAIL-CLOSED contract).
// - T-06-06b EoP: VILOYAT_ADMIN reading sibling viloyat institution → throw
// - T-06-06c EoP: TUMAN_ADMIN reading sibling tuman institution     → throw
// - T-06-06d EoP: KITOBXON/KUTUBXONACHI reaching this assert        → throw

export type InstitutionType = "SCHOOL" | "UNIVERSITY" | "ORG" | "MAH" | "MAKTAB" | "OTM" | "IDORA";

export interface InstitutionScopedUser extends ScopedUser {
  schoolId?: string | null;
  universityId?: string | null;
  organizationId?: string | null;
}

/**
 * Assert the caller is allowed to act on a specific institution.
 *
 *  - SUPER_ADMIN + BUXGALTER bypass.
 *  - MUASSASA_ADMIN: matching FK by resolved.type:
 *      MAKTAB / SCHOOL → user.schoolId
 *      OTM    / UNIVERSITY → user.universityId
 *      IDORA  / ORG → user.organizationId
 *      MAH → schoolId (mahalla kutubxonalari ham schoolId orqali aniqlanadi).
 *    Fail-CLOSED on null FK.
 *  - VILOYAT_ADMIN: must have non-null viloyatId AND resolved.viloyatId AND match.
 *  - TUMAN_ADMIN: must have non-null tumanId AND resolved.tumanId AND match.
 *  - Anything else: ForbiddenException.
 */
export function assertInstitutionInScope(
  user: InstitutionScopedUser,
  _requestedInstitutionId: string,
  resolved: {
    viloyatId?: string | null;
    tumanId?: string | null;
    type: InstitutionType;
  },
): void {
  const role = user.role as UserRole;
  if (role === UserRole.SUPER_ADMIN || role === UserRole.BUXGALTER) {
    return;
  }

  if (role === UserRole.MUASSASA_ADMIN) {
    const type = resolved.type;
    let callerFk: string | null = null;
    if (type === "MAKTAB" || type === "SCHOOL" || type === "MAH") {
      callerFk = user.schoolId ?? null;
    } else if (type === "OTM" || type === "UNIVERSITY") {
      callerFk = user.universityId ?? null;
    } else if (type === "IDORA" || type === "ORG") {
      callerFk = user.organizationId ?? null;
    }
    if (!callerFk) {
      throw new ForbiddenException(
        "Scope mismatch: muassasaga ruxsat yo'q",
      );
    }
    if (callerFk !== _requestedInstitutionId) {
      throw new ForbiddenException(
        "Scope mismatch: muassasa doirasidan tashqarida",
      );
    }
    return;
  }

  if (role === UserRole.VILOYAT_ADMIN) {
    const callerViloyatId = user.address?.viloyatId ?? null;
    if (!callerViloyatId) {
      throw new ForbiddenException(
        "Hudud aniqlanmagan — administrator manzilini sozlang",
      );
    }
    const resolvedViloyatId = resolved.viloyatId ?? null;
    if (!resolvedViloyatId) {
      throw new ForbiddenException(
        "Scope mismatch: muassasa viloyati aniqlanmagan",
      );
    }
    if (callerViloyatId !== resolvedViloyatId) {
      throw new ForbiddenException(
        "Scope mismatch: muassasa boshqa viloyatda",
      );
    }
    return;
  }

  if (role === UserRole.TUMAN_ADMIN) {
    const callerTumanId = user.address?.tumanId ?? null;
    if (!callerTumanId) {
      throw new ForbiddenException(
        "Hudud aniqlanmagan — administrator manzilini sozlang",
      );
    }
    const resolvedTumanId = resolved.tumanId ?? null;
    if (!resolvedTumanId) {
      throw new ForbiddenException(
        "Scope mismatch: muassasa tumani aniqlanmagan",
      );
    }
    if (callerTumanId !== resolvedTumanId) {
      throw new ForbiddenException(
        "Scope mismatch: muassasa boshqa tumanda",
      );
    }
    return;
  }

  throw new ForbiddenException(
    "Scope mismatch: muassasaga ruxsat yo'q",
  );
}
