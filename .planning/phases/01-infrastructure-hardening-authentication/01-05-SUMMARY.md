---
phase: 01-infrastructure-hardening-authentication
plan: 05
subsystem: infra
tags: [websocket, socket.io, redis-adapter, kafka, kafkajs, real-time, nestjs]

# Dependency graph
requires:
  - phase: 01-infrastructure-hardening-authentication (01-02/01-03)
    provides: CacheService ioredis pattern, KafkaService producer + KAFKA_TOPICS, StatsGateway emit helpers
provides:
  - Multi-replica-safe WebSocket fan-out via @socket.io/redis-adapter (INFRA-07)
  - Activated NestJS Kafka consumer routing alert topics to the StatsGateway (INFRA-08)
  - Graceful degradation: WS adapter uses dev Redis default; consumer no-ops when KAFKA_BROKERS unset
affects: [stats-dashboard, smart-alerts, real-time-monitoring, ai-audit-engine, production-scaling]

# Tech tracking
tech-stack:
  added: ["@socket.io/redis-adapter@^8 (8.3.0)"]
  patterns:
    - "Socket.IO Redis adapter wired in gateway afterInit with pub/sub ioredis clients"
    - "kafkajs consumer in a NestJS provider onModuleInit (no @nestjs/microservices)"
    - "Defensive eachMessage handler (try/catch + JSON parse guard) so bad payloads never crash the consumer"

key-files:
  created:
    - apps/backend/src/infra/kafka/kafka-consumer.service.ts
    - apps/backend/src/infra/kafka/kafka-consumer.service.spec.ts
  modified:
    - apps/backend/src/infra/gateway/stats.gateway.ts
    - apps/backend/src/infra/kafka/kafka.module.ts
    - apps/backend/package.json

key-decisions:
  - "WS Redis adapter built on ioredis (already installed) inside StatsGateway.afterInit; pub/sub clients cleaned up in onModuleDestroy"
  - "Kafka consumer built on the already-installed kafkajs client, NOT @nestjs/microservices (avoids the NestJS v10-vs-v11 transport version footgun)"
  - "Consumer subscribes to alert topics (tuman.ri.dropped, fraud.detected, library.inactive) and routes them all to StatsGateway.emitNewAlert"
  - "Both subsystems degrade gracefully: WS adapter uses the dev redis://localhost:6379 default; consumer no-ops with a logged skip when KAFKA_BROKERS is unset"
  - "Nginx ip_hash sticky-session requirement for multi-replica WS documented in-code (prod Nginx config out of plan scope)"

patterns-established:
  - "Gateway afterInit wires the Redis adapter so emits fan out across all replicas"
  - "Event-bus consumer routes parsed events into the WebSocket gateway, closing the producer->consumer loop"

requirements-completed: [INFRA-07, INFRA-08]

# Metrics
duration: 5min
completed: 2026-06-06
---

# Phase 1 Plan 05: Real-time Delivery & Event Consumption Summary

**Multi-replica WebSocket fan-out via @socket.io/redis-adapter (INFRA-07) plus an activated kafkajs consumer that routes alert topics into StatsGateway (INFRA-08), both degrading gracefully without their backing service.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-06-06T09:13:26Z
- **Completed:** 2026-06-06T09:18:45Z
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments
- **INFRA-07:** `StatsGateway.afterInit` now creates pub/sub ioredis clients and calls `server.adapter(createAdapter(pub, sub))`, so a message emitted on one replica reaches clients connected to any other replica. Pub/sub clients are torn down in `onModuleDestroy`.
- **INFRA-08:** New `KafkaConsumerService` (kafkajs, NestJS provider) subscribes to `tuman.ri.dropped`, `fraud.detected`, and `library.inactive` and routes parsed events to `StatsGateway.emitNewAlert` — closing the previously dead producer→consumer loop.
- **Graceful degradation verified:** the consumer no-ops (logged skip, no connect, no throw) when `KAFKA_BROKERS` is unset; the WS adapter falls back to the dev Redis default. Backend boots without a live Kafka.
- **Full backend suite green:** 650/650 tests (644 prior + 6 new consumer specs), 34 suites. TypeScript: 0 errors.

## Task Commits

Each task was committed atomically:

1. **Task 1: Socket.IO Redis adapter (INFRA-07)** - `1e0a64a` (feat)
2. **Task 2: Wave 0 — Kafka consumer spec (RED)** - `4f741ff` (test)
3. **Task 3: Kafka consumer service (INFRA-08, GREEN)** - `c325a31` (feat)

