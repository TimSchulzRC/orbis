// The daily database copies in data/backups: one per day, readable on its own, only the newest kept.
import { test, expect, afterAll } from "bun:test";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "@obtion/server/store";
import { Backups } from "@obtion/server/backup";
import { docUpdate, tempDir, removeTempDirs } from "../support/helpers";

afterAll(removeTempDirs);

test("a copy per day that opens as a store of its own, the oldest dropped beyond the limit", () => {
  const dir = tempDir("obtion-backup-");
  const store = new Store(dir);
  store.applyRemote("a", docUpdate({ title: "Erste Notiz" }), "web:laptop");
  const backups = new Backups(store, join(dir, "backups"), 2);

  const first = backups.run("2026-10-01")!;
  expect(backups.run("2026-10-01")).toBeUndefined(); // same day: no second copy
  expect(existsSync(first)).toBe(true);

  backups.run("2026-10-02");
  backups.run("2026-10-03");
  expect(readdirSync(join(dir, "backups")).sort()).toEqual(["obtion-2026-10-02.db", "obtion-2026-10-03.db"]);

  // the copy holds the note and the server id: restoring it is the same server, one step back
  const restoredDir = tempDir("obtion-restored-");
  copyFileSync(join(dir, "backups", "obtion-2026-10-03.db"), join(restoredDir, "obtion.db"));
  const restored = new Store(restoredDir);
  expect(restored.records.get("a")?.title).toBe("Erste Notiz");
  expect(restored.serverId).toBe(store.serverId);
});
