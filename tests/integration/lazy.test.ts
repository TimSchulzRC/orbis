// The server keeps only documents in use in memory. A document let go is reloaded from snapshot + log
// and must behave as before.
import { test, expect, afterAll, spyOn } from "bun:test";
import { tempDir, removeTempDirs } from "../support/helpers";
import { setupStore, stepOf, tool } from "../support/store";
import * as Y from "yjs";
import { AreaError, Store } from "@obtion/server/store";
import { undoStep } from "@obtion/server/undo";
import { versionOf } from "@obtion/server/ops";
import { PERSONAL as P, readItem } from "@obtion/core/model";

afterAll(removeTempDirs);

const AG = "agent:test";
const body = (s: Store, id: string) => s.records.get(id)?.body;

function seeded(n: number, cacheSize = 3) {
  const { dir, s, ops } = setupStore("obtion-lazy-", cacheSize);
  const ids = Array.from({ length: n }, (_, i) => s.create({ title: `Notiz ${i}`, body: `Text ${i}` }, "seed"));
  for (const [i, id] of ids.entries()) s.change(id, "seed", (d) => d.getText("body").insert(0, `Neu ${i} `));
  s.flush();
  s.trim();
  return { dir, s, ops, ids };
}

test("a start keeps no document in memory", () => {
  const { dir, s, ids } = seeded(12);
  const total = s.records.size;
  s.db.close();
  const again = new Store(dir, 3);
  expect(again.loaded.size).toBe(0);
  expect(again.records.size).toBe(total);
  expect(body(again, ids[5]!)).toBe("Neu 5 Text 5");
  expect(again.areaOf(ids[5]!)).toBe(P);
  expect(again.docsSince(P, 0).length).toBe(total);
  // a device syncing from scratch gets the full state without the server loading the document
  const d = new Y.Doc();
  Y.applyUpdate(d, again.stateOf(ids[7]!));
  expect(readItem(ids[7]!, d)?.body).toBe("Neu 7 Text 7");
  expect(again.loaded.size).toBe(0);
});

test("a start takes the records stored with the snapshots and decodes no document", () => {
  const { dir, s, ids } = seeded(12);
  s.change(ids[0]!, "seed", (d) => d.getMap("meta").set("deleted", "via:" + ids[1]));
  s.flush();
  s.db.close();
  const read = spyOn(Store.prototype as any, "read");
  const again = new Store(dir, 3);
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  // the same records as reading every document
  again.db.exec("DELETE FROM records");
  again.db.close();
  const full = new Store(dir, 3);
  expect(again.records).toEqual(full.records);
  expect(again.records.size).toBe(full.records.size);
  expect(again.records.get(ids[0]!)?.deleted).toBe(false); // its root is not deleted
});

test("stored records from another RECORD_VERSION are read anew", () => {
  const { dir, s, ids } = seeded(4);
  s.db.query("UPDATE records SET data = json_set(data, '$.title', 'old') WHERE id = ?").run(ids[2]!);
  s.kvSet("recordVersion", "0");
  s.db.close();
  const again = new Store(dir, 3);
  expect(again.records.get(ids[2]!)?.title).toBe("Notiz 2");
});

test("a failed atomic call keeps an earlier change of the same document pending until the flush", () => {
  const { dir, s, ids } = seeded(2);
  const [a, b] = ids as [string, string];
  s.change(a, "web:tim", (d) => d.getMap("meta").set("title", "committed"));
  expect(() =>
    s.atomic(() => {
      s.change(a, "agent:test", (d) => d.getMap("meta").set("title", "rolled back"));
      throw new Error("fails");
    }),
  ).toThrow();
  s.change(b, "web:tim", (d) => d.getMap("meta").set("title", "B"));
  s.flush();
  s.db.close();
  const again = new Store(dir, 3);
  expect(again.records.get(a)?.title).toBe("committed");
});

test("only the most recently used documents stay; the ones with unsaved changes always", () => {
  const { s, ids } = seeded(10);
  expect(s.loaded.size).toBe(3);
  expect([...s.loaded.keys()]).toEqual(ids.slice(-3)); // least recently used went first
  for (const id of ids.slice(0, 6)) s.change(id, "web:tim", (d) => d.getText("body").insert(0, "x"));
  s.trim(); // not flushed yet: all six are pending and stay
  for (const id of ids.slice(0, 6)) expect(s.loaded.has(id)).toBe(true);
  s.flush();
  s.trim();
  expect(s.loaded.size).toBe(3);
  for (const [i, id] of ids.slice(0, 6).entries()) expect(body(s, id)).toBe(`xNeu ${i} Text ${i}`);
});

test("a document let go is loaded again as it was, and its next change is not lost", () => {
  const { dir, s, ids } = seeded(8);
  const id = ids[0]!;
  expect(s.loaded.has(id)).toBe(false);
  const before = Y.encodeStateVector(s.getDoc(id));
  expect(s.getDoc(id).getText("body").toString()).toBe("Neu 0 Text 0");
  s.change(id, "web:tim", (d) => d.getText("body").insert(0, "Eins "));
  s.flush();
  for (const other of ids.slice(1)) s.getDoc(other);
  s.trim();
  expect(s.loaded.has(id)).toBe(false);
  s.change(id, "web:tim", (d) => d.getText("body").insert(0, "Zwei "));
  s.flush();
  expect(body(s, id)).toBe("Zwei Eins Neu 0 Text 0");
  expect(Y.encodeStateVector(s.getDoc(id))).not.toEqual(before);
  s.db.close();
  expect(body(new Store(dir, 3), id)).toBe("Zwei Eins Neu 0 Text 0");
});

