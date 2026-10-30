# Obtion server with its web app: sync, API, MCP and the app in one container.
# Data live in /data: accounts.db and config.json, and per workspace workspaces/<id>/ with its
# database, daily backups, files and Markdown mirror.
# Built for amd64 and arm64: the web app and the server's dependencies are plain JavaScript, so
# both are made on the build platform; the last stage only copies (no emulation needed).
# The base images are pinned to a digest: nightly and stable are built again from the commit dev
# ran, and should differ from it in nothing but the version (Dependabot proposes newer ones).
FROM --platform=$BUILDPLATFORM oven/bun:1.3@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
# the manifests first: the install stays cached until a dependency changes, not with every commit
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/sync/package.json packages/sync/
COPY packages/ui/package.json packages/ui/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM --platform=$BUILDPLATFORM oven/bun:1.3-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS server
WORKDIR /app
# the workspace's manifests, then only what the server needs at runtime
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/sync/package.json packages/sync/
COPY packages/ui/package.json packages/ui/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# COPY keeps the modes of the checkout; cloned with a strict umask the server's user could not
# read its own code ("Module not found"). The dependencies get it here, cached with the install;
# after the code only the code, so a commit doesn't rewrite all of node_modules.
RUN bun install --frozen-lockfile --production --omit optional --filter @obtion/server \
  && chmod -R a+rX /app && mkdir /data
COPY packages/core ./packages/core
COPY apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN chmod -R a+rX packages/core apps/server apps/web/dist

FROM oven/bun:1.3-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
WORKDIR /app
COPY --from=server /app ./
COPY --from=server --chown=bun:bun /data /data
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/obtion-entrypoint
ENV HOST=0.0.0.0 PORT=8480 OBTION_DATA=/data
# shown in the settings and at start: 0.0.1, 0.0.2-nightly.20261030.41 or dev, and the commit
# (set by .github/workflows/ci.yml and release.yml)
ARG OBTION_BUILD_VERSION=dev
ARG OBTION_BUILD_COMMIT=
ENV OBTION_BUILD_VERSION=$OBTION_BUILD_VERSION OBTION_BUILD_COMMIT=$OBTION_BUILD_COMMIT
VOLUME /data
EXPOSE 8480
# the server never runs as root: the entrypoint hands /data to its owner and starts it as them
ENTRYPOINT ["obtion-entrypoint"]
CMD ["bun", "apps/server/src/index.ts"]
