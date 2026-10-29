# Technology Stack

**Project:** SIFAT Library -- Remaining Integration Components
**Researched:** 2026-06-06
**Overall confidence:** HIGH

---

## Executive Summary

The existing NestJS 10 + Next.js 14 monorepo is well-architected with 20+ modules. The remaining work introduces a **Python AI Engine as a separate gRPC/Kafka service** for ML-heavy workloads (fraud ML model, RAG/NLP, time-series forecasting), while keeping rule-based fallbacks in NestJS. Payment integration needs idempotency hardening. The PWA offline layer needs Workbox/IndexedDB enhancement. All batch processing moves to BullMQ chunked workers.

**Key stack decision:** Use Python FastAPI + gRPC for AI because (1) fraud ML training requires scikit-learn/XGBoost, (2) RAG pipeline requires sentence-transformers + vector DB, (3) Prophet requires PyStan. Keeping this in Node.js would require ONNX conversion, which adds build complexity and loses model debugging capability. The NestJS rule-based services remain as graceful fallbacks when the AI Engine is unavailable.

---

## Recommended Stack

### Core (Already In Place -- No Changes)

| Technology | Version | Purpose | Status |
|------------|---------|---------|--------|
| NestJS | 10.x | Backend framework, modular architecture | Existing |
| Next.js | 14 (App Router) | Frontend, SSR, SEO, PWA shell | Existing |
| PostgreSQL | 15 | Primary relational database | Existing |
| Prisma | 5.x | Type-safe ORM, migrations | Existing |
| Redis | 7 | Cache, sessions, BullMQ backing store | Existing |
| Elasticsearch | 8.13.4 | Full-text book search | Existing |
| Apache Kafka | 7.6.1 (Confluent) | Event streaming for AI pipeline | Existing (producer only) |
| BullMQ | Latest | Job queues (notifications, reports, AI tasks) | Existing (partially used) |
| MinIO | Latest | S3-compatible file storage (Uzbekistan) | Existing |
| Docker Compose | Latest | Local dev orchestration (10 services) | Existing |

### AI/ML Engine (New Service)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Python | 3.11+ | AI/ML runtime | Best ML ecosystem (scikit-learn, PyTorch, Prophet) |
| FastAPI | 0.110+ | HTTP health/admin endpoints | Async, auto-docs, Python typing |
| grpcio + grpcio-tools | 1.60+ | gRPC server for sync AI calls from NestJS | Language-agnostic RPC, typed via protobuf, 5-10x faster than REST for internal calls |
| scikit-learn | 1.4+ | Fraud model training pipeline | Production-proven for tabular data, joblib serialization |
| xgboost | 2.0+ | Gradient boosting fraud classifier | Better accuracy than Random Forest on tabular fraud features |
| Prophet | 1.1+ | Time series RI forecasting | Auto-handles seasonality (summer dip, holidays), missing data |
| sentence-transformers | 2.5+ | Text embeddings for RAG | Multilingual models (mBERT/XLM-R) support Uzbek |
| Pinecone or pgvector | Latest | Vector database for semantic search | Pinecone for managed; pgvector if data locality law requires all data on UZ servers |
| openai | 1.10+ (Python SDK) | GPT-4 API for NLQ generation | Best LLM for Uzbek with prompt engineering |
| confluent-kafka | 2.3+ | Kafka consumer in Python | Official Confluent client, production-grade |
| psycopg2-binary | 2.9+ | Direct PostgreSQL read access | Training pipeline reads from read replica |
| joblib | 1.3+ | Model serialization | Standard for scikit-learn pipeline persistence |
| boto3 | 1.34+ | MinIO/S3 model artifact storage | S3-compatible API |

### NestJS Backend Additions

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| @nestjs/microservices | 10.x | Kafka consumer transport | Official NestJS package for consuming Kafka topics from AI Engine |
| @grpc/grpc-js + @grpc/proto-loader | Latest | gRPC client to call AI Engine | NestJS native gRPC client support |
| @socket.io/redis-adapter | 8.x | Horizontal WebSocket scaling | Required when running 3+ NestJS replicas in production |
| firebase-admin | 12.x | FCM push notifications (server) | Token management, topic subscriptions |

### Next.js Frontend Additions

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| @serwist/next + serwist | 9.x | Service Worker build integration + runtime | Active successor to next-pwa, built on Workbox |
| dexie | 4.x | IndexedDB wrapper | Promise-based, typed, reactive queries, sync support |
| firebase/messaging | 10.x | FCM client (browser push) | Browser push notification subscription |

