# Removing unused files

Deleting an item for good (trash › delete for good, or empty the trash) removes the file contents only that item used. Everything else stays until you clean up by hand. To see which ones no item points to any more (not even one in the trash or in a file's history), stop the server and run:

```bash
bun apps/server/src/cli.ts gc            # lists them, removes nothing
bun apps/server/src/cli.ts gc --force    # removes them
```

With Docker: `docker compose stop`, then `docker compose run --rm obtion bun apps/server/src/cli.ts gc` (with `--force` to remove), then `docker compose start`.

With several workspaces, name one with `--workspace <id>`. A database copy in `backups` older than the run may point to removed files; restored, it shows them as missing.

## Deleting for good and backups

Deleting for good removes the item from the server's database (its log, history, activity and text versions), its file contents that no other item uses, and its copy on every device. Devices that were offline drop it when they connect again; the server ignores what they still send for it.

The daily database copies in `backups` (the last 7 are kept) still contain the item until they are rotated out. Delete them by hand if it must be gone sooner. Restoring such a copy brings the item back.
