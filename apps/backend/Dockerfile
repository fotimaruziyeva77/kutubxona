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

# Paketlarni avval ko'chirish (Docker cache optimizatsiyasi)
COPY package*.json ./
RUN npm ci --frozen-lockfile

# Manba kodni ko'chirish
COPY . .

# Prisma client generatsiya
RUN npx prisma generate

# TypeScript build
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

# Faqat kerakli fayllarni ko'chirish
COPY package*.json ./
RUN npm ci --frozen-lockfile --omit=dev

# Prisma CLI runtime'da kerak (`prisma migrate deploy` deploy paytida shu
# image ichidan ishga tushiriladi — deploy-prod.yml). U devDependency bo'lib
# --omit=dev bilan o'chiriladi, shu sababli package.json'dagi AYNAN shu
# versiya global o'rnatiladi (root sifatida, /usr/local — non-root `sifat`
# foydalanuvchisi ham ishlata oladi).
RUN npm i -g prisma@$(node -p "require('./package.json').devDependencies.prisma.replace('^','')")

COPY --from=builder /app/dist                      ./dist
COPY --from=builder /app/node_modules/.prisma      ./node_modules/.prisma
# To'liq prisma/ katalogi (schema + migrations/) — `prisma migrate deploy`
# migratsiya fayllarisiz "No pending migrations" deb yolg'on muvaffaqiyat
# qaytaradi. Faqat schema.prisma ko'chirish yetarli EMAS.
COPY --from=builder /app/prisma                    ./prisma

# Fayllar egasini o'zgartirish
RUN chown -R sifat:sifat /app

USER sifat

EXPOSE 4000

# dumb-init — signal handling to'g'ri ishlashi uchun
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
