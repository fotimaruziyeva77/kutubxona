# Architecture Research -- SIFAT Library

**Domain:** National Library Management and Reading Index Platform
**Researched:** 2026-06-06
**Overall Confidence:** HIGH

---

## Executive Summary

The SIFAT Library platform has a solid monorepo foundation (NestJS + Next.js) with 20+ business modules, working JWT auth, Prisma ORM over PostgreSQL, and a comprehensive UI layer. The remaining integration challenge is introducing 6 new subsystems -- Python AI Engine, payment gateways, real-time analytics pipeline, offline-first PWA, scheduled batch processing, and multi-tenant data isolation -- without breaking the existing architecture.

The recommended integration strategy uses a **hybrid communication model**: gRPC for synchronous NestJS-to-Python AI calls, Kafka for asynchronous event streaming to the AI engine audit/prediction pipelines, BullMQ for all batch processing jobs (Reading Index, reports, notifications), and HTTP webhooks for payment gateways. The existing architecture supports all of these patterns with minimal refactoring.

---

## Current Architecture Assessment

### What Works Well

1. **Module isolation** -- Each NestJS module (auth, transactions, reading, ai, payment) is self-contained with controller + service + module. Adding new integrations means wiring into existing services, not restructuring.

2. **Infrastructure layer** -- `AppInfraModule` already exports Prisma, Redis/Cache, Kafka, BullMQ, SMS, Vault, WebSocket, and PDF services. New modules can inject these immediately.

3. **Kafka producer** -- `KafkaService` is implemented with 11 typed topics, fire-and-forget with graceful degradation. Ready for Python consumers.

4. **BullMQ queues** -- Three queues already defined (`notifications`, `reports`, `ai-tasks`). `ai-tasks` queue exists but is unused -- perfect for RI batch offloading.

5. **WebSocket gateway** -- `StatsGateway` already has typed rooms (national, viloyat, tuman, alerts, top100, library). AI audit results can flow directly through this.

6. **Service Worker** -- Basic offline with 12-hour cache TTL, IndexedDB stores for `pendingTransactions`, `cachedBooks`, `cachedLibraries`, and Background Sync for transaction replay. Foundation exists.

### Critical Gaps to Address

| Gap | Current State | Required State |
|-----|---------------|----------------|
| AI Engine service | Scaffold services in NestJS (rule-based) | Separate Python FastAPI service with ML models |
| RI nightly batch | Sequential for-loop, will take hours at 5M users | BullMQ chunked parallel processing |
| Payment idempotency | Payme service handles transactionId uniqueness | Missing explicit idempotency keys and webhook deduplication |
| Token storage | localStorage (XSS vulnerable) | HttpOnly cookie for refresh token |
| OTP rate limiting | In-memory Map (lost on restart) | Redis-based rate limiting |
| Read replica | All queries hit primary | Read replica for stats/analytics queries |
| Kafka consumers | Producer only, no consumers | Python AI Engine as Kafka consumer group |

---

## 1. AI/ML Service Architecture

### Communication Pattern: gRPC + Kafka Hybrid

**Use gRPC for synchronous requests** (NLP queries, on-demand fraud checks, book recommendations) and **Kafka for asynchronous event processing** (audit pipeline, model training data ingestion, batch predictions).

**Confidence: HIGH** -- This is the standard polyglot microservice pattern documented by NestJS and FastAPI communities.

```
                   gRPC (sync, <200ms)
NestJS Backend  <=======================>  Python AI Engine (FastAPI)
    |                                           |
    |--- Kafka topics --->  [book.borrowed]     |
    |--- Kafka topics --->  [ri.updated]        |
    |--- Kafka topics --->  [fraud.detected]    |
    |                                           |
    |<-- Kafka topics ---  [audit.issue.new]    |
    |<-- Kafka topics ---  [prediction.ready]   |
```

### Python AI Engine Structure

