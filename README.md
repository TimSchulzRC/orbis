# Obtion

A personal system that brings knowledge and work together: a linked knowledge graph like Obsidian and projects with tasks like Notion, in one app. It runs local-first on every own device, syncs through a server in the own network (tailnet only) and can largely be used through an agent (MCP and a built-in chat). German and English UI.

This README summarises the model and what the code implements.

## The model

- **Information:** title, Markdown text, tags, refs (explicit plus links from the text), at most one **type**, free properties, **"Teil von"** with any number of parents (one is the home), history. These base fields are fixed; information is not a type.
- **Overview:** not a type – any information with children. Every page shows "Darunter" (all children, grouped by type) and "Verlinkt von"; belonging comes from children, [[links]] are mentions ("Hier einordnen" places a linked item without a place).
- **Pinned:** any information can be pinned (`meta.pinned`). Pinned items form "Angeheftet" in the sidebar and count as a place; below each, all children one level deeper (done items left out). Below "Angeheftet", "Typen" lists the page of every type and the files.
- **File:** its own primitive with the same connections, no type but a file type (bild, pdf, audio, video, dokument, sonstiges). Content by SHA-256 on the server, metadata synced; previews and display versions of images on every device; per device "online only" or "everything local".
- **Inbox:** whatever its rule matches – stored in the settings, adjustable ("Was landet im Eingang?"), default `ohne:typ ohne:eltern -angeheftet | datei ohne:eltern ohne:verwendung`.
- **Type:** data, not code – properties per type (text, number, date, checkbox, URL, select, multi-select, status with groups, relation with inverse, computed) and capabilities (status, progress, updates, due date "Termin", main action, template). Capabilities are read only through `packages/core/src/traits.ts`. Every type has its page: the list of its entries with views as tabs (table, board, list, calendar, timeline, gallery), stored on the type. Karte, Projekt and Task are created at setup and are ordinary, deletable types afterwards. No code asks for a type id; the app works with zero types.
- **Queries:** stored as JSON with ids, typed in either language: `typ:Task status:offen unter:[[Relaunch]] fällig<=+7d gruppe:pfad`. Query blocks live in texts (```` ```abfrage … ``` ````). Mixed lists are pages with query blocks (with tabs too), e.g. "Eingang Arbeit" = `eingang verknüpft:unter:[[Arbeit]]`.
- **No required type:** new informations have no type by default; there is no setting for another default. In the inbox the agent only suggests a type and a place.

Rules that are easy to miss (details in the plan, Technik › Regeln):

- **Trash with cascade:** `meta.deleted` is `true` or `"via:<root>"`. What hangs only below a deleted item goes along and comes back with it; another living parent always keeps an item (`packages/core/src/trash.ts`).
- **Done date:** entering the status group done sets `meta.done`, reopening clears it; an update with a status change uses its own date. Query `erledigt>-7d`.
- **One step, one undo:** every user action and every tool call is a step (its id is on every log row it wrote). Activity › Rückgängig takes back all of it; fields changed again later keep the newer value, items it created go to the trash; undo is itself a step and can be redone (`apps/server/src/undo.ts`).
- **Areas:** every information, type, file and log row belongs to exactly one area (`meta.area`, column `area`); sync runs per area. For now there is one, the personal area, without any interface.
- **Server reset:** devices send `hello { area, since, sinceId }`; a server restored from an older backup is noticed even after another device synced first.
- **Data format:** the data carry a format version (`settings.format`, `FORMAT` in `packages/core/src/model.ts`). A newer server upgrades older data once at start (`packages/core/src/setup.ts`); an app older than the data still reads them but asks to be reloaded before it writes. `tests/fixtures/format-1.json` keeps data of format 1 that every later version must read.
- **Tolerant input:** statuses as group or option name in German or English (also synonyms), dates like 30.10.2026, 10/30/2026, morgen, type names in plural (`packages/core/src/input.ts`). Search folds ä/ö/ü/ß and hyphens.

## Architecture

