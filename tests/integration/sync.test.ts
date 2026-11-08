import { test, expect, afterAll } from "bun:test";
import { docUpdate, tempDir, removeTempDirs } from "../support/helpers";
import { join } from "node:path";
import * as Y from "yjs";
import { COMPACT_AFTER_ROWS, Store } from "@obtion/server/store";
import { PERSONAL as P, initItem } from "@obtion/core/model";

afterAll(removeTempDirs);

const tmp = () => tempDir("obtion-sync-");

test("a server restored from an older backup is detected even after another device synced first", () => {
  const dir = tmp();
  const server = new Store(dir);
  server.applyRemote("a", docUpdate({ id: "a", title: "A" }), "web:laptop");
  // Backup of the server at seq 1.
  const backup = tmp();
  server.db.exec(`VACUUM INTO '${join(backup, "obtion.db")}'`);
  // The phone pushes and remembers the server's cursor (seq 2 + id of that row).
  server.applyRemote("b", docUpdate({ id: "b", title: "B" }), "web:phone");
  const phone = { since: server.seq, sinceId: server.lastUid };
  const serverId = server.serverId;
  expect(phone.since).toBe(2);
  expect(server.knowsCursor(P, phone.since, phone.sinceId)).toBe(true);
  server.flush();
  server.db.close();

  // The server is restored from the backup; the laptop syncs first and pushes seq back to 2.
  const restored = new Store(backup);
  expect(restored.serverId).toBe(serverId);
  expect(restored.seq).toBe(1);
  restored.applyRemote("c", docUpdate({ id: "c", title: "C" }), "web:laptop");
  expect(restored.seq).toBe(2);
  // seq alone looks fine (2 is not beyond the log), but the row there is another one.
  expect(restored.knowsCursor(P, phone.since, phone.sinceId)).toBe(false);
  // The laptop's own cursor is valid, and so is any position the backup still holds.
  expect(restored.knowsCursor(P, restored.seq, restored.lastUid)).toBe(true);
  const row1 = restored.db.query("SELECT uid FROM updates WHERE seq = 1").get() as { uid: string };
  expect(restored.knowsCursor(P, 1, row1.uid)).toBe(true);
  // A cursor beyond the log is a reset as before; a fresh replica (0) never is.
  expect(restored.knowsCursor(P, 5, "x")).toBe(false);
  expect(restored.knowsCursor(P, 0)).toBe(true);
});

test("log rows keep their ids across restarts", () => {
  const dir = tmp();
  const s = new Store(dir);
  s.applyRemote("a", docUpdate({ id: "a", title: "A" }), "web:x");
  expect(s.seq).toBe(1);
  s.applyRemote("b", docUpdate({ id: "b", title: "B" }), "web:x");
  const ids = (s.db.query("SELECT uid FROM updates ORDER BY seq").all() as { uid: string }[]).map((r) => r.uid);
  expect(new Set(ids).size).toBe(2);
  s.flush();
  s.db.close();
  const again = new Store(dir);
  expect(again.lastUid).toBe(ids[1]!);
  expect(again.knowsCursor(P, 1, ids[0])).toBe(true);
});

test("a re-sent outbox item does not create a new log row", () => {
  const s = new Store(tmp());
  const u = docUpdate({ id: "a", title: "A" });
  s.applyRemote("a", u, "web:x");
  const { seq, lastUid } = s;
  s.applyRemote("a", u, "web:x");
  expect([s.seq, s.lastUid]).toEqual([seq, lastUid]);
});

