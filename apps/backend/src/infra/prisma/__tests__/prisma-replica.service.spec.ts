/**
 * PrismaReplicaService spec (Plan 02-03 Task 1)
 *
 * Asserts the dual-PrismaClient pattern: when DATABASE_REPLICA_URL is set the
 * service constructs against that URL; when unset it falls back to DATABASE_URL
 * with a logger.warn line (matches the Kafka graceful-no-op pattern from
 * Phase 1 INFRA-08).
 */

import { Logger } from "@nestjs/common";

// PrismaClient is heavyweight at import-time (it loads the rust binary). We
// stub it so the spec runs in milliseconds and we can assert constructor args.
const constructorSpy = jest.fn();
const connectSpy = jest.fn().mockResolvedValue(undefined);
const disconnectSpy = jest.fn().mockResolvedValue(undefined);

jest.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor(opts: unknown) {
      constructorSpy(opts);
    }
    $connect = connectSpy;
    $disconnect = disconnectSpy;
  }
}));

import { PrismaReplicaService } from "../prisma-replica.service";

describe("PrismaReplicaService", () => {
  const originalReplicaUrl = process.env.DATABASE_REPLICA_URL;
  const originalDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    constructorSpy.mockClear();
    connectSpy.mockClear();
    disconnectSpy.mockClear();
  });

  afterEach(() => {
    // restore env between tests
    if (originalReplicaUrl === undefined) delete process.env.DATABASE_REPLICA_URL;
    else process.env.DATABASE_REPLICA_URL = originalReplicaUrl;

    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("constructs against DATABASE_REPLICA_URL when set", () => {
    process.env.DATABASE_REPLICA_URL = "postgresql://replica:5432/sifat";
    process.env.DATABASE_URL = "postgresql://primary:5432/sifat";

    new PrismaReplicaService();

    expect(constructorSpy).toHaveBeenCalledTimes(1);
    const opts = constructorSpy.mock.calls[0][0] as { datasources: { db: { url: string } } };
    expect(opts.datasources.db.url).toBe("postgresql://replica:5432/sifat");
  });

  it("falls back to DATABASE_URL when DATABASE_REPLICA_URL is unset and emits a warn log", () => {
    delete process.env.DATABASE_REPLICA_URL;
    process.env.DATABASE_URL = "postgresql://primary:5432/sifat";

    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    new PrismaReplicaService();

    const opts = constructorSpy.mock.calls[0][0] as { datasources: { db: { url: string } } };
    expect(opts.datasources.db.url).toBe("postgresql://primary:5432/sifat");
    const calls = warnSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstArg = String(calls[0][0]);
    expect(firstArg).toMatch(/fall(ing|back)/i);

    warnSpy.mockRestore();
  });

  it("onModuleInit calls $connect; onModuleDestroy calls $disconnect", async () => {
    process.env.DATABASE_REPLICA_URL = "postgresql://replica:5432/sifat";

    const svc = new PrismaReplicaService();
    await svc.onModuleInit();
    expect(connectSpy).toHaveBeenCalledTimes(1);

    await svc.onModuleDestroy();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});