```
ai-engine/
  app/
    main.py                  # FastAPI + gRPC server bootstrap
    grpc_server.py           # gRPC service implementations
    kafka_consumer.py        # Kafka consumer for event processing
    services/
      fraud_detector.py      # XGBoost/Random Forest inference
      nlq_service.py         # RAG pipeline (embeddings + LLM)
      predictor.py           # ARIMA/Prophet time series
      recommender.py         # Collaborative + content filtering
      audit_engine.py        # Real-time audit rule engine
    models/                  # Serialized models (.joblib)
    training/                # Training pipelines (scheduled)
  proto/
    ai.proto                 # Shared with NestJS
  Dockerfile
```

### Training vs Inference Separation

**Training** runs as scheduled jobs (weekly) on a separate process:
- Reads historical data from PostgreSQL (read replica)
- Trains models using scikit-learn (fraud) and PyTorch (NLP embeddings)
- Serializes trained models to MinIO object storage
- Emits Kafka event `model.updated` with version metadata

**Inference** is the always-running FastAPI/gRPC server:
- Loads latest model from MinIO on startup and on `model.updated` event
- Serves predictions via gRPC (synchronous) and Kafka consumers (async)
- Stateless -- can horizontally scale inference containers independently

### Graceful Degradation

The existing `AiModule` in NestJS already has rule-based fraud detection, NLQ with keyword parsing, and audit checks. These MUST remain as fallback:

```typescript
async analyzeUser(userId: string): Promise<FraudAnalysis> {
  try {
    return await this.aiClient.getService('FraudDetection').analyzeUser({ userId });
  } catch (err) {
    this.logger.warn('AI Engine unavailable, falling back to rule-based');
    return this.localFraudService.analyzeUser(userId);
  }
}
```

---

## 2. Payment Integration Architecture

### Pattern: Webhook + Idempotency Keys + Async Processing

The existing `PaymeService` and `ClickService` already implement the JSON-RPC 2.0 Payme protocol and Click prepare/complete flow. The critical missing pieces are **idempotency** and **webhook deduplication**.

**Confidence: HIGH** -- Payme service code reviewed, standard patterns apply.

### Idempotency Design

```
Payme/Click Server --POST--> /api/payment/{gateway}/webhook
                                   |
                    1. Verify signature (HMAC / Basic Auth)
                    2. Check idempotency: Redis SETNX "webhook:{transactionId}" TTL=24h
                       -- Already processed? Return cached response
                       -- New? Continue
                    3. Validate invoice (amount, status)
                    4. Prisma.$transaction():
                       - Payment.create/update
                       - Invoice.update (PAID)
                       - Subscription.update (ACTIVE)
                    5. Store response in Redis "webhook:{transactionId}"
                    6. Emit Kafka event: payment.completed
                    7. BullMQ: queue receipt email/SMS
                    8. Return JSON-RPC response
```

### Payment State Machine

```
Invoice: PENDING --> PAID --> (REFUNDED)
                \-> FAILED

Subscription: TRIAL --> PENDING --> ACTIVE --> FROZEN --> DELETED
                              \-> FROZEN (admin only, NEVER automatic)

Payment: PENDING --> PAID --> (REFUNDED)
```

Key rule from TZ: **FROZEN and DELETED status changes are NEVER automatic -- admin must manually decide with stated reason.**

---

## 3. Real-Time Data Pipeline

### Architecture: Kafka --> AI Engine --> WebSocket

```
User Action (book borrow, return, ISBN scan)
       |
       v
NestJS Service --> KafkaService.emit()
       |
       v
Apache Kafka Topic (e.g., book.borrowed)
       |
       +---> Kafka Consumer Group: ai-audit (Python)
       |         |
       |         v
       |     Python AI Engine (audit_engine.py)
       |         |-- anomaly? --> Kafka: audit.issue.new
       |                               |
       |                               v
       |                    NestJS Kafka Consumer
       |                         |
       |                    AuditService._persistAndNotify()
       |                         |
       |                    StatsGateway.emitNewAlert()
       |                         |
       |                    Admin Dashboard (WebSocket)
       |
       +---> Kafka Consumer Group: stats-aggregator
                 |
                 v
            Pre-aggregate stats to Redis (5-min TTL)
                 |
            StatsGateway pushes to rooms (30s poll)
```

### NestJS Kafka Consumer (New Component)

The existing codebase has a Kafka producer but no consumers. A new `KafkaConsumerService` is needed to receive events from the Python AI Engine (audit issues, prediction results, model updates) and route them to the appropriate NestJS services.

