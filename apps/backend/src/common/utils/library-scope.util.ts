/**
 * Library-scope resolver (RBAC fix — Muassasa/Kitob-fondi dropdown leak).
 *
 * THE BUG: a KUTUBXONACHI / MUASSASA_ADMIN saw EVERY library in the
 * "Muassasa paneli" and "Kitob fondi" dropdowns, because the frontend hit
 * the @Public GET /libraries (returns all) and the payment controller's
 * private getCallerLibraryId resolved via Library.findFirst({ institutionId })
 * — which is BROKEN: every Library row has institutionId = NULL (the reverse
 * link was never populated). The REAL link is the forward one:
 *
 *     User.{schoolId | universityId | organizationId}  →  Institution.id
 *     Institution.libraryId                            →  Library.id   (POPULATED)
 *
 * This module centralises the correct resolution so both the payment module
 * (subscriptions/library/me) and the libraries module (GET /libraries/mine)
 * use the SAME, correct path. Pure async function — takes a minimal Prisma
 * client surface so it needs no module wiring (PrismaModule is @Global but
 * PaymentModule does not import LibrariesModule, and we avoid a circular dep).
 */

/** Minimal Prisma surface this resolver needs. PrismaService satisfies it. */
export interface LibraryScopePrisma {
  user: {
    findUnique(args: {
      where: { id: string };
      select: {
        schoolId: true;
        universityId: true;
        organizationId: true;
      };
    }): Promise<{
      schoolId: string | null;
      universityId: string | null;
      organizationId: string | null;
    } | null>;
  };
  institution: {
    findUnique(args: {
      where: { id: string };
      select: { libraryId: true };
    }): Promise<{ libraryId: string | null } | null>;
  };
}

/**
 * Resolve the single library a user manages, via the CORRECT forward link:
 *   user.(schoolId ?? universityId ?? organizationId) → Institution.libraryId.
 *
 * Returns the library id, or null when the user has no institution link
 * (or the institution has no library attached). Never throws — callers
 * decide whether a null result is a 403 or an empty list.
 */
export async function resolveCallerLibraryId(
  prisma: LibraryScopePrisma,
  userId: string,
): Promise<string | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { schoolId: true, universityId: true, organizationId: true },
  });
  if (!u) return null;

  const institutionId = u.schoolId ?? u.universityId ?? u.organizationId;
  if (!institutionId) return null;

  const inst = await prisma.institution.findUnique({
    where: { id: institutionId },
    select: { libraryId: true },
  });
  return inst?.libraryId ?? null;
}
