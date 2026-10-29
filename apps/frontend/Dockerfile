# ── Build konteksti: REPO ILDIZI (npm workspaces — lockfile faqat root'da) ────
#   docker build -f apps/frontend/Dockerfile .
#   CI/deploy: `context: .` + `file: apps/frontend/Dockerfile`
# D6 (PILOT-REJA-2026-10): avval context apps/frontend edi — u yerda
# package-lock.json yo'q, `npm ci` darhol yiqilardi. Standalone chiqish
# next.config.js `experimental.outputFileTracingRoot` = repo ildizi bo'lgani
# uchun /app/apps/frontend/server.js + hoisted /app/node_modules shaklida.

# ── Stage 1: Dependencies ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps

RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --workspace=apps/frontend

# ── Stage 2: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Telemetry o'chirish
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/frontend/ apps/frontend/

WORKDIR /app/apps/frontend
RUN npm run build

# ── Stage 3: Runner (minimal) ─────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache dumb-init

# Xavfsizlik: root bo'lmagan foydalanuvchi
RUN addgroup -g 1001 -S sifat && \
    adduser  -u 1001 -S sifat -G sifat

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next.js standalone output (monorepo tuzilmasi saqlanadi)
COPY --from=builder --chown=sifat:sifat /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=sifat:sifat /app/apps/frontend/.next/static     ./apps/frontend/.next/static
COPY --from=builder --chown=sifat:sifat /app/apps/frontend/public           ./apps/frontend/public

USER sifat

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/frontend/server.js"]
