# Obtion

A personal system that brings knowledge and work together: a linked knowledge graph like Obsidian and projects with tasks like Notion, in one app. It runs local-first on every own device, syncs through a hub in the own network (tailnet only) and can largely be used through an agent (MCP and a built-in chat). German and English UI.

This README summarises the model and what the code implements.

## The model

- **Information:** title, Markdown text, tags, refs (explicit plus links from the text), at most one **type**, free properties, **"Teil von"** with any number of parents (one is the home), history. These base fields are fixed; information is not a type.
- **Overview:** not a type – any information with children. Every page shows "Darunter" (all children, grouped by type) and "Verlinkt von"; belonging comes from children, [[links]] are mentions ("Hier einordnen" places a linked item without a place).
- **Pinned:** any information can be pinned (`meta.pinned`). Pinned items form "Angeheftet" in the sidebar and count as a place; below each, all children one level deeper (done items left out). Below "Angeheftet", "Typen" lists the page of every type and the files.
- **File:** its own primitive with the same connections, no type but a file type (bild, pdf, audio, video, dokument, sonstiges). Content by SHA-256 on the hub, metadata synced; previews and display versions of images on every device; per device "online only" or "everything local".
- **Inbox:** whatever its rule matches – stored in the settings, adjustable ("Was landet im Eingang?"), default `ohne:typ ohne:eltern -angeheftet | datei ohne:eltern ohne:verwendung`.
- **Type:** data, not code – properties per type (text, number, date, checkbox, URL, select, multi-select, status with groups, relation with inverse, computed) and capabilities (status, progress, updates, due date "Termin", main action, template). Capabilities are read only through `src/shared/traits.ts`. Every type has its page: the list of its entries with views as tabs (table, board, list, calendar, timeline, gallery), stored on the type. Karte, Projekt and Task are created at setup and are ordinary, deletable types afterwards. No code asks for a type id; the app works with zero types.
- **Queries:** stored as JSON with ids, typed in either language: `typ:Task status:offen unter:[[Relaunch]] fällig<=+7d gruppe:pfad`. Query blocks live in texts (```` ```abfrage … ``` ````). Mixed lists are pages with query blocks (with tabs too), e.g. "Eingang Arbeit" = `eingang verknüpft:unter:[[Arbeit]]`.
- **No required type:** new informations have no type by default; there is no setting for another default. In the inbox the agent only suggests a type and a place.

Rules that are easy to miss (details in the plan, Technik › Regeln):

- **Trash with cascade:** `meta.deleted` is `true` or `"via:<root>"`. What hangs only below a deleted item goes along and comes back with it; another living parent always keeps an item (`src/shared/trash.ts`).
- **Done date:** entering the status group done sets `meta.done`, reopening clears it; an update with a status change uses its own date. Query `erledigt>-7d`.
- **One step, one undo:** every user action and every tool call is a step (its id is on every log row it wrote). Activity › Rückgängig takes back all of it; fields changed again later keep the newer value, items it created go to the trash; undo is itself a step and can be redone (`src/server/undo.ts`).
- **Hub reset:** devices send `hello { since, sinceId }`; a hub restored from an older backup is noticed even after another device synced first.
- **Tolerant input:** statuses as group or option name in German or English (also synonyms), dates like 30.10.2026, 10/30/2026, morgen, type names in plural (`src/shared/input.ts`). Search folds ä/ö/ü/ß and hyphens.

## Architecture

```
 Browser / PWA                                   Any MCP client (Claude Code, Desktop …)
 full replica (IndexedDB, files in OPFS)                 │  MCP over HTTPS + bearer token
        │  WebSocket /sync (Yjs updates + outbox)        │
        ▼                                                ▼
 ┌────────────────────────────── Hub (NAS / home server, Bun) ──────────────────────────────┐
 │ SQLite: update log · snapshots · activity      data/blobs/<sha256> (+ previews via ffmpeg)│
 │ records → index (structure, links, aggregation) → search · queries · MCP · agent runner   │
 │ data/vault/: read-only Markdown mirror below each item's home                             │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
```

