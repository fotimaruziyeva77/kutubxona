# ── Stage 1: Dependencies ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps

RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY package*.json ./
RUN npm ci --frozen-lockfile

# ── Stage 2: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Telemetry o'chirish
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

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

# Next.js standalone output ni ko'chirish
COPY --from=builder --chown=sifat:sifat /app/.next/standalone ./
COPY --from=builder --chown=sifat:sifat /app/.next/static     ./.next/static
COPY --from=builder --chown=sifat:sifat /app/public           ./public

USER sifat

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