- **Server** (Bun, one process): SQLite with the update log, snapshots and activity; files by SHA-256 in `blobs/` (previews via ffmpeg); a read-only Markdown mirror in `vault/` below each item's home; the index (structure, links, aggregation), search, queries, MCP and the agent runner. It serves the web app too, unless `OBTION_WEB_APP=off`.
- **Web app** (PWA): always a client of a server, which serves it. It keeps a full replica on the device (IndexedDB, files in OPFS) and syncs over the WebSocket `/sync` (Yjs updates plus an outbox for offline changes).
- **Agents**: any MCP client over HTTPS with a bearer token; the built-in chat runs a headless Claude with only these tools.

Each item is a Yjs document; scalar fields merge last-writer-wins, sets (tags, refs, parents, relations) merge as sets, the text merges character by character. Structure, links, inbox, queries and progress are computed by the same code on devices and the server (`@obtion/core`). The server has an id: a device that knew a different server asks whether to replace its copy (recommended: the server was set up anew) or upload it (the server was restored from a backup).

## Running

```bash
bun install
bun run build                        # web app → apps/web/dist/
bun run start                        # server on 127.0.0.1:8480 (PORT, HOST, OBTION_DATA, OBTION_PUBLIC_URL, OBTION_WEB_DIST)
```

On first start the browser asks for the language and sets up the default types and the start page – by default with a small made-up world of examples (`packages/core/src/examples.ts`), which Settings › Remove examples moves to the trash again. On the server: `bun run setup de [--examples]`.

Admin commands run while the server is stopped (they refuse otherwise) and are repeatable – same source, same item. Sources are only read.

```bash
bun run import:notion                # seed/notion.json (local Notion export, not in git)
bun run import:obsidian ~/second_brain
bun run stats                        # counts per type, server id, sequence number
```

All data lives in `data/` (`OBTION_DATA`): `obtion.db` (SQLite), `backups/` (a copy of it per day), `blobs/`, `vault/` (Markdown mirror) and `config.json` with the MCP token. None of it is in git.

### Running on a NAS or server (Docker)

The image holds the server with the web app. All data live in one ordinary folder on the host.

```bash
git clone <repository> obtion && cd obtion
cp .env.example .env                 # set OBTION_PUBLIC_URL (and OBTION_DATA_DIR if wanted)
docker compose up -d                 # builds the image from this repository
```

Then make the port reachable over HTTPS through whatever runs on the host – the server does not care which: `tailscale serve --bg --https=443 http://127.0.0.1:8480`, the NAS's own reverse proxy, Caddy and the like. The app needs HTTPS to be installed and to work offline.

- **Settings** live in `.env` (not in git, so `git pull` never collides with them); `.env.example` explains each. `OBTION_PUBLIC_URL` (required) is the address in the browser: the server only answers to its known host names (more with `OBTION_ALLOWED_HOSTS`).
- **Data:** `OBTION_DATA_DIR`, default `./data` next to the compose file – a plain folder, e.g. on the NAS's SSD. A new folder is set up by the container; an existing one keeps its owner (the server runs as that user, never as root).
- **Backup:** the server writes a consistent copy of the database to `backups/obtion-<date>.db` once a day and keeps the last seven. A backup job may therefore copy the whole data folder at any time, without stopping anything: `backups/` and `blobs/` (file contents, only ever added) are what counts; `obtion.db` itself may be caught mid-write and `vault/` is rebuilt at every start.
- **Restore:** `docker compose stop`, replace `obtion.db` with a file from `backups/` and delete `obtion.db-wal` and `obtion.db-shm`, `docker compose start`. Devices notice the older state and send what they have beyond it.
- **Update:** `git pull && docker compose up -d --build`.
- **Access and identity:** by default the port is published on 127.0.0.1 only, for a proxy on the same host. There is no login yet: whoever reaches the port can read and change everything, so keep it that way (`OBTION_BIND=0.0.0.0` opens it to the whole network). `tailscale serve` on the host also tells the server who is calling (`tailscale-user-login`); the server believes that only from a trusted proxy – the compose network's gateway (`OBTION_TRUSTED_PROXIES`).
- **Moving an existing server here:** stop the old server, copy its whole data folder (`obtion.db`, `blobs/`, `config.json`, …) into the data folder, start the container. The server keeps its id, so connected devices just continue (point the address they use to the new host); the MCP token stays the same. Starting with an empty folder instead gives a new server id: each device then asks once whether to replace its copy with the server's data or upload it.
- The built-in agent needs the Claude Code CLI next to the server and is not in the image; MCP works for any client.

### Development

