# Obtion hub with its web app: sync, API, MCP and the app in one container.
# Data live in the volume /data (database, files, Markdown mirror, MCP token).
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit optional && rm -rf /root/.bun/install/cache
COPY src ./src
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV HOST=0.0.0.0 PORT=8480 OBTION_DATA=/data
VOLUME /data
EXPOSE 8480
CMD ["bun", "src/server/index.ts"]
