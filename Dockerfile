# Obtion server with its web app: sync, API, MCP and the app in one container.
# Data live in /data (database, daily backups, files, Markdown mirror, MCP token).
# Built for amd64 and arm64: the web app and the server's dependencies are plain JavaScript, so
# both are made on the build platform; the last stage only copies (no emulation needed).
FROM --platform=$BUILDPLATFORM oven/bun:1.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM --platform=$BUILDPLATFORM oven/bun:1.3-slim AS server
WORKDIR /app
# the workspace's manifests, then only what the server needs at runtime
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/sync/package.json packages/sync/
COPY packages/ui/package.json packages/ui/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production --omit optional --filter @obtion/server
COPY packages/core ./packages/core
COPY apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
# COPY keeps the modes of the checkout; cloned with a strict umask the server's user could not
# read its own code ("Module not found")
RUN chmod -R a+rX /app && mkdir /data

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=server /app ./
COPY --from=server --chown=bun:bun /data /data
ENV HOST=0.0.0.0 PORT=8480 OBTION_DATA=/data
VOLUME /data
EXPOSE 8480
# never as root; docker compose runs it as the owner of the data folder (OBTION_UID/OBTION_GID)
USER bun
CMD ["bun", "apps/server/src/index.ts"]
