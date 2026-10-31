# Obtion

Notes that link to each other and projects with tasks, in one app. Self-hosted, works in the browser on every device (also offline) and through AI agents via MCP. German and English.

## Installation

With Docker, you only need [`docker-compose.yaml`](docker-compose.yaml):

```bash
mkdir obtion && cd obtion
# put docker-compose.yaml here
docker compose up -d
```

Open `http://<host>:8480` and create the first account. Optional settings go into `.env` (see [`.env.example`](.env.example)). All data lives in `./data`; back it up.

Update: `docker compose pull && docker compose up -d`

## Release channels

Choose with `OBTION_VERSION` in `.env`:

| Tag | |
|---|---|
| `latest` | stable releases (default) |
| `nightly` | newest changes, at most every six hours |
| `dev` | every commit to `main`, for testing only |

Or pin a version, e.g. `0.0.2`. Going back after an update may need a backup of `./data`.

## Development

With [Bun](https://bun.sh):

```bash
bun install
bun run dev         # server on :8480 and the web app with hot reload
bun test
bun run typecheck
```

More in [`docs`](docs): [releasing](docs/releasing.md), [removing unused files](docs/removing-unused-files.md), [background dev servers](scripts/README.md).

## License

[AGPL-3.0-or-later](LICENSE)
