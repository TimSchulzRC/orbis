# Obtion hub with its web app: sync, API, MCP and the app in one container.
# Data live in the volume /data (database, files, Markdown mirror, MCP token).
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM oven/bun:1.3-slim
WORKDIR /app
# the workspace's manifests, then only what the hub needs at runtime
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/sync/package.json packages/sync/
COPY packages/ui/package.json packages/ui/
COPY apps/hub/package.json apps/hub/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production --omit optional --filter @obtion/hub && rm -rf /root/.bun/install/cache
COPY packages/core ./packages/core
COPY apps/hub ./apps/hub
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV HOST=0.0.0.0 PORT=8480 OBTION_DATA=/data
VOLUME /data
EXPOSE 8480
CMD ["bun", "apps/hub/src/index.ts"]
