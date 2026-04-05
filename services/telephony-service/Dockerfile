# ── Build stage ──
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm run build

# ── Production stage ──
FROM node:20-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache ffmpeg && \
    addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

RUN mkdir -p /app/audio-segments && chown -R appuser:appgroup /app/audio-segments

USER appuser

ENV NODE_ENV=production
EXPOSE 3009

CMD ["node", "dist/main"]