### Infrastructure Additions

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| PgBouncer | 1.22+ | PostgreSQL connection pooling | 50K concurrent users will exhaust pg connections without pooling |
| PostgreSQL read replica | 15 | Read-only queries (stats, AI training) | Offload analytics from primary |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| NestJS-to-AI comm (sync) | gRPC | REST HTTP | REST JSON serialization overhead; gRPC is 5-10x faster for internal service calls with strict contracts |
| NestJS-to-AI comm (async) | Kafka | RabbitMQ | Kafka already in stack, supports replay/reprocessing, better for event sourcing |
| Vector DB | Pinecone (or pgvector) | Weaviate self-hosted | Weaviate requires ops overhead; pgvector reuses existing PostgreSQL. If UZ data locality required, use pgvector |
| Fraud ML | scikit-learn + XGBoost | ONNX Runtime in Node.js | ONNX requires offline Python training + export step anyway; keeping inference in Python simplifies debugging and model iteration |
| Time series | Prophet | ARIMA (statsmodels) | Prophet auto-handles holidays, seasonality, missing data; ARIMA requires manual parameter tuning |
| Service Worker | @serwist/next | next-pwa | next-pwa abandoned (2+ years); Serwist is official successor |
| IndexedDB | Dexie.js | Raw IndexedDB API | Raw IDB is callback-based, error-prone; Dexie adds Promises, typing, observable queries |
| Push notifications | Firebase FCM | Web Push API directly | FCM handles token lifecycle, topic subscriptions, delivery tracking across platforms |
| Multi-tenancy | App-level scoping (Prisma extensions) | PostgreSQL RLS | 9 roles with different geographic scoping rules make RLS policies very complex; app-level guards are simpler and already partially implemented |
| PDF reports | Puppeteer (existing) | PDFKit, wkhtmltopdf | Puppeteer already implemented; PDFKit cannot render HTML/CSS; wkhtmltopdf deprecated |

## Installation

### Python AI Engine

```bash
# New directory: ai-engine/
pip install fastapi uvicorn grpcio grpcio-tools protobuf
pip install scikit-learn xgboost prophet
pip install sentence-transformers pinecone-client openai
pip install confluent-kafka psycopg2-binary
pip install joblib boto3 python-dotenv pydantic
```

### NestJS Backend

```bash
cd apps/backend
npm install @nestjs/microservices @grpc/grpc-js @grpc/proto-loader
npm install @socket.io/redis-adapter
npm install firebase-admin
```

### Next.js Frontend

```bash
cd apps/frontend
npm install @serwist/next serwist dexie
npm install firebase
```

### Docker Compose Additions

```yaml
ai-engine:
  build: ./ai-engine
  container_name: sifat-ai-engine
  restart: unless-stopped
  ports:
    - "50051:50051"
    - "8000:8000"
  environment:
    DATABASE_URL: postgresql://sifat:sifat@postgres:5432/sifat
    KAFKA_BROKERS: kafka:9092
    MINIO_ENDPOINT: minio:9000
    OPENAI_API_KEY: ${OPENAI_API_KEY}
  depends_on:
    - postgres
    - kafka
    - minio

pgbouncer:
  image: edoburu/pgbouncer:1.22.0
  container_name: sifat-pgbouncer
  environment:
    DATABASE_URL: postgresql://sifat:sifat@postgres:5432/sifat
    MAX_CLIENT_CONN: 1000
    DEFAULT_POOL_SIZE: 50
  ports:
    - "6432:6432"
  depends_on:
    - postgres
```

## Sources

- [NestJS gRPC Microservices](https://docs.nestjs.com/microservices/grpc) -- HIGH confidence
- [NestJS Kafka Microservices](https://docs.nestjs.com/microservices/kafka) -- HIGH confidence
- [FastAPI gRPC Pattern](https://the-pi-guy.com/blog/building_a_microservices_architecture_with_fastapi_and_grpc/) -- MEDIUM confidence
- [Serwist (Next.js PWA)](https://serwist.pages.dev/docs/next) -- HIGH confidence
- [Dexie.js](https://dexie.org/) -- HIGH confidence
- [Socket.IO Redis Adapter](https://socket.io/docs/v4/redis-adapter/) -- HIGH confidence
- [BullMQ Batch Processing](https://docs.bullmq.io/bullmq-pro/batches) -- HIGH confidence
- [PayTechUZ Payme Integration](https://pay-tech.uz/docs/integrations/payme/) -- HIGH confidence
- [ML Model Serving with FastAPI](https://machinelearningmastery.com/train-serve-and-deploy-a-scikit-learn-model-with-fastapi/) -- HIGH confidence

---

*Stack research: 2026-06-06*
