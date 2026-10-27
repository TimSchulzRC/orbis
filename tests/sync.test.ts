import { test, expect, afterAll } from "bun:test";
import { tempDir, removeTempDirs } from "./helpers";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as Y from "yjs";
import { Store } from "../src/server/store";
import { initItem } from "../src/shared/model";

afterAll(removeTempDirs);

function update(id: string, title: string): Uint8Array {
  const d = new Y.Doc({ guid: id });
  d.transact(() => initItem(d, { title }));
  return Y.encodeStateAsUpdate(d);
}
const tmp = () => tempDir("obtion-sync-");

test("a hub restored from an older backup is detected even after another device synced first", () => {
  const dir = tmp();
  const hub = new Store(dir);
  hub.applyRemote("a", update("a", "A"), "web:laptop");
  // Backup of the hub at seq 1.
  const backup = tmp();
  hub.db.exec(`VACUUM INTO '${join(backup, "obtion.db")}'`);
  // The phone pushes and remembers the hub's cursor (seq 2 + id of that row).
  hub.applyRemote("b", update("b", "B"), "web:phone");
  const phone = { since: hub.seq, sinceId: hub.lastUid };
  const hubId = hub.hubId;
  expect(phone.since).toBe(2);
  expect(hub.knowsCursor(phone.since, phone.sinceId)).toBe(true);
  hub.flush();
  hub.db.close();

  // The hub is restored from the backup; the laptop syncs first and pushes seq back to 2.
  const restored = new Store(backup);
  expect(restored.hubId).toBe(hubId);
  expect(restored.seq).toBe(1);
  restored.applyRemote("c", update("c", "C"), "web:laptop");
  expect(restored.seq).toBe(2);
  // seq alone looks fine (2 is not beyond the log), but the row there is another one.
  expect(phone.since > restored.seq).toBe(false);
  expect(restored.knowsCursor(phone.since, phone.sinceId)).toBe(false);
  // The laptop's own cursor is valid, and so is any position the backup still holds.
  expect(restored.knowsCursor(restored.seq, restored.lastUid)).toBe(true);
  const row1 = restored.db.query("SELECT uid FROM updates WHERE seq = 1").get() as { uid: string };
  expect(restored.knowsCursor(1, row1.uid)).toBe(true);
  // A cursor beyond the log is a reset as before; a fresh replica (0) never is.
  expect(restored.knowsCursor(5, "x")).toBe(false);
  expect(restored.knowsCursor(0)).toBe(true);
});

test("log rows keep their ids across restarts; databases from before cursor ids get ids once", () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  const old = new Database(join(dir, "obtion.db"));
  old.exec("CREATE TABLE updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, data BLOB NOT NULL, origin TEXT NOT NULL, ts INTEGER NOT NULL)");
  old.query("INSERT INTO updates (doc, data, origin, ts) VALUES (?, ?, ?, ?)").run("a", update("a", "A"), "web:x", Date.now());
  old.close();

  const s = new Store(dir);
  expect(s.seq).toBe(1);
  expect(s.lastUid).toMatch(/^[0-9a-f]{18}$/);
  expect(s.records.get("a")?.title).toBe("A");
  s.applyRemote("b", update("b", "B"), "web:x");
  const ids = (s.db.query("SELECT uid FROM updates ORDER BY seq").all() as { uid: string }[]).map((r) => r.uid);
  expect(new Set(ids).size).toBe(2);
  s.flush();
  s.db.close();
  const again = new Store(dir);
  expect(again.lastUid).toBe(ids[1]!);
  expect(again.knowsCursor(1, ids[0])).toBe(true);
});

test("a re-sent outbox item does not create a new log row", () => {
  const s = new Store(tmp());
  const u = update("a", "A");
  s.applyRemote("a", u, "web:x");
  const { seq, lastUid } = s;
  s.applyRemote("a", u, "web:x");
  expect([s.seq, s.lastUid]).toEqual([seq, lastUid]);
});

test("timestamps from a device clock far in the future are capped by the hub", () => {
  const s = new Store(tmp());
  const d = new Y.Doc({ guid: "a" });
  const future = Date.now() + 3 * 864e5;
  d.transact(() => {
    initItem(d, { title: "Uhr falsch", created: future, updated: future });
    d.getArray("updates").push([{ id: "u1", at: future, text: "x", by: "you" }]);
  });
  s.applyRemote("a", Y.encodeStateAsUpdate(d), "web:x");
  s.flush();
  const r = s.records.get("a")!;
  expect(r.created).toBeLessThanOrEqual(Date.now());
  expect(r.updated).toBeLessThanOrEqual(Date.now());
  expect(r.updates[0]!.at).toBeLessThanOrEqual(Date.now());
  // a little ahead (under 10 minutes) is left alone
  const soon = Date.now() + 60_000;
  const d2 = new Y.Doc({ guid: "b" });
  d2.transact(() => initItem(d2, { title: "Knapp", created: soon }));
  s.applyRemote("b", Y.encodeStateAsUpdate(d2), "web:x");
  s.flush();
  expect(s.records.get("b")!.created).toBe(soon);
});
