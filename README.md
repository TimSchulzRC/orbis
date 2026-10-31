# Obtion

Notes that link to each other and projects with tasks, in one app. It runs on your own server (for example a NAS), works in the browser on every device, also offline, and can be used through an AI agent. German and English.

## Running it

GitHub Actions builds the image `ghcr.io/timschulzrc/obtion` (amd64 and arm64). On the server you need only [`docker-compose.yaml`](docker-compose.yaml), not the repository:

```bash
mkdir obtion && cd obtion
# copy docker-compose.yaml here (and .env.example as .env, if needed)
docker compose up -d
```

Open `http://<address of the machine>:8480` and create the first account. Optional settings go into `.env` (see `.env.example`).

Update with `docker compose pull && docker compose up -d`. Everything lives in the `data` folder; back that up.

While the package on GitHub is private, the server has to log in once: `docker login ghcr.io -u <GitHub user>` with a [personal access token (classic)](https://github.com/settings/tokens/new?scopes=read:packages) that has only the `read:packages` scope as the password.

To build the image yourself: `docker build -t ghcr.io/timschulzrc/obtion .`

## Channels and versions

`OBTION_VERSION` in `.env` picks the channel. The settings page shows which version a server runs.

| Channel | Tag | New version | For |
|---|---|---|---|
| Stable | `latest`, `stable` | when a nightly is released as stable by hand | everyday use |
| Nightly | `nightly` | when `main` has changed, at most every six hours | testing with real data before it becomes stable |
| Dev | `dev` | every push to `main` | trying out the newest state, test data only |

Stable only ever ships the commit of a nightly, so everything in it ran as nightly first. Versions look like `0.0.4` (stable) and `0.0.4-nightly.20261030.1` (the nightly leading up to it, its day and number that day). The last number counts the stable releases; the middle one goes up by hand for a notable step, such as 0.1.0 for the beta. Every version stays available as a tag of its own (`OBTION_VERSION=0.0.3`), and every dev build as `sha-<commit>`.

Going back to an older version can fail once a newer one has converted the data. Back up the `data` folder before switching, or restore a backup from `data/backups`.

Releases run in the workflow [Release](.github/workflows/release.yml): nightlies on their own every half hour when due, or by hand (*Run workflow*, channel `nightly`) without waiting; stable only by hand (channel `stable`, with `version` for a new middle number).

GitHub's schedule drops most runs of the nightly check for this repository, so a machine that is always on (the one with the self-hosted runner) starts it every half hour as well, with the user timer in [`scripts/systemd`](scripts/systemd):

```bash
cp scripts/systemd/obtion-nightly-check.* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now obtion-nightly-check.timer
```

It needs `gh`, logged in with the `workflow` scope, and user lingering (`loginctl enable-linger`) to run without a login.

To update on its own, let the server run `docker compose pull && docker compose up -d` in the folder regularly, e.g. every 15 minutes (a scheduled task on a NAS, a cron job or systemd timer elsewhere); without a new image it changes nothing.

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
