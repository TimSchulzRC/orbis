# Obtion

Notes that link to each other and projects with tasks, in one app. It runs on your own server (for example a NAS), works in the browser on every device, also offline, and can be used through an AI agent. German and English.

## Running it

GitHub Actions builds the image `ghcr.io/timschulzrc/obtion` (amd64 and arm64) from every push to `main`. On the server you need only [`docker-compose.yaml`](docker-compose.yaml), not the repository:

```bash
mkdir obtion && cd obtion
# copy docker-compose.yaml here (and .env.example as .env, if needed)
docker compose up -d
```

Open `http://<address of the machine>:8480` and create the first account. Optional settings go into `.env` (see `.env.example`).

Update with `docker compose pull && docker compose up -d`. Everything lives in the `data` folder; back that up.

While the package on GitHub is private, the server has to log in once: `docker login ghcr.io -u <GitHub user>` with a [personal access token (classic)](https://github.com/settings/tokens/new?scopes=read:packages) that has only the `read:packages` scope as the password.

`latest` is always the newest `main`; every build also keeps a tag `sha-<commit>` to go back to (`OBTION_VERSION` in `.env`). To build the image yourself: `docker build -t ghcr.io/timschulzrc/obtion .`

## Connecting an agent

A workspace's settings show a ready-made MCP command under **Connect an agent**.

## Removing unused files

The server never removes file contents by itself. To see which ones no item points to any more (not even one in the trash or in a file's history), stop the server and run:

```bash
bun apps/server/src/cli.ts gc            # lists them, removes nothing
bun apps/server/src/cli.ts gc --force    # removes them
```

With Docker: `docker compose stop`, then `docker compose run --rm obtion bun apps/server/src/cli.ts gc` (with `--force` to remove), then `docker compose start`.

With several workspaces, name one with `--workspace <id>`. A database copy in `backups` older than the run may point to removed files; restored, it shows them as missing.

## Development

With [Bun](https://bun.sh):

```bash
bun install
bun run dev         # server on :8480 and the web app with hot reload
bun test            # unit and integration tests
bun run typecheck
bun run build       # the web app into apps/web/dist
```

The server's command line (setup, imports, `gc`, stats) is `bun apps/server/src/cli.ts`; run it without arguments for its usage. For development servers that keep running in the background, one per worktree, see [`scripts/README.md`](scripts/README.md).

## License

[AGPL-3.0-or-later](LICENSE)