Each item is a Yjs document; scalar fields merge last-writer-wins, sets (tags, refs, parents, relations) merge as sets, the text merges character by character. Structure, links, inbox, queries and progress are computed by the same code on devices and the hub (`src/shared/`). The hub has an id: a device that knew a different hub asks whether to replace its copy (recommended: the hub was set up anew) or upload it (the hub was restored from a backup).

## Running

```bash
bun install
bun run build                        # web app → dist/
bun run start                        # hub on 127.0.0.1:8480 (PORT, HOST, OBTION_DATA, OBTION_PUBLIC_URL)
```

On first start the browser asks for the language and sets up the default types and the start page – by default with a small made-up world of examples (`src/shared/examples.ts`), which Settings › Remove examples moves to the trash again. On the hub: `bun run setup de [--examples]`.

Admin commands run while the hub is stopped (they refuse otherwise) and are repeatable – same source, same item. Sources are only read.

```bash
bun run import:notion                # seed/notion.json (local Notion export, not in git)
bun run import:obsidian ~/second_brain
bun run stats                        # counts per type, hub id, sequence number
```

All data lives in `data/` (`OBTION_DATA`): `obtion.db` (SQLite), `blobs/`, `vault/` (Markdown mirror) and `config.json` with the MCP token. None of it is in git.

### Development

```bash
bun run seed:demo                    # the setup's examples → data-demo/ (never data/)
OBTION_DATA=data-demo PORT=8481 bun --watch src/server/index.ts
PORT=8481 bunx vite --port 5181          # proxies /api, /mcp and /sync (WebSocket) to the hub on PORT
bun test && bun run typecheck && bun run build
bun run test:e2e                     # browser smoke test: empty, examples and fresh hub, every route, light/dark/phone
bun run icons                        # regenerate the app icons in public/
```

The vite dev server listens on 127.0.0.1 and talks to the hub under the hub's own address (Host and Origin), so it works on any port and behind `tailscale serve`. Reached through the tailnet over HTTPS, set `OBTION_DEV_PUBLIC_URL=https://<host>.ts.net:<port>` so hot reload connects over wss on that port.

Use a fresh browser origin (another vite port) for every fresh data directory. A replica that already saw a higher sequence number of the same hub id treats a fresh copy as a reset hub and pushes its state into it.

### Deployment

Run `bun run build` once per update and `bun run start` as a service (for example a systemd user unit) on a machine in your tailnet, put it behind `tailscale serve --bg --https=8470 http://127.0.0.1:8480` and set `OBTION_PUBLIC_URL` to that address. Back up the data directory before an update that changes the data format.

### Connect an agent

**Settings › Connect an agent** shows a copy-ready command, e.g.

```bash
claude mcp add --transport http obtion https://<host>.<tailnet>.ts.net:8470/mcp --header "Authorization: Bearer <token>" -s user
```

Tools: `schema`, `query` (text or a type name), `get`, `search`, `focus`, `create`, `update`, `set_status`, `place`, `add_update`, `suggest`, `define_type`, `update_type` (also the views of its page), `convert` (preview only), `attach`, `delete`, `restore`, `undo`, `activity`. Prompts: `process_inbox`, `weekly_review`. Agents do not sort the inbox; they suggest. Writing calls are all or nothing ("Nothing changed" and the reason otherwise), answer with one line per entry and add hints (unresolved links, duplicate titles, open items below something done, no longer blocked).

## Layout

```
src/shared/  model.ts (documents), graph.ts (index), placement.ts (overview, sidebar), inbox.ts,
             traits.ts (capabilities), query.ts, typeops.ts (delete type, tag ↔ type), setup.ts, i18n.ts
src/server/  index.ts (HTTP/WS), store.ts, blobs.ts, ops.ts + mcp.ts (agents), agent.ts, mirror.ts,
             importers.ts + cli.ts
src/client/  repo.ts (replica + sync), files.ts (file contents per device), App.tsx, views/*, ui/*
src/locales/ de.json, en.json (ICU; a test checks every key is in every catalog)
scripts/     demo-seed.ts, e2e.ts (browser smoke test, playwright-core + Chrome in ~/.cache/ms-playwright), icons.ts
```

## License

[GNU Affero General Public License v3.0 or later](LICENSE).