### Stats Aggregation Strategy

Currently, stats are computed on-demand per request. At 5M users, pre-aggregation is mandatory:

- NATIONAL: every 5 minutes via cron (Redis key: `stats:national`)
- VILOYAT: every 5 minutes per viloyat (Redis key: `stats:viloyat:{id}`)
- TUMAN: every 15 minutes per tuman (Redis key: `stats:tuman:{id}`)
- WebSocket pushes to subscribed rooms only when data changes

---

## 4. Offline-First Architecture

### Current State Assessment

The existing `sw.js` provides cache-first for static assets, network-first with 12-hour fallback for API and navigation, IndexedDB stores, and Background Sync for transaction replay. This is a solid foundation.

### Required Enhancements

```
ONLINE MODE:
  1. Service Worker serves cached shell
  2. API calls go to network, responses cached in IndexedDB
  3. Library catalog pre-cached periodically (every 6 hours)
  
OFFLINE MODE (up to 12 hours):
  1. Service Worker intercepts all requests
  2. API requests: serve from IndexedDB cache
  3. WRITE operations (borrow, return):
     a. Save to IndexedDB "pendingTransactions"
     b. Show "Offline rejimda saqlandi" banner
     c. Register Background Sync: "sync-transactions"
  4. QR scanning: Works locally (camera API is offline-capable)
  
BACK ONLINE:
  1. Background Sync fires "sync-transactions"
  2. Service Worker replays pendingTransactions
  3. Conflict resolution: server wins (timestamp comparison)
  4. IndexedDB cleared for synced items
```

### Sync Conflict Resolution

Offline borrow discovers on sync that book was already borrowed by another kutubxonachi. Resolution: server rejects with CONFLICT, Service Worker marks transaction as FAILED, UI shows "Kitob allaqachon berilgan."

### 2G Network Optimization

Detect via `navigator.connection.effectiveType`. If "2g" or "slow-2g": disable images, use minimal JSON, increase cache TTL to 24h, reduce WebSocket polling to 5 minutes.

### Background Sync Browser Limitation

Safari does not support Background Sync API. For iOS: implement manual sync button + periodic `visibilitychange` listener that triggers sync when user returns to the app.

---

## 5. Scheduled Jobs and Background Processing

### Critical Problem

`ReadingService.recalculateAll()` runs as a sequential for-loop. With 5M users at ~50ms per user, this takes ~70 hours -- far exceeding the nightly window.

### Solution: BullMQ Chunked Batch Processing

**Confidence: HIGH** -- BullMQ batch processing is well-documented and the `ai-tasks` queue already exists.

```
@Cron(EVERY_DAY_AT_MIDNIGHT)
async scheduleRiRecalculation() {
  const totalUsers = await prisma.user.count({ where: { status: 'ACTIVE' } });
  const CHUNK_SIZE = 1000;
  const totalChunks = Math.ceil(totalUsers / CHUNK_SIZE);
  
  // Dispatch chunk jobs to BullMQ
  const jobs = Array.from({ length: totalChunks }, (_, i) => ({
    name: 'ri-recalculate-chunk',
    data: { offset: i * CHUNK_SIZE, limit: CHUNK_SIZE },
    opts: { priority: 10, attempts: 3 },
  }));
  
  await this.riQueue.addBulk(jobs);
}

// Worker processes each chunk with internal parallelism of 50
```

### All Scheduled Jobs Registry

| Job | Schedule | Strategy |
|-----|----------|----------|
| RI Recalculation | 00:00 daily | BullMQ chunks of 1000, parallel 50 |
| Fraud Daily Scan | 03:00 daily | BullMQ chunks of 500 |
| Audit Cycle | Every 15 min | In-process cron (existing, fine at current scale) |
| Top-100 Monthly | 28th of month | In-process cron |
| Stats Aggregation | Every 5 min | In-process cron + Redis write |
| Trial Expiry Check | 09:00 daily | In-process cron |
| Overdue Book Alerts | 08:00 daily | BullMQ notification jobs |
| PDF Report Gen | 1st of month | BullMQ report queue |
| Model Retraining | Weekly Sunday 02:00 | Python cron (separate container) |

