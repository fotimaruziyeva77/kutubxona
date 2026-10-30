# ── Build konteksti: REPO ILDIZI (npm workspaces — lockfile faqat root'da) ────
#   docker build -f apps/backend/Dockerfile .
#   CI/deploy: `context: .` + `file: apps/backend/Dockerfile`
# D6 (PILOT-REJA-2026-10): avval context apps/backend edi — u yerda
# package-lock.json yo'q, `npm ci` darhol yiqilardi. Endi root lockfile +
# `npm ci --workspace=apps/backend` (root `overrides` ham shu yerdan qo'llanadi).

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Puppeteer/Chromium uchun kerakli tizim paketlari
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

WORKDIR /app

# Workspace manifestlari avval (Docker cache) — faqat backend ishchi maydoni
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
RUN npm ci --workspace=apps/backend

# Manba kod
COPY apps/backend/ apps/backend/
WORKDIR /app/apps/backend

# Prisma client generatsiya (hoisted /app/node_modules/.prisma ga tushadi)
RUN npx prisma generate

# TypeScript build → apps/backend/dist
RUN npm run build

# ── Stage 2: Runner (minimal image) ──────────────────────────────────────────
FROM node:20-alpine AS runner

# Tizim paketlari (Chromium runtime + timezone DB)
# tzdata MAJBURIY: Alpine da timezone bazasi yo'q, shusiz TZ env e'tiborga olinmaydi (INFRA-05)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    dumb-init \
    tzdata

# Xavfsizlik: root bo'lmagan foydalanuvchi
RUN addgroup -g 1001 -S sifat && \
    adduser  -u 1001 -S sifat -G sifat

WORKDIR /app

ENV NODE_ENV=production
# Timezone — @nestjs/schedule cronlari Asia/Tashkent (UTC+5) bo'yicha ishlasin (INFRA-05)
ENV TZ=Asia/Tashkent
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage"

# Faqat prod bog'liqliklar (workspace)
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
RUN npm ci --workspace=apps/backend --omit=dev

# Prisma CLI runtime'da kerak (`prisma migrate deploy` deploy paytida shu
# image ichidan ishga tushiriladi — deploy-prod.yml). U devDependency bo'lib
# --omit=dev bilan o'chiriladi, shu sababli package.json'dagi AYNAN shu
# versiya global o'rnatiladi (root sifatida, /usr/local — non-root `sifat`
# foydalanuvchisi ham ishlata oladi).
RUN npm i -g prisma@$(node -p "require('./apps/backend/package.json').devDependencies.prisma.replace('^','')")

# Egalik COPY paytida beriladi: `RUN chown -R /app` butun node_modules'ni
# (773 MB) yangi qatlamga qayta yozib image'ni ~600 MB kattalashtirardi.
# node_modules root'niki bo'lib qoladi — o'qish uchun yetarli, yozish kerak emas.
COPY --from=builder --chown=sifat:sifat /app/apps/backend/dist     ./apps/backend/dist
COPY --from=builder --chown=sifat:sifat /app/node_modules/.prisma  ./node_modules/.prisma
# To'liq prisma/ katalogi (schema + migrations/) — `prisma migrate deploy`
# migratsiya fayllarisiz "No pending migrations" deb yolg'on muvaffaqiyat
# qaytaradi. Faqat schema.prisma ko'chirish yetarli EMAS.
COPY --from=builder --chown=sifat:sifat /app/apps/backend/prisma   ./apps/backend/prisma

USER sifat
WORKDIR /app/apps/backend

EXPOSE 4000

# dumb-init — signal handling to'g'ri ishlashi uchun
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
