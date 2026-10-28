# Obtion

Obtion brings knowledge and work together in one app: notes that link to each other, as in Obsidian, and projects with tasks, as in Notion. You run it on your own server, for example a NAS, and use it in the browser on every device. It keeps working offline and syncs when the connection is back. An AI agent can read and change your data through MCP or the built-in chat.

The app speaks German and English.

## What you can do with it

- **Write things down:** everything starts as a simple entry with a title and text. Without a place it waits in the inbox until you sort it.
- **Put things where they belong:** an entry can sit below one or more others. Anything with entries below it becomes an overview of its own.
- **Link things:** `[[links]]` connect entries. Each page shows what links to it.
- **Give things a type:** projects, tasks, books, people, or any type you define yourself, with its own properties, statuses and views (table, board, list, calendar, timeline, gallery).
- **Ask for lists:** queries such as `typ:Task status:offen fällig<=+7d` can sit in any text and stay up to date.
- **Keep files:** images, PDFs and other files live next to your entries.
- **Work in several workspaces:** a private one and one for your team, side by side. Each has its own members, content and settings.
- **Undo anything:** every change can be taken back in the activity, including the agent's changes. Deleted entries go to the trash first.

## Running it with Docker

You need Docker on a NAS or any other machine.

```bash
git clone <repository> obtion && cd obtion
mkdir data
docker compose up -d
```

Then open `http://<address of the machine>:8480` in the browser and create the first account. It becomes the admin. Others join with an invite link from the workspace settings.

Over plain HTTP the app cannot be installed and does not open offline. For that, put HTTPS in front of it, for example with Tailscale, the NAS's reverse proxy or Caddy.

**Settings** are optional. Copy `.env.example` to `.env` and adjust it. The file explains each setting, for example where the data live, the port, and who may sign up.

**The data folder** must belong to the user the server runs as. If yours isn't owned by user 1000, set `OBTION_UID` and `OBTION_GID` in `.env` to its owner (`ls -n` shows the numbers).

**Update:**

```bash
git pull && docker compose up -d --build
```

## Backup and restore

All data live in the data folder. The server writes a daily copy of each workspace's database into its `backups` folder and keeps the last seven, so a backup job can copy the whole data folder at any time.

To restore a workspace: stop the container, replace `obtion.db` in that workspace's folder with a file from `backups`, delete `obtion.db-wal` and `obtion.db-shm`, and start the container again. Devices notice the older state and send what they have beyond it.

## Connecting an agent

In a workspace's settings, **Connect an agent** creates a token and shows a command you can copy, for example for Claude Code:

```bash
claude mcp add --transport http obtion https://<host>/w/<workspace>/mcp --header "Authorization: Bearer <token>" -s user
```

The agent can search, create, change and sort, but it only suggests places for inbox entries. Its changes are marked in the activity and can be undone there.

## Development

```bash
bun install
bun run dev        # server and web app with live reload
bun test           # unit and integration tests
bun run test:e2e   # browser test
```

## License

[GNU Affero General Public License v3.0 or later](LICENSE).