---

## 6. Multi-Tenant Data Isolation

### Approach: Application-Level Scoping (NOT RLS)

The codebase uses application-level scoping via RBAC guards and query filters. This is the correct approach because:

1. Not a SaaS multi-tenant app -- it is a single platform with hierarchical data access
2. 9 different roles with different geographic scoping rules make RLS policies very complex
3. Prisma ORM does not natively support RLS policy management
4. Application-level scoping via guards is already partially implemented

### Implementation: Scope Guards + Prisma Extension

Use Prisma client extensions to auto-inject WHERE filters based on the authenticated user's role and geographic scope. VILOYAT_ADMIN sees only own viloyat, TUMAN_ADMIN sees only own tuman, KUTUBXONACHI sees only own library, etc. SUPER_ADMIN bypasses all scoping.

### Data Access Matrix

| Role | Users | Libraries | Books | Transactions | Stats | Payments |
|------|-------|-----------|-------|-------------|-------|----------|
| SUPER_ADMIN | All | All | All | All | All | All |
| BUXGALTER | None | None | None | None | Financial only | All |
| VILOYAT_ADMIN | Own viloyat | Own viloyat | Own viloyat | Own viloyat | Own viloyat | None |
| TUMAN_ADMIN | Own tuman | Own tuman | Own tuman | Own tuman | Own tuman | None |
| MUASSASA_ADMIN | Own institution | Own institution | Own institution | Own institution | Own institution | Own institution |
| KUTUBXONACHI | Library users | Own library | Own library | Own library | Own library | None |
| KITOBXON | Self only | Public | Public search | Own only | Own RI | None |

---

## Component Communication Patterns Summary

| Source | Target | Pattern | Protocol | Use Case |
|--------|--------|---------|----------|----------|
| Frontend | NestJS | Request-Response | HTTP REST (axios) | All CRUD, auth |
| Frontend | NestJS | Pub-Sub | WebSocket (socket.io) | Live stats, alerts |
| NestJS | Python AI | Request-Response | gRPC | NLQ queries, on-demand fraud check |
| NestJS | Python AI | Fire-and-forget | Kafka | Event streaming for audit |
| Python AI | NestJS | Pub-Sub | Kafka | Audit issues, prediction results |
| Payme/Click | NestJS | Webhook | HTTP POST | Payment notifications |
| NestJS | Worker | Job dispatch | BullMQ (Redis) | Notifications, RI batch, reports |
| Service Worker | NestJS | Background Sync | HTTP POST | Offline transaction replay |
| NestJS | Elasticsearch | Query | HTTP | Full-text book search |
| NestJS | MinIO | File ops | S3 API | Photo/document upload |
| Python AI | MinIO | File ops | S3 API | Model artifact storage |
| Python AI | PostgreSQL | Read-only | SQL (read replica) | Training data access |

---

## Data Flow: Primary Book Borrow (Online)

```
Kutubxonachi QR scan --> Frontend --> POST /api/transactions/borrow
                                          |
                            JwtAuthGuard + RolesGuard
                                          |
                            TransactionsService.borrow()
                               |                    |
                     Prisma $transaction        KafkaService.emitBookBorrowed()
                       (status + inventory)          |
                               |               Kafka: book.borrowed
                               |                    |
                     SMS notification         AI Engine Consumer
                     (BullMQ queue)              (audit check)
                               |                    |
                     Return 201              If anomaly:
                               |               Kafka: audit.issue.new
                     React Query                    |
                     cache invalidation       NestJS Consumer
                                                    |
                                            AuditService + StatsGateway
                                                    |
                                            Admin Dashboard (WebSocket)
```

---

## Build Order Recommendations

The integration order is driven by dependencies and risk.

### Phase 1: Infrastructure Fixes (must come first)

1. Move OTP rate limiting to Redis
2. Move refresh token to HttpOnly cookie
3. Add Kafka consumer to NestJS
4. Activate BullMQ ai-tasks queue

### Phase 2: Batch Processing (unblocks RI at scale)

5. Refactor RI recalculation to BullMQ chunks
6. Refactor fraud daily scan to BullMQ chunks
7. Add read replica PostgreSQL + PgBouncer

