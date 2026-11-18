# Obtion

Notes that link to each other and projects with tasks, in one app. Self-hosted, works in the browser on every device (also offline) and through AI agents via MCP. German and English.

## Installation

With Docker, you only need [`docker-compose.yaml`](docker-compose.yaml):

```bash
mkdir obtion && cd obtion
# put docker-compose.yaml here
docker compose up -d
```

Open `http://<host>:8480` and create the first account. Optional settings go into `.env` (see [`.env.example`](.env.example)). All data lives in `./data`; back it up while the server is stopped. An item deleted for good stays in older backups, and restoring one brings it back.

Update: `docker compose pull && docker compose up -d`

## Signing in

`OBTION_LOGIN` in `.env` lists the ways, default `password,passkey` (details in [`.env.example`](.env.example)):

| Way                | In `OBTION_LOGIN` | Needs                                                                                  |
| ------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| Email and password | `password`        | –                                                                                      |
| Code by email      | `code`            | `OBTION_SMTP_URL` (or `log`: the codes go to the server log)                           |
| Passkeys           | `passkey`         | `OBTION_PUBLIC_URL` with `https://`; add one in Settings → Account                     |
| OAuth              | –                 | `OBTION_PUBLIC_URL` and an OpenID Connect provider (`OBTION_OIDC_*`), GitHub or Google |

E.g. `OBTION_LOGIN=code,passkey`: no passwords. Before turning codes on for accounts made with passwords, read what their first code does in [`.env.example`](.env.example).

## Release channels

Choose with `OBTION_VERSION` in `.env`:

| Tag       |                                          |
| --------- | ---------------------------------------- |
| `latest`  | stable releases (default)                |
| `nightly` | newest changes, at most every six hours  |
| `dev`     | every commit to `main`, for testing only |

Or pin a version, e.g. `0.0.2`. Going back after an update may need a backup of `./data`.

Without the web app (sync, API and MCP only): `OBTION_WEB_APP=off`. Apps on another origin call the server only if it lets them: the desktop app always, others when `OBTION_APP_ORIGINS` names their origin. They sign in with a password or a code by email; passkeys and OAuth stay on the server's own page, and so does signing up with an invite where the server confirms addresses by code.

## Development

With [Bun](https://bun.sh):

```bash
bun install
bun run dev         # server on :8480 and the web app with hot reload
bun test            # unit and integration tests
bun run test:browser  # parts of the interface on their own, in Chromium
bun run test:e2e    # the built app against real servers
bun run typecheck
bun run lint        # Biome: format, lint rules, sorted imports (read-only)
bun run fix         # Biome: apply the safe fixes and format
bun run check       # everything CI runs for a pull request, side by side
```

A pull request is ready to merge when `bun run check` passes: Biome counts warnings as failures too. The rules are in [`biome.jsonc`](biome.jsonc); for VS Code the repository recommends the Biome extension and formats on save.

The browser tests need Chromium once: `bunx playwright install chromium`.

More in [`docs`](docs): [CI](docs/ci.md), [file API](docs/files-api.md), [releasing](docs/releasing.md), [background dev servers](scripts/README.md).

## License

[AGPL-3.0-or-later](LICENSE)
