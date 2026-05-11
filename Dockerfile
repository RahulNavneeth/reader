######################
# Stage 1 — install
######################
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm install

######################
# Stage 2 — build web
######################
FROM deps AS build-web
COPY apps/web ./apps/web
RUN npm -w @reader/web run build

######################
# Stage 3 — build server
######################
FROM deps AS build-server
COPY apps/server ./apps/server
RUN npm -w @reader/server run build

######################
# Stage 4 — runner
######################
FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Re-install only production deps for the server workspace.
COPY package.json package-lock.json* ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm install --omit=dev --ignore-scripts \
  && npm -w @reader/server install --omit=dev --ignore-scripts

# Server build output
COPY --from=build-server /app/apps/server/dist ./apps/server/dist

# Web build output (Vite emits to apps/web/dist)
COPY --from=build-web /app/apps/web/dist ./apps/web/dist

# Default to local-FS storage rooted at /data; mount a volume here.
ENV DATA_DIR=/data \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=3001 \
    WEB_DIR=/app/apps/web/dist \
    STORAGE=local

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

CMD ["node", "apps/server/dist/index.js"]
