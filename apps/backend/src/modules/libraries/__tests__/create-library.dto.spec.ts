import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  CreateLibraryDto,
  UpdateLibraryDto,
  isLibraryNameSafe,
} from "../dto/create-library.dto";
import { LibraryType } from "@prisma/client";

/**
 * Plan 04-04 audit-fix FIX C (SEC HIGH input validation).
 *
 * The class-validator decorators on CreateLibraryDto / UpdateLibraryDto
 * are the controller-side gate. These tests run the decorators directly
 * via `validate()` so we know the right errors fire BEFORE any service
 * call.
 */
describe("CreateLibraryDto — FIX C input validation", () => {
  function makeDto(overrides: Partial<CreateLibraryDto> = {}): CreateLibraryDto {
    return plainToInstance(CreateLibraryDto, {
      type: LibraryType.GOV,
      name: "Karmana kutubxonasi",
      regionId: "tuman1",
      ...overrides,
    });
  }

  it("accepts a normal Cyrillic library name", async () => {
    const dto = makeDto({ name: "Карманинский кутубхона" });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts a normal Latin name with hyphens and digits", async () => {
    const dto = makeDto({ name: "8-maktab kutubxonasi" });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects name with newline character", async () => {
    const dto = makeDto({ name: "Lib\nFREE MONEY" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const nameErrors = errors.find((e) => e.property === "name");
    expect(nameErrors).toBeDefined();
  });

  it("rejects name with CR character", async () => {
    const dto = makeDto({ name: "Lib\rEvil" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects name containing https://", async () => {
    const dto = makeDto({ name: "Click https://evil.uz" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects name containing bit.ly", async () => {
    const dto = makeDto({ name: "Visit bit.ly/abc" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects name containing t.me telegram link", async () => {
    const dto = makeDto({ name: "Telegram t.me/sifat" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects name containing wa.me whatsapp link", async () => {
    const dto = makeDto({ name: "WhatsApp wa.me/998901" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects name longer than 120 chars", async () => {
    const dto = makeDto({ name: "A".repeat(121) });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects name shorter than 2 chars", async () => {
    const dto = makeDto({ name: "A" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects name with random symbols (e.g. <, >, /)", async () => {
    const dto = makeDto({ name: "<script>alert(1)</script>" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts name with apostrophe and ampersand (legitimate uses)", async () => {
    const dto = makeDto({ name: "Test & Co's Library" });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

describe("UpdateLibraryDto — FIX C input validation (optional name)", () => {
  it("accepts undefined name (partial update of other fields)", async () => {
    const dto = plainToInstance(UpdateLibraryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects malicious name on update", async () => {
    const dto = plainToInstance(UpdateLibraryDto, {
      name: "Eat https://bad.uz",
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a clean name on update", async () => {
    const dto = plainToInstance(UpdateLibraryDto, {
      name: "Yangi nom",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

describe("isLibraryNameSafe — pure helper", () => {
  it("returns true for clean names", () => {
    expect(isLibraryNameSafe("Karmana 8-maktab")).toBe(true);
    expect(isLibraryNameSafe("Карманинский")).toBe(true);
  });

  it("returns false for newline / CR", () => {
    expect(isLibraryNameSafe("X\ny")).toBe(false);
    expect(isLibraryNameSafe("X\ry")).toBe(false);
  });

  it("returns false for URL fragments", () => {
    expect(isLibraryNameSafe("see https://evil")).toBe(false);
    expect(isLibraryNameSafe("bit.ly/x in name")).toBe(false);
    expect(isLibraryNameSafe("t.me/y inside")).toBe(false);
    expect(isLibraryNameSafe("wa.me/z embedded")).toBe(false);
  });

  it("returns false for length out of bounds", () => {
    expect(isLibraryNameSafe("")).toBe(false);
    expect(isLibraryNameSafe("A")).toBe(false);
    expect(isLibraryNameSafe("A".repeat(121))).toBe(false);
  });
});
