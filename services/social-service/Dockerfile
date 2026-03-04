# ── Build stage ──
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY proto /proto

RUN npm run build

# ── Production stage ──
FROM node:20-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache openssl && \
    addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

COPY --chown=appuser:appgroup --from=builder /app/dist ./dist
COPY --chown=appuser:appgroup --from=builder /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/package.json ./
COPY --chown=appuser:appgroup --from=builder /app/prisma ./prisma
COPY --chown=appuser:appgroup --from=builder /proto /proto

USER appuser

ENV NODE_ENV=production
EXPOSE 3000 50053

CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/main"]
