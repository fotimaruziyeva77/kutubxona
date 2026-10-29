import { KafkaAuditConsumer } from "../kafka-audit.consumer";
import { KAFKA_TOPICS } from "../../../infra/kafka/kafka.service";

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockCreate = jest.fn().mockResolvedValue({
  id: "log-1",
  scope: "USER",
  scopeId: "user-1",
  issueType: "FRAUD_DETECTED",
  severity: "CRITICAL",
  analysis: "test",
  recommendation: "test",
  createdAt: new Date(),
});

const mockPrisma = {
  aiAuditLog: { create: mockCreate },
} as any;

const mockAuditService = {
  triggerRootCauseForTuman: jest.fn(),
} as any;

const mockPredictService = {
  analyzeRootCause: jest.fn().mockResolvedValue({
    scopeId: "tuman-1",
    scopeType: "TUMAN",
    issue: "RI_DROP",
    causes: [
      {
        factor: "LIBRARY_INACTIVE",
        description: "2 ta kutubxona faolsiz",
        impact: "HIGH",
        evidence: "test",
        recommendation: "Tekshiring",
      },
    ],
    summary: "Asosiy sabab: 2 ta kutubxona faolsiz",
    generatedAt: new Date().toISOString(),
  }),
} as any;

const mockGateway = {
  emitNewAlert: jest.fn(),
} as any;

const mockAlertDispatch = {
  dispatch: jest.fn(),
} as any;

const mockConfigGet = jest.fn();
const mockConfig = {
  get: mockConfigGet,
} as any;

function createConsumer() {
  return new KafkaAuditConsumer(
    mockConfig,
    mockPrisma,
    mockAuditService,
    mockPredictService,
    mockGateway,
    mockAlertDispatch,
  );
}

describe("KafkaAuditConsumer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should no-op onModuleInit when KAFKA_BROKERS is undefined (graceful degradation)", async () => {
    mockConfigGet.mockReturnValue(undefined);
    const consumer = createConsumer();
    await consumer.onModuleInit();
    // Should not throw and should not connect
    expect(consumer["connected"]).toBe(false);
  });

  it("should create AiAuditLog with scope=USER and severity CRITICAL for FRAUD_DETECTED", async () => {
    const consumer = createConsumer();
    await consumer.processAuditEvent(KAFKA_TOPICS.FRAUD_DETECTED, {
      userId: "user-fraud-1",
      riskScore: 85,
      flags: ["rapid_read", "multi_account"],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.data.scope).toBe("USER");
    expect(createArg.data.scopeId).toBe("user-fraud-1");
    expect(createArg.data.issueType).toBe("FRAUD_DETECTED");
    expect(createArg.data.severity).toBe("CRITICAL");
    expect(createArg.data.analysis).toContain("riskScore=85");
    expect(mockGateway.emitNewAlert).toHaveBeenCalledTimes(1);
  });

  it("should call predictService.analyzeRootCauses for TUMAN_RI_DROPPED (AI-03)", async () => {
    const consumer = createConsumer();
    await consumer.processAuditEvent(KAFKA_TOPICS.TUMAN_RI_DROPPED, {
      tumanId: "tuman-test-1",
      dropPercent: 15.5,
      currentAvg: 52.3,
      previousAvg: 61.9,
    });

    expect(mockPredictService.analyzeRootCause).toHaveBeenCalledWith(
      "tuman-test-1",
      "RI_DROP",
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.data.scope).toBe("TUMAN");
    expect(createArg.data.scopeId).toBe("tuman-test-1");
    expect(createArg.data.issueType).toBe("RI_DROPPED");
    expect(createArg.data.analysis).toContain("Sabab tahlili");
  });

  it("should create RAPID_BORROW AiAuditLog when >5 borrows in 1 min window", async () => {
    const consumer = createConsumer();

    // Simulate 6 rapid borrows from the same user
    for (let i = 0; i < 6; i++) {
      await consumer.processAuditEvent(KAFKA_TOPICS.BOOK_BORROWED, {
        userId: "rapid-user-1",
        bookId: `book-${i}`,
        libraryId: "lib-1",
      });
    }

    // Should have created an audit log on the 6th borrow (>5 threshold)
    const rapidCalls = mockCreate.mock.calls.filter(
      (call: any) => call[0].data.issueType === "RAPID_BORROW",
    );
    expect(rapidCalls.length).toBe(1);
    expect(rapidCalls[0][0].data.scopeId).toBe("rapid-user-1");
    expect(rapidCalls[0][0].data.severity).toBe("MEDIUM");
  });

  it("should not create AiAuditLog for unknown/unhandled topics", async () => {
    const consumer = createConsumer();
    await consumer.processAuditEvent(KAFKA_TOPICS.BOOK_RESERVED, {
      userId: "user-1",
      bookId: "book-1",
    });
    await consumer.processAuditEvent(KAFKA_TOPICS.READING_PROGRESS, {
      userId: "user-1",
      isbn: "123",
      pagesRead: 50,
    });
    await consumer.processAuditEvent(KAFKA_TOPICS.ISBN_SCANNED, {
      userId: "user-1",
      isbn: "456",
    });

    expect(mockCreate).not.toHaveBeenCalled();
  });
});
