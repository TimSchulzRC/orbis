// The daily database copies in data/backups: one per day, readable on its own, only the newest kept.
// And the schema versions of the databases.
import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "@obtion/server/store";
import { Backups } from "@obtion/server/backup";
import { migrate } from "@obtion/server/migrate";
import { docUpdate, tempDir, removeTempDirs } from "../support/helpers";

afterAll(removeTempDirs);

test("a copy per day that opens as a store of its own, the oldest dropped beyond the limit", () => {
  const dir = tempDir("obtion-backup-");
  const store = new Store(dir);
  store.applyRemote("a", docUpdate({ title: "First note" }), "web:laptop");
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
  expect(restored.records.get("a")?.title).toBe("First note");
  expect(restored.serverId).toBe(store.serverId);
});

test("the accounts get copies of their own, named apart from a workspace's", () => {
  const dir = tempDir("obtion-backup-");
  const db = new Database(join(dir, "accounts.db"));
  db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
  new Backups({ db }, join(dir, "backups"), 7, "accounts").run("2026-10-01");
  expect(readdirSync(join(dir, "backups"))).toEqual(["accounts-2026-10-01.db"]);
  expect(new Database(join(dir, "backups", "accounts-2026-10-01.db")).query("SELECT x FROM t").get()).toEqual({ x: 1 });
});

test("schema steps run once each, in order; a database from a newer server is refused", () => {
  const db = new Database(":memory:");
  migrate(db, ["CREATE TABLE a (x)"]);
  migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]); // only the new step runs
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "a" }, { name: "b" }]);
  expect(() => migrate(db, ["CREATE TABLE a (x)"])).toThrow(/schema version 2/);
});
