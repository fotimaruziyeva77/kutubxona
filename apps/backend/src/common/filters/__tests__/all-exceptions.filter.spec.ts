import { HttpException, HttpStatus, ArgumentsHost } from "@nestjs/common";
import { AllExceptionsFilter } from "../all-exceptions.filter";
import { Prisma } from "@prisma/client";

/** Mock ArgumentsHost yaratuvchi yordamchi */
function makeHost(method = "GET", url = "/api/v1/test") {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return {
    host: {
      switchToHttp: () => ({
        getRequest:  () => ({ method, url }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost,
    status,
    json,
  };
}

describe("AllExceptionsFilter", () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jest.clearAllMocks();
  });

  // ── HttpException ──────────────────────────────────────────────────────────
  describe("HttpException", () => {
    it("404 NotFoundException to'g'ri formatda qaytaradi", () => {
      const { host, status, json } = makeHost();
      const exception = new HttpException("Topilmadi", HttpStatus.NOT_FOUND);

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 404,
          message:    "Topilmadi",
          timestamp:  expect.any(String),
          path:       "/api/v1/test",
        })
      );
    });

    it("400 BadRequestException array message bilan", () => {
      const { host, status, json } = makeHost();
      const exception = new HttpException(
        { message: ["Ism kiritilishi shart", "Familiya kiritilishi shart"], error: "Bad Request" },
        HttpStatus.BAD_REQUEST
      );

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          message:    ["Ism kiritilishi shart", "Familiya kiritilishi shart"],
          error:      "Bad Request",
        })
      );
    });

    it("401 UnauthorizedException", () => {
      const { host, status } = makeHost();
      const exception = new HttpException("Token yaroqsiz", HttpStatus.UNAUTHORIZED);

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(401);
    });

    it("409 ConflictException", () => {
      const { host, status } = makeHost();
      const exception = new HttpException("Allaqachon mavjud", HttpStatus.CONFLICT);

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(409);
    });
  });

  // ── Prisma xatoliklar ──────────────────────────────────────────────────────
  describe("PrismaClientKnownRequestError", () => {
    const makePrismaError = (code: string) => {
      const err = new Prisma.PrismaClientKnownRequestError("DB error", {
        code,
        clientVersion: "5.0.0",
      });
      return err;
    };

    it("P2002 (unique) — 409 Conflict", () => {
      const { host, status, json } = makeHost();
      filter.catch(makePrismaError("P2002"), host);

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 409,
          error:      "Duplicate Entry",
          message:    expect.stringContaining("allaqachon mavjud"),
        })
      );
    });

    it("P2025 (not found) — 404 Not Found", () => {
      const { host, status, json } = makeHost();
      filter.catch(makePrismaError("P2025"), host);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 404,
          error:      "Not Found",
        })
      );
    });

    it("P2003 (foreign key) — 409 Conflict", () => {
      const { host, status, json } = makeHost();
      filter.catch(makePrismaError("P2003"), host);

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Foreign Key Violation",
        })
      );
    });

    it("boshqa Prisma kodi — 409 + Database Error", () => {
      const { host, status, json } = makeHost();
      filter.catch(makePrismaError("P9999"), host);

      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Database Error",
        })
      );
    });
  });

  // ── PrismaClientValidationError ────────────────────────────────────────────
  describe("PrismaClientValidationError", () => {
    it("400 validatsiya xatosi", () => {
      const { host, status, json } = makeHost();
      const err = new Prisma.PrismaClientValidationError("Validation failed", {
        clientVersion: "5.0.0",
      });

      filter.catch(err, host);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Validation Error",
        })
      );
    });
  });

  // ── Kutilmagan xatoliklar ──────────────────────────────────────────────────
  describe("Unknown errors", () => {
    it("oddiy Error — 500 Internal Server Error", () => {
      const { host, status, json } = makeHost("POST", "/api/v1/books");
      const err = new Error("Kutilmagan xato");

      filter.catch(err, host);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          error:      "Internal Server Error",
          path:       "/api/v1/books",
        })
      );
    });

    it("null exception — 500 xatolik", () => {
      const { host, status } = makeHost();
      filter.catch(null, host);
      expect(status).toHaveBeenCalledWith(500);
    });

    it("string exception — 500 xatolik", () => {
      const { host, status } = makeHost();
      filter.catch("string error", host);
      expect(status).toHaveBeenCalledWith(500);
    });
  });

  // ── Javob formati ──────────────────────────────────────────────────────────
  describe("Javob formati", () => {
    it("timestamp ISO format bo'ladi", () => {
      const { host, json } = makeHost();
      filter.catch(new HttpException("Xato", 400), host);

      const call = json.mock.calls[0][0];
      expect(new Date(call.timestamp).toISOString()).toBe(call.timestamp);
    });

    it("path URL ni to'g'ri saqlaydi", () => {
      const { host, json } = makeHost("DELETE", "/api/v1/libraries/lib-1");
      filter.catch(new HttpException("Forbidden", 403), host);

      const call = json.mock.calls[0][0];
      expect(call.path).toBe("/api/v1/libraries/lib-1");
    });
  });
});
