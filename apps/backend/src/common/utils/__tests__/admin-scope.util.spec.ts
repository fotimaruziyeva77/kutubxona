import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import {
  assertViloyatInScope,
  assertTumanInScope,
  assertInstitutionInScope,
} from "../admin-scope.util";

describe("admin-scope util (Plan 05-02 T1, OQ-6 Q6)", () => {
  // ── assertViloyatInScope ────────────────────────────────────────────────
  describe("assertViloyatInScope", () => {
    it("SUPER_ADMIN bypasses (no throw)", () => {
      expect(() =>
        assertViloyatInScope(
          { role: UserRole.SUPER_ADMIN, address: null },
          "UZ-08",
        ),
      ).not.toThrow();
    });

    it("BUXGALTER bypasses (global financial scope)", () => {
      expect(() =>
        assertViloyatInScope(
          { role: UserRole.BUXGALTER, address: null },
          "UZ-08",
        ),
      ).not.toThrow();
    });

    it("VILOYAT_ADMIN with matching viloyatId passes", () => {
      expect(() =>
        assertViloyatInScope(
          {
            role: UserRole.VILOYAT_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: null },
          },
          "UZ-08",
        ),
      ).not.toThrow();
    });

    it("VILOYAT_ADMIN with mismatched viloyatId throws ForbiddenException", () => {
      expect(() =>
        assertViloyatInScope(
          {
            role: UserRole.VILOYAT_ADMIN,
            address: { viloyatId: "UZ-12", tumanId: null },
          },
          "UZ-08",
        ),
      ).toThrow(ForbiddenException);
    });

    it("VILOYAT_ADMIN with NULL viloyatId throws (fail-CLOSED — Plan 04-04-fix-followup)", () => {
      expect(() =>
        assertViloyatInScope(
          { role: UserRole.VILOYAT_ADMIN, address: null },
          "UZ-08",
        ),
      ).toThrow(ForbiddenException);
    });

    it("TUMAN_ADMIN throws (cannot query viloyat-scope at all)", () => {
      expect(() =>
        assertViloyatInScope(
          {
            role: UserRole.TUMAN_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
          },
          "UZ-08",
        ),
      ).toThrow(ForbiddenException);
    });

    it("KITOBXON throws", () => {
      expect(() =>
        assertViloyatInScope(
          {
            role: UserRole.KITOBXON,
            address: { viloyatId: "UZ-08", tumanId: null },
          },
          "UZ-08",
        ),
      ).toThrow(ForbiddenException);
    });
  });

  // ── assertTumanInScope ──────────────────────────────────────────────────
  describe("assertTumanInScope", () => {
    it("SUPER_ADMIN bypasses (no throw)", () => {
      expect(() =>
        assertTumanInScope(
          { role: UserRole.SUPER_ADMIN, address: null },
          "UZ-08-012",
        ),
      ).not.toThrow();
    });

    it("BUXGALTER bypasses", () => {
      expect(() =>
        assertTumanInScope(
          { role: UserRole.BUXGALTER, address: null },
          "UZ-08-012",
        ),
      ).not.toThrow();
    });

    it("TUMAN_ADMIN with matching tumanId passes", () => {
      expect(() =>
        assertTumanInScope(
          {
            role: UserRole.TUMAN_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
          },
          "UZ-08-012",
        ),
      ).not.toThrow();
    });

    it("TUMAN_ADMIN with mismatched tumanId throws", () => {
      expect(() =>
        assertTumanInScope(
          {
            role: UserRole.TUMAN_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: "UZ-08-015" },
          },
          "UZ-08-012",
        ),
      ).toThrow(ForbiddenException);
    });

    it("TUMAN_ADMIN with NULL tumanId throws (fail-CLOSED)", () => {
      expect(() =>
        assertTumanInScope(
          {
            role: UserRole.TUMAN_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: null },
          },
          "UZ-08-012",
        ),
      ).toThrow(ForbiddenException);
    });

    it("VILOYAT_ADMIN with resolvedViloyatId matching passes", () => {
      expect(() =>
        assertTumanInScope(
          {
            role: UserRole.VILOYAT_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: null },
          },
          "UZ-08-012",
          { resolvedViloyatId: "UZ-08" },
        ),
      ).not.toThrow();
    });

    it("VILOYAT_ADMIN with resolvedViloyatId mismatch throws", () => {
      expect(() =>
        assertTumanInScope(
          {
            role: UserRole.VILOYAT_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: null },
          },
          "UZ-12-015",
          { resolvedViloyatId: "UZ-12" },
        ),
      ).toThrow(ForbiddenException);
    });

    it("VILOYAT_ADMIN without resolvedViloyatId throws (unresolved viloyat)", () => {
      expect(() =>
        assertTumanInScope(
          {
            role: UserRole.VILOYAT_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: null },
          },
          "UZ-08-012",
        ),
      ).toThrow(ForbiddenException);
    });

    it("VILOYAT_ADMIN with NULL viloyatId throws (fail-CLOSED)", () => {
      expect(() =>
        assertTumanInScope(
          { role: UserRole.VILOYAT_ADMIN, address: null },
          "UZ-08-012",
          { resolvedViloyatId: "UZ-08" },
        ),
      ).toThrow(ForbiddenException);
    });

    it("KITOBXON throws", () => {
      expect(() =>
        assertTumanInScope(
          {
            role: UserRole.KITOBXON,
            address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
          },
          "UZ-08-012",
        ),
      ).toThrow(ForbiddenException);
    });
  });

  // ── assertInstitutionInScope (Plan 06-01) ────────────────────────────────
  describe("assertInstitutionInScope", () => {
    it("SUPER_ADMIN bypasses (no throw)", () => {
      expect(() =>
        assertInstitutionInScope(
          { role: UserRole.SUPER_ADMIN, address: null },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).not.toThrow();
    });

    it("BUXGALTER bypasses", () => {
      expect(() =>
        assertInstitutionInScope(
          { role: UserRole.BUXGALTER, address: null },
          "inst-1",
          { type: "IDORA", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).not.toThrow();
    });

    it("MUASSASA_ADMIN with matching schoolId (MAKTAB) passes", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.MUASSASA_ADMIN,
            address: null,
            schoolId: "inst-1",
          },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).not.toThrow();
    });

    it("MUASSASA_ADMIN with mismatched schoolId (MAKTAB) throws", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.MUASSASA_ADMIN,
            address: null,
            schoolId: "inst-other",
          },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).toThrow(ForbiddenException);
    });

    it("MUASSASA_ADMIN with matching universityId (OTM) passes", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.MUASSASA_ADMIN,
            address: null,
            universityId: "uni-1",
          },
          "uni-1",
          { type: "OTM", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).not.toThrow();
    });

    it("MUASSASA_ADMIN with matching organizationId (IDORA) passes", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.MUASSASA_ADMIN,
            address: null,
            organizationId: "org-1",
          },
          "org-1",
          { type: "IDORA", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).not.toThrow();
    });

    it("MUASSASA_ADMIN with NULL FK (fail-CLOSED) throws", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.MUASSASA_ADMIN,
            address: null,
            schoolId: null,
          },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).toThrow(ForbiddenException);
    });

    it("VILOYAT_ADMIN with matching resolved.viloyatId passes", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.VILOYAT_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: null },
          },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).not.toThrow();
    });

    it("VILOYAT_ADMIN with mismatched resolved.viloyatId throws", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.VILOYAT_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: null },
          },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-12", tumanId: "UZ-12-001" },
        ),
      ).toThrow(ForbiddenException);
    });

    it("VILOYAT_ADMIN with NULL viloyatId (fail-CLOSED) throws", () => {
      expect(() =>
        assertInstitutionInScope(
          { role: UserRole.VILOYAT_ADMIN, address: null },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).toThrow(ForbiddenException);
    });

    it("TUMAN_ADMIN with matching resolved.tumanId passes", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.TUMAN_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
          },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).not.toThrow();
    });

    it("TUMAN_ADMIN with mismatched resolved.tumanId throws", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.TUMAN_ADMIN,
            address: { viloyatId: "UZ-08", tumanId: "UZ-08-015" },
          },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).toThrow(ForbiddenException);
    });

    it("TUMAN_ADMIN with NULL tumanId (fail-CLOSED) throws", () => {
      expect(() =>
        assertInstitutionInScope(
          { role: UserRole.TUMAN_ADMIN, address: null },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).toThrow(ForbiddenException);
    });

    it("KITOBXON throws unconditionally", () => {
      expect(() =>
        assertInstitutionInScope(
          {
            role: UserRole.KITOBXON,
            address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
            schoolId: "inst-1",
          },
          "inst-1",
          { type: "MAKTAB", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        ),
      ).toThrow(ForbiddenException);
    });
  });
});
