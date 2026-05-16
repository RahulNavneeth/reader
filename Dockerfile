# syntax=docker/dockerfile:1.7
#
# Reader — single-image self-hosted build.
#
# Multi-stage:
#   1. builder — install everything, build server + web bundle, then
#      re-resolve runtime-only deps for the final layer.
#   2. runtime — copy build output + runtime deps, add system libs
#      that native bindings need (sharp / canvas / heic), drop root.
#
# We deliberately use the Debian slim base (not alpine). sharp /
# @napi-rs/canvas / @node-rs/argon2 ship glibc prebuilds; the musl
# variants of those packages have a long history of crashing or
# rendering tofu under load. The extra ~30MB is worth the stability.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Native build deps. Most of our deps have prebuilds — these cover
# the cases where they don't (notably canvas on arm64).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Workspace manifests first so dep install caches across source edits.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN npm ci --workspaces --include-workspace-root

COPY . .
RUN npm -w @reader/server run build \
    && npm -w @reader/web    run build

# Trim to runtime-only deps so the final layer doesn't carry vite,
# tsc, eslint, etc. (~hundreds of MB saved). `npm prune` with
# `--omit=dev` keeps the workspace hoisting intact (which a
# `--workspaces` install would NOT — that produces per-workspace
# node_modules instead of the root-hoisted tree node resolves
# against at runtime).
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini for proper SIGTERM forwarding (graceful shutdown).
# fontconfig + dejavu so PDF thumbnails render real text instead of
# fallback tofu. libheif/libde265 for HEIC/HEIF decode in heic-convert.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini \
      fontconfig fonts-dejavu-core \
      libheif1 libde265-0 \
    && rm -rf /var/lib/apt/lists/*

# Non-root. Admins bind-mount /data + /vault and we won't write as
# root into their NAS share. UID/GID 10001 are arbitrary but stable
# so volume permissions survive image upgrades.
RUN groupadd -r -g 10001 reader && useradd -r -u 10001 -g reader -d /app -s /sbin/nologin reader

COPY --from=builder --chown=reader:reader /app/node_modules               ./node_modules
# Workspace-nested node_modules — npm puts packages here when there's
# a version conflict with a transitive that's already hoisted to
# root (in our case nanoid: server wants v5, something pulls v3 to
# root, server's v5 lands under apps/server/node_modules/). Without
# this copy the server crashes with ERR_MODULE_NOT_FOUND on boot.
COPY --from=builder --chown=reader:reader /app/apps/server/node_modules   ./apps/server/node_modules
COPY --from=builder --chown=reader:reader /app/apps/server/dist           ./apps/server/dist
COPY --from=builder --chown=reader:reader /app/apps/web/dist              ./apps/web/dist
COPY --from=builder --chown=reader:reader /app/package.json               ./
COPY --from=builder --chown=reader:reader /app/apps/server/package.json   ./apps/server/

# Bind /data (app state) and /vault (user content) externally so a
# `docker rm` of the container doesn't lose anything. WEB_DIR lets the
# Fastify server self-serve the SPA — single port, no nginx needed.
ENV DATA_DIR=/data \
    VAULT_ROOT=/vault \
    WEB_DIR=/app/apps/web/dist \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=3001

VOLUME ["/data", "/vault"]
EXPOSE 3001

RUN mkdir -p /data /vault && chown -R reader:reader /data /vault /app
USER reader

# Native fetch in Node 22 — no curl/wget needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.SERVER_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