test("sync: a device's change to a document not in memory merges with the server's", () => {
  const { s, ids } = seeded(6);
  const id = ids[1]!;
  // the device has the document from an earlier sync and edits it offline
  const device = new Y.Doc();
  Y.applyUpdate(device, s.stateOf(id));
  const sv = Y.encodeStateVector(device);
  device.getText("body").insert(device.getText("body").length, " vom Handy");
  // meanwhile an agent changed it on the server, then it was let go
  s.change(id, AG, (d) => d.getText("body").insert(0, "Agent: "));
  s.flush();
  for (const other of ids.filter((x) => x !== id)) s.getDoc(other);
  s.trim();
  expect(s.loaded.has(id)).toBe(false);
  s.applyRemote(id, Y.encodeStateAsUpdate(device, sv), "web:phone");
  s.flush();
  expect(body(s, id)).toBe("Agent: Neu 1 Text 1 vom Handy");
  // a document of another area is refused without loading it
  for (const other of ids.filter((x) => x !== id)) s.getDoc(other);
  s.trim();
  expect(s.loaded.has(id)).toBe(false);
  expect(() => s.applyRemote(id, Y.encodeStateAsUpdate(device), "web:phone", undefined, undefined, "a_other")).toThrow(AreaError);
  expect(s.loaded.has(id)).toBe(false);
});

test("undo works on documents that are no longer in memory", () => {
  const { s, ops } = seeded(0);
  const out = ops.call(AG, () => {
    ops.create({ title: "Garten", type: "Projekt", properties: { Status: "Planung" } }, AG);
    ops.create({ title: "Beet umgraben", type: "Task", parents: ["Garten"] }, AG);
    return "ok";
  });
  const step = stepOf(out);
  ops.call(AG, () => (ops.update("Garten", { properties: { Status: "aktiv" } }, AG), "ok"));
  for (let i = 0; i < 6; i++) s.create({ title: `Füller ${i}` }, "seed");
  s.trim();
  const garten = s.index().resolveTitle("Garten")!;
  expect(s.loaded.has(garten)).toBe(false);
  const r = undoStep(s, step, "web:tim");
  expect(r.trashed.length).toBe(2);
  expect(s.index().resolveTitle("Garten")).toBeUndefined();
  expect(s.records.get(garten)!.props.p_status).toBe("st_active"); // changed later: kept
});

test("MCP tools change documents that are not in memory", async () => {
  const { s, ids } = seeded(6);
  expect(s.loaded.has(ids[0]!)).toBe(false);
  const base_version = versionOf(s.records.get(ids[0]!)!);
  expect((await tool(s, "update", { ref: ids[0], title: "Umbenannt", body: "Neuer Text", base_version })).error).toBe(false);
  expect(s.records.get(ids[0]!)).toMatchObject({ title: "Umbenannt", body: "Neuer Text" });
  expect(s.events({ doc: ids[0] })[0]).toMatchObject({ kind: "updated", origin: expect.stringContaining("agent") });
});

test("all or nothing: a failed call leaves a document that had to be loaded as it was", () => {
  const { s, ids } = seeded(6);
  const id = ids[0]!;
  expect(s.loaded.has(id)).toBe(false);
  const seq = s.seq;
  expect(() =>
    s.atomic(() => {
      s.change(id, AG, (d) => d.getMap("meta").set("title", "Halb fertig"));
      expect(s.records.get(id)!.title).toBe("Halb fertig"); // visible to reads while the call runs
      throw new Error("bad item");
    }),
  ).toThrow("bad item");
  expect(s.seq).toBe(seq);
  expect(s.records.get(id)!.title).toBe("Notiz 0");
  expect(s.getDoc(id).getMap("meta").get("title")).toBe("Notiz 0");
});

test("after a crash before the flush, the log rows after the snapshot are not lost", () => {
  const dir = tempDir("obtion-lazy-");
  const s = new Store(dir, 3);
  const a = s.create({ title: "A", body: "vorher" }, "seed");
  s.change(a, "web:tim", (d) => d.getText("body").insert(0, "nachher "));
  const phone = new Y.Doc();
  phone.getMap("meta").set("kind", "info");
  phone.getMap("meta").set("title", "B vom Handy");
  s.applyRemote("b", Y.encodeStateAsUpdate(phone), "web:phone");
  clearTimeout((s as any).timer); // the process dies before the flush: no snapshots
  s.db.close();
  const again = new Store(dir, 3);
  expect(body(again, a)).toBe("nachher vorher");
  expect(again.records.get("b")?.title).toBe("B vom Handy");
  for (const id of [a, "b"]) {
    const d = new Y.Doc();
    Y.applyUpdate(d, again.stateOf(id)); // snapshot + rows, or rows only
    expect(readItem(id, d)).toEqual(again.records.get(id)!);
  }
});
