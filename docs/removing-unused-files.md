# Removing unused files

The server never removes file contents by itself. To see which ones no item points to any more (not even one in the trash or in a file's history), stop the server and run:

```bash
bun apps/server/src/cli.ts gc            # lists them, removes nothing
bun apps/server/src/cli.ts gc --force    # removes them
```

With Docker: `docker compose stop`, then `docker compose run --rm obtion bun apps/server/src/cli.ts gc` (with `--force` to remove), then `docker compose start`.

With several workspaces, name one with `--workspace <id>`. A database copy in `backups` older than the run may point to removed files; restored, it shows them as missing.