```bash
bun run seed:demo                    # the setup's examples → data-demo/ (never data/)
OBTION_DATA=data-demo PORT=8481 bun --watch apps/server/src/index.ts
cd apps/web && PORT=8481 bunx vite --port 5181   # proxies /api, /mcp and /sync (WebSocket) to the server on PORT
bun test && bun run typecheck && bun run build   # typecheck: every package on its own
bun run test:e2e                     # browser smoke test: empty, examples and fresh server, every route, light/dark/phone
bun run icons                        # regenerate the app icons in apps/web/public/
```

The vite dev server listens on 127.0.0.1 and talks to the server under the server's own address (Host and Origin), so it works on any port and behind `tailscale serve`. Reached through the tailnet over HTTPS, set `OBTION_DEV_PUBLIC_URL=https://<host>.ts.net:<port>` so hot reload connects over wss on that port.

Use a fresh browser origin (another vite port) for every fresh data directory. A replica that already saw a higher sequence number of the same server id treats a fresh copy as a reset server and pushes its state into it.

### Deployment

Run `bun run build` once per update and `bun run start` as a service (for example a systemd user unit) on a machine in your tailnet, put it behind `tailscale serve --bg --https=8470 http://127.0.0.1:8480` and set `OBTION_PUBLIC_URL` to that address. Back up the data directory before an update that changes the data format.

### Connect an agent

**Settings › Connect an agent** shows a copy-ready command, e.g.

```bash
claude mcp add --transport http obtion https://<host>.<tailnet>.ts.net:8470/mcp --header "Authorization: Bearer <token>" -s user
```

Tools: `schema`, `query` (text or a type name), `get`, `search`, `focus`, `create`, `update`, `set_status`, `place`, `add_update`, `suggest`, `define_type`, `update_type` (also the views of its page), `convert` (preview only), `attach`, `delete`, `restore`, `undo`, `activity`. Prompts: `process_inbox`, `weekly_review`. Agents do not sort the inbox; they suggest. Writing calls are all or nothing ("Nothing changed" and the reason otherwise), answer with one line per entry and add hints (unresolved links, duplicate titles, open items below something done, no longer blocked).

## Layout

A Bun workspace. Logic without UI lives in shared packages, so further clients (a desktop app around the same React interface, a mobile app) reuse it; each app is a thin shell.

| Package | Contains | May use |
| --- | --- | --- |
| `packages/core` (`@obtion/core`) | data model and Yjs documents (`model.ts`), index (`graph.ts`), overview and sidebar (`placement.ts`), inbox, capabilities (`traits.ts`), queries, search, type operations, trash, setup and examples, sync protocol (`protocol.ts`), translations (`i18n.ts`, `locales/`) | only what every JavaScript runtime has (`runtime.d.ts`): no DOM, Node or Bun |
| `packages/sync` (`@obtion/sync`) | `Repo`: a device's replica of a server – documents, outbox, steps, sync over WebSocket. Storage, the server connection and questions to the user come from the platform (`RepoHost`, `ReplicaStorage`) | like core |
| `packages/ui` (`@obtion/ui`) | the React interface: `App.tsx`, `views/*`, `ui/*`, styles; `browser.ts` is the browser's `RepoHost` (IndexedDB, the server that served the page, tabs), `files.ts` the file contents per device | browser APIs, React |
| `apps/server` (`@obtion/server`) | `index.ts` (HTTP/WS), `store.ts`, `blobs.ts`, `ops.ts` + `mcp.ts` (agents), `agent.ts`, `undo.ts`, `mirror.ts`, `backup.ts`, `trust.ts`, `importers.ts` + `cli.ts` | Bun, SQLite |
| `apps/web` (`@obtion/web`) | the PWA shell: `index.html`, `src/main.tsx`, service worker updates (`src/update.ts`), icons, Vite config | browser APIs |

`tests/` holds the unit and server tests (`bun test`), `scripts/` the browser smoke test (playwright-core + Chrome in ~/.cache/ms-playwright), the demo seed and the icon generator. A locale test checks every key is in every catalog.

The typecheck runs per package with its own environment, so core and sync cannot pick up a platform API by accident. Bun installs isolated: a package only sees the dependencies it declares.

## License

[GNU Affero General Public License v3.0 or later](LICENSE).
