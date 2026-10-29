/**
 * AUDIT-REPORT M2 — profil DTO validatsiyasi spec.
 *
 * Avval CompleteProfileDto/UpdateProfileDto TS interface edi: runtime'da
 * metatype Object bo'lib, global ValidationPipe NO-OP edi (istalgan body
 * qabul qilinardi). Endi class-validator dekoratorli class'lar.
 *
 * Pipe sozlamalari main.ts dagi global pipe bilan AYNAN bir xil:
 *   whitelist: true (begona maydonlar olib tashlanadi — userId in'ektsiyasi
 *   ham shu yo'l bilan bloklanadi), transform + enableImplicitConversion.
 */
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import type { ArgumentMetadata } from "@nestjs/common";
import { CompleteProfileDto, UpdateProfileDto } from "../dto/profile.dto";

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: false,
  transform: true,
  transformOptions: { enableImplicitConversion: true }
});

const completeMeta: ArgumentMetadata = { type: "body", metatype: CompleteProfileDto };
const updateMeta: ArgumentMetadata = { type: "body", metatype: UpdateProfileDto };

const validBody = {
  name: "Alisher Navoiy",
  dob: "2000-01-01",
  gender: "MALE",
  viloyatId: "v1",
  tumanId: "t1",
  mahallaId: "m1",
  street: "Mustaqillik",
  house: "12",
  apartment: "34",
  type: "CITIZEN"
};

describe("M2 — profil DTO validatsiyasi (class-validator)", () => {
  describe("CompleteProfileDto", () => {
    it("to'g'ri body o'tadi va class instance qaytadi", async () => {
      const result = await pipe.transform({ ...validBody }, completeMeta);
      expect(result).toBeInstanceOf(CompleteProfileDto);
      expect(result.name).toBe("Alisher Navoiy");
      expect(result.gender).toBe("MALE");
    });

    it("noto'g'ri gender enum — 400 BadRequestException", async () => {
      await expect(
        pipe.transform({ ...validBody, gender: "ATTACK" }, completeMeta)
      ).rejects.toThrow(BadRequestException);
    });

    it("noto'g'ri type enum — 400", async () => {
      await expect(
        pipe.transform({ ...validBody, type: "SUPER_ADMIN_PLEASE" }, completeMeta)
      ).rejects.toThrow(BadRequestException);
    });

    it("name yo'q — 400 (majburiy maydon)", async () => {
      const { name: _name, ...withoutName } = validBody;
      await expect(pipe.transform(withoutName, completeMeta)).rejects.toThrow(
        BadRequestException
      );
    });

    it("dob ISO sana emas — 400", async () => {
      await expect(
        pipe.transform({ ...validBody, dob: "kecha edi" }, completeMeta)
      ).rejects.toThrow(BadRequestException);
    });

    it("begona maydonlar (userId in'ektsiyasi ham) whitelist bilan olib tashlanadi", async () => {
      const result = await pipe.transform(
        {
          ...validBody,
          userId: "boshqa-foydalanuvchi-id", // body orqali soxtalash urinishi
          isAdmin: true,
          hacker: "payload"
        },
        completeMeta
      );

      const keys = Object.keys(result as Record<string, unknown>);
      expect(keys).not.toContain("userId");
      expect(keys).not.toContain("isAdmin");
      expect(keys).not.toContain("hacker");
    });

    it("studyCourse 0 yoki manfiy — 400 (@Min(1))", async () => {
      await expect(
        pipe.transform(
          { ...validBody, type: "STUDENT_UNIVERSITY", studyCourse: 0 },
          completeMeta
        )
      ).rejects.toThrow(BadRequestException);
    });

    it("ixtiyoriy maydonlar berilmasa ham o'tadi (CITIZEN)", async () => {
      const result = await pipe.transform({ ...validBody }, completeMeta);
      expect(result.schoolId).toBeUndefined();
      expect(result.studyCourse).toBeUndefined();
    });
  });

  describe("UpdateProfileDto", () => {
    it("bo'sh body o'tadi (hamma maydon ixtiyoriy)", async () => {
      const result = await pipe.transform({}, updateMeta);
      expect(result).toBeInstanceOf(UpdateProfileDto);
    });

    it("begona maydonlar olib tashlanadi", async () => {
      const result = await pipe.transform(
        { name: "Yangi Ism", trustScore: 100, role: "SUPER_ADMIN" },
        updateMeta
      );
      const keys = Object.keys(result as Record<string, unknown>);
      expect(result.name).toBe("Yangi Ism");
      expect(keys).not.toContain("trustScore");
      expect(keys).not.toContain("role");
    });

    it("juda uzun name (MaxLength 200) — 400", async () => {
      await expect(
        pipe.transform({ name: "x".repeat(201) }, updateMeta)
      ).rejects.toThrow(BadRequestException);
    });
  });
});
