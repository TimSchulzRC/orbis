# Obtion server with its web app: sync, API, MCP and the app in one container.
# Data live in /data (database, daily backups, files, Markdown mirror, MCP token).
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM oven/bun:1.3-slim
WORKDIR /app
# the workspace's manifests, then only what the server needs at runtime
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/sync/package.json packages/sync/
COPY packages/ui/package.json packages/ui/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production --omit optional --filter @obtion/server && rm -rf /root/.bun/install/cache
COPY packages/core ./packages/core
COPY apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
# COPY keeps the modes of the checkout; cloned with a strict umask (common on a NAS) the
# server's user could not read its own code ("Module not found")
RUN chmod -R a+rX /app/package.json /app/packages /app/apps && mkdir -p /data && chown bun:bun /data
ENV HOST=0.0.0.0 PORT=8480 OBTION_DATA=/data
VOLUME /data
EXPOSE 8480
# never as root; docker compose runs it as the owner of the data folder (OBTION_UID/OBTION_GID)
USER bun
CMD ["bun", "apps/server/src/index.ts"]
