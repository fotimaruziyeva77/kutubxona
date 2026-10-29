# SIFAT Library Monorepo

Sprint 1 uchun boshlang'ich infratuzilma skeleti.

## Tuzilma

- `apps/backend` — NestJS API skeleti (`/health`, `/api/docs`)
- `apps/frontend` — Next.js App Router skeleti
- `.github/workflows/ci.yml` — bazaviy CI (lint, typecheck, test, build)
- `docker-compose.yml` — PostgreSQL, Redis, Elasticsearch, Kafka, MinIO

## Ishga tushirish

1. Dependency o'rnatish:

```bash
npm install
```

2. Infra servislar:

```bash
docker compose up -d
```

3. Dasturlarni ishga tushirish:

```bash
npm run dev
```

Backend: `http://localhost:4000/health`  
Swagger: `http://localhost:4000/api/docs`  
Frontend: `http://localhost:3000`

## Development Mode — OTP Bypass

In development you can register and reset password without real SMS by setting:
- Backend: `DEV_OTP_BYPASS=true` in `apps/backend/.env` (default in `apps/backend/.env.local.example`)
- Frontend: `NEXT_PUBLIC_DISABLE_OTP=true` in `apps/frontend/.env.local` (default in `apps/frontend/.env.local.example`)

When the backend bypass fires, a multi-line warning banner is printed to the log at boot so you can't miss it. The seed script logs demo phone+password credentials at the end of `npx prisma db seed`.

**Production rollback** (when Eskiz credentials arrive):
1. `apps/backend/.env`: unset `DEV_OTP_BYPASS` (or set to `false`)
2. `apps/backend/.env`: set `ESKIZ_EMAIL`, `ESKIZ_PASSWORD`, `ESKIZ_FROM`
3. `apps/frontend/.env.local`: unset `NEXT_PUBLIC_DISABLE_OTP` (or set to `false`)
4. Restart both backend and frontend

Production guards:
- The backend hard-fails closed if `NODE_ENV` is not in `{development, test, dev}` (case-insensitive). Any other value — including `production`, `staging`, capitalized `Production`, or unset — runs the real OTP path.
- The frontend build refuses to compile if `NEXT_PUBLIC_DISABLE_OTP=true` with `NEXT_PHASE=phase-production-build` or `NODE_ENV=production`.
# sifat-library