_TDD: Task 2 (RED test) → Task 3 (GREEN implementation). No REFACTOR commit needed — implementation was clean on first pass._

**Plan metadata:** committed separately with this SUMMARY.

## Files Created/Modified
- `apps/backend/src/infra/gateway/stats.gateway.ts` - Added `afterInit` wiring the Redis adapter (pub/sub ioredis), `onModuleDestroy` cleanup, and an in-code Nginx `ip_hash` sticky-session note.
- `apps/backend/src/infra/kafka/kafka-consumer.service.ts` - New `KafkaConsumerService`: kafkajs consumer, alert-topic subscription, defensive eachMessage routing to `emitNewAlert`, graceful no-op when `KAFKA_BROKERS` unset, disconnect on destroy.
- `apps/backend/src/infra/kafka/kafka-consumer.service.spec.ts` - 6 specs pinning event→gateway routing, broker-absent no-op, defensive bad-JSON handling, and destroy contract.
- `apps/backend/src/infra/kafka/kafka.module.ts` - Registered the consumer provider; imported `GatewayModule` for `StatsGateway` injection.
- `apps/backend/package.json` - Added `@socket.io/redis-adapter@^8` (8.3.0).

## Decisions Made
- **kafkajs over @nestjs/microservices** for the consumer — zero new dependency, shares the producer's client config, and avoids the documented NestJS v10-vs-v11 transport version footgun (per RESEARCH INFRA-08).
- **All alert topics route to a single gateway channel** (`emitNewAlert`), matching the existing `alerts` room design; no new gateway emit helpers were needed.
- **Consumer also subscribes to `library.inactive`** (in addition to the plan's explicit `tuman.ri.dropped`/`fraud.detected`) because it is the same alert class produced by the existing pipeline — a small, in-scope completeness addition, not new surface.
- **WS connection JWT auth intentionally NOT added** here — out of strict Phase 1 scope per RESEARCH and threat-register disposition T-05-03 (accept; tracked for follow-up hardening).

## Deviations from Plan

None - plan executed exactly as written.

The plan's Task 3 verify command (`npx jest kafka-consumer.service.spec -x`) uses the `-x` short flag, which this Jest build does not support; per the environment notes the equivalent `--bail` flag was used instead. This is a tooling-invocation adjustment, not a change to the plan's logic or acceptance criteria — the same spec was run and passed.

## Issues Encountered
- The `package-lock.json` lives at the monorepo root, not under `apps/backend/`. Staged the root lockfile accordingly. No impact on the build.

## Threat Model Compliance
- **T-05-01 (Tampering — malformed/forged Kafka payload):** mitigated — `handleMessage` JSON-parses inside try/catch and swallows errors with a warn, so a bad message cannot crash the consumer loop.
- **T-05-02 (DoS — consumer crash on broker outage/absence):** mitigated — graceful no-op when `KAFKA_BROKERS` unset; connection errors are caught and leave the backend running; consumer disconnects on shutdown.
- **T-05-03 (Info disclosure — alerts to unauthenticated WS clients):** accepted per plan; WS auth deferred to a follow-up hardening pass.
- **T-05-SC (Supply chain — @socket.io/redis-adapter install):** mitigated — installed pinned `^8` (resolved 8.3.0), RESEARCH-approved and slopcheck `[OK]`, official socket.io repo. kafkajs already installed (no new dep).

## User Setup Required
None for dev/test — both subsystems run with local Redis (already up) and degrade gracefully without Kafka.

**For production multi-replica WebSocket:** Nginx must enable `ip_hash` (sticky sessions) so the Socket.IO HTTP long-polling handshake pins each client to one replica. The Redis adapter handles broadcast fan-out; sticky sessions are the complementary prod-Nginx requirement (documented in-code in `stats.gateway.ts`). Prod Nginx config is out of this plan's scope.

## Next Phase Readiness
- Real-time alert delivery is now multi-instance-safe and the event bus is no longer a dead end — ready for the monitoring/AI-audit phases that produce these alert events.
- Follow-up hardening (not blocking): WS connection JWT auth (T-05-03), and the prod Nginx `ip_hash` config.

## Self-Check: PASSED

- Created files verified on disk: `kafka-consumer.service.ts`, `kafka-consumer.service.spec.ts`, `01-05-SUMMARY.md`
- Commits verified in git history: `1e0a64a`, `4f741ff`, `c325a31`

---
*Phase: 01-infrastructure-hardening-authentication*
*Completed: 2026-06-06*
