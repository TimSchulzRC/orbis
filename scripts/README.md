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
