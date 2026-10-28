# Background development servers

On Linux with Bash, Bun, user systemd, `flock`, `ss` and an authenticated
Tailscale installation:

```bash
bun install
bun run dev:start
bun run dev:stop
```

Run these commands from the repository root. Start prints the worktree's HTTPS
URL. Backend and Vite run as user services after the terminal closes. Stop ends
both services and removes only that worktree's Tailscale forwarding rule.
Services restart on failure; they do not start automatically after a reboot.
To keep user services running after logout, enable user lingering on the host.

Ports are allocated automatically and recorded in
`${XDG_STATE_HOME:-~/.local/state}/obtion-dev/`. Separate worktrees receive separate
ports and use their own `data/` directories. Repeated starts leave an already
running stack alone. Repeated stops are safe.

The script prints service names during startup. Read their logs with
`journalctl --user -u <service-name>`. Each worktree needs these package scripts
and the Bash script, along with its installed dependencies.

To stop all Obtion development services managed by this script, across worktrees:

```bash
bun run dev:stop:all
```

To stop all of those services and permanently delete the server data in every
existing Git worktree of this repository, including the main checkout:

```bash
bun run dev:reset:all
```

Reset deletes each worktree's entire `data/` directory, including accounts,
workspaces, files, settings, tokens, and backups. It runs immediately without a
confirmation prompt. The next start creates fresh data. Symlinked `data/`
directories are rejected. Custom `OBTION_DATA` paths and browser storage are not
cleared. Servers started manually with `bun run dev` are not managed by these
commands and should be stopped before resetting.