### Phase 3: Payment Integration (revenue-critical)

8. Add idempotency to Payme/Click webhooks
9. Wrap payment operations in Prisma $transaction
10. Trial expiry and subscription lifecycle automation

### Phase 4: AI Engine (highest complexity)

11. Set up Python FastAPI service with gRPC server
12. Implement Kafka consumers in Python
13. Train and deploy fraud ML model
14. Implement RAG pipeline for NLQ
15. Implement predictive analytics

### Phase 5: Real-time and Offline

16. Stats pre-aggregation (Redis cron)
17. WebSocket Redis adapter for multi-instance
18. Enhanced Service Worker (Serwist + Dexie.js IndexedDB)
19. Firebase FCM push notifications

### Phase 6: Data Isolation and Security

20. Implement scope guards with Prisma extension
21. Security penetration testing
22. Load testing with k6 (50K concurrent)

---

## Scalability Considerations (5M Users, 50K Concurrent)

| Concern | At 10K users | At 100K users | At 5M users |
|---------|-------------|---------------|-------------|
| RI Nightly | Sequential OK (~2 min) | BullMQ chunks needed (~20 min) | BullMQ + read replica (~2 hours) |
| Fraud Scan | Sequential OK (~30 sec) | BullMQ chunks (~5 min) | BullMQ + read replica (~1 hour) |
| Stats Queries | On-demand OK | Redis cache needed | Pre-aggregated + read replica |
| WebSocket | Single server OK | Redis adapter needed | Redis adapter + sticky sessions |
| Kafka | Single partition OK | 3 partitions per topic | 6+ partitions, consumer group scaling |
| PostgreSQL | Single instance | Read replica for stats | Read replica + PgBouncer |
| AI Engine | Single container | Single container | 2-3 replicas behind load balancer |
| Search | Single ES node | Single node OK | ES cluster (3 nodes) |

---

## Anti-Patterns to Avoid

1. **Synchronous AI calls in hot paths** -- Emit Kafka event async. Use gRPC only for explicit user-initiated queries.
2. **Monolithic cron jobs** -- Cron schedules BullMQ chunk jobs. Workers process in parallel.
3. **Payment status without transaction wrapping** -- Always use `prisma.$transaction()` for payment state changes.
4. **Polling for real-time updates** -- WebSocket subscription to rooms. Server pushes only on change.
5. **Full dataset in Service Worker cache** -- Cache only the library's catalog (max ~10K books per library) and user's recent data.
6. **WebSocket without auth** -- Verify JWT in `handleConnection()`, join rooms based on user role.
7. **Storing ML models in Git** -- Store in MinIO with version tags, load at service startup.
8. **N+1 queries in batch processing** -- Use single aggregation query with JOINs, then process in memory.

---

## Sources

- [NestJS Kafka Microservices](https://docs.nestjs.com/microservices/kafka) -- HIGH confidence
- [NestJS gRPC Microservices](https://docs.nestjs.com/microservices/grpc) -- HIGH confidence
- [BullMQ Batch Processing](https://docs.bullmq.io/bullmq-pro/batches) -- HIGH confidence
- [FastAPI + gRPC Pattern](https://the-pi-guy.com/blog/building_a_microservices_architecture_with_fastapi_and_grpc/) -- MEDIUM confidence
- [ML Model Serving with FastAPI](https://machinelearningmastery.com/train-serve-and-deploy-a-scikit-learn-model-with-fastapi/) -- HIGH confidence
- [PWA Offline-First with IndexedDB](https://www.wellally.tech/blog/build-offline-first-pwa-nextjs-indexeddb) -- MEDIUM confidence
- [Socket.IO Redis Adapter](https://socket.io/docs/v4/redis-adapter/) -- HIGH confidence
- [Payme Integration](https://pay-tech.uz/docs/integrations/payme/) -- HIGH confidence
- [Multi-Tenant RLS with Prisma](https://medium.com/@francolabuschagne90/securing-multi-tenant-applications-using-row-level-security-in-postgresql-with-prisma-orm-4237f4d4bd35) -- MEDIUM confidence (evaluated and rejected)

---

*Architecture research: 2026-06-06*