test("timestamps from a device clock far in the future are capped by the server", () => {
  const s = new Store(tmp());
  const d = new Y.Doc({ guid: "a" });
  const future = Date.now() + 3 * 864e5;
  d.transact(() => {
    initItem(d, { title: "Clock wrong", created: future, updated: future });
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
  d2.transact(() => initItem(d2, { title: "Just ahead", created: soon }));
  s.applyRemote("b", Y.encodeStateAsUpdate(d2), "web:x");
  s.flush();
  expect(s.records.get("b")!.created).toBe(soon);
});

test("old log rows fold into one row per document; sync and loading still see everything", () => {
  const dir = tmp();
  const s = new Store(dir);
  s.applyRemote("a", docUpdate({ id: "a", title: "A" }), "web:x");
  for (let i = 0; i < 5; i++) s.change("a", "web:x", (d) => d.getText("body").insert(0, `${i}`));
  const folded = { since: s.seq, sinceId: s.lastUid };
  s.change("a", "web:x", (d) => d.getText("body").insert(0, "x"));
  const kept = { since: s.seq, sinceId: s.lastUid }; // a's newest old row: its seq and uid stay
  s.applyRemote("b", docUpdate({ id: "b", title: "B" }), "web:x");
  s.change("a", "web:x", (d) => d.getText("body").insert(0, "y"));
  s.flush();
  const last = s.last(P);
  const old = s.db.query("SELECT seq FROM updates WHERE seq <= ?").all(kept.since).length;
  s.db.query("UPDATE updates SET ts = 0 WHERE seq <= ?").run(kept.since);

  expect(s.compact()).toBe(old - 1);
  expect(s.db.query("SELECT COUNT(*) AS n FROM updates").get()).toEqual({ n: 3 });
  expect(s.last(P)).toEqual(last);
  expect(s.knowsCursor(P, kept.since, kept.sinceId)).toBe(true);
  expect(s.knowsCursor(P, folded.since, folded.sinceId)).toBe(false); // gone: the replica resets
  expect(s.docsSince(P, kept.since).sort()).toEqual(["a", "b"]);
  expect(s.compact()).toBe(0);
  s.db.close();
  const again = new Store(dir);
  expect(again.getDoc("a").getText("body").toString()).toBe("yx43210");
  expect(again.records.get("b")?.title).toBe("B");
});

test("the log compacts itself after enough writes, without a timer", async () => {
  const s = new Store(tmp());
  s.applyRemote("a", docUpdate({ id: "a", title: "A" }), "web:x");
  for (let i = 0; i < 3; i++) s.change("a", "web:x", (d) => d.getText("body").insert(0, "o"));
  s.db.query("UPDATE updates SET ts = 0").run();
  while (s.seq < COMPACT_AFTER_ROWS) s.change("a", "web:x", (d) => d.getText("body").insert(0, "n"));
  const rows = () => (s.db.query("SELECT COUNT(*) AS n FROM updates").get() as { n: number }).n;
  expect(rows()).toBe(COMPACT_AFTER_ROWS);
  for (let i = 0; i < 100 && rows() === COMPACT_AFTER_ROWS; i++) await Bun.sleep(5); // the next tick, later under load
  expect(rows()).toBe(COMPACT_AFTER_ROWS - 3); // the four old rows are one now
}, 30_000); // 10,000 writes: about a second here, several on a busy CI machine

test("compaction never splits a step, even where steps interleave", () => {
  const s = new Store(tmp());
  s.applyRemote("a", docUpdate({ id: "a", title: "A" }), "web:x");
  s.applyRemote("b", docUpdate({ id: "b", title: "B" }), "web:x");
  // rows: B A B | A  – keeping A whole moves the cut before its first row, which splits B
  for (const [doc, step] of [["b", "sB"], ["a", "sA"], ["b", "sB"], ["a", "sA"]] as const)
    s.applyRemote(doc, docUpdate({ id: doc, title: doc + Math.random() }), "web:x", undefined, step);
  const lastOld = s.seq - 1;
  s.db.query("UPDATE updates SET ts = 0 WHERE seq <= ?").run(lastOld);
  s.compact();
  const steps = s.db.query("SELECT step, COUNT(*) AS n FROM updates WHERE step IS NOT NULL GROUP BY step ORDER BY step").all();
  expect(steps).toEqual([{ step: "sA", n: 2 }, { step: "sB", n: 2 }]);
});
