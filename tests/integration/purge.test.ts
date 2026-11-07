// Deleting for good: the server forgets every trace, and devices that missed it can't bring it back.
import { test, expect, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import * as Y from "yjs";
import { docUpdate, tempDir, removeTempDirs } from "../support/helpers";
import { setupStore, tool as storeTool } from "../support/store";
import { Workspace, type Conn } from "@obtion/server/workspace";
import { Store } from "@obtion/server/store";
import { Ops } from "@obtion/server/ops";
import { sha256 } from "@obtion/server/blobs";
import { storeWriter } from "@obtion/server/setup";
import { PERSONAL, replaceBody, setFileMeta } from "@obtion/core/model";
import { deleteItem } from "@obtion/core/trash";
import { type ServerMsg, toB64 } from "@obtion/core/protocol";
import { Repo, type OutItem, type ReplicaStorage, type StoredRow, type SyncSocket } from "@obtion/sync";

afterAll(removeTempDirs);

/** A device's connection as the workspace sees it; what the server sends lands in `got`. */
function serverSide(w: Workspace) {
  const got: ServerMsg[] = [];
  const ws = { data: { userId: "u", workspace: "w", areas: new Set<string>(), origin: "web:Tim", user: { id: "u", name: "Tim" } } satisfies Conn, send: (s: string) => got.push(JSON.parse(s)), close() {} };
  w.conns.add(ws as never);
  return { ws: ws as never, got };
}

const rowsOf = (s: Store, ids: string[]) =>
  ["updates", "events", "versions"].map((t) => (s.db.query(`SELECT count(*) AS n FROM ${t} WHERE doc IN (SELECT value FROM json_each(?))`).get(JSON.stringify(ids)) as { n: number }).n).concat((s.db.query("SELECT count(*) AS n FROM docstate WHERE id IN (SELECT value FROM json_each(?))").get(JSON.stringify(ids)) as { n: number }).n);

async function setUp() {
  const dir = tempDir("obtion-purge-");
  const w = new Workspace(dir);
  const s = w.store;
  const shared = new TextEncoder().encode("same content in two files");
  const own = new TextEncoder().encode("only the purged file has this");
  await w.blobs.put(sha256(shared), shared);
  await w.blobs.put(sha256(own), own);
  const file = (title: string, hash: string) => {
    const id = s.create({ kind: "datei", title }, "web:Tim");
    s.change(id, "web:Tim", (d) => setFileMeta(d, { name: title, hash, size: 1, mime: "text/plain", filetype: "dokument" }));
    return id;
  };
  const project = s.create({ title: "Secret project" }, "web:Tim");
  const task = s.create({ title: "Secret task", parents: [project] }, "web:Tim");
  const attachment = file("secret.txt", sha256(own));
  const copy = file("copy.txt", sha256(shared));
  const other = file("other.txt", sha256(shared));
  s.change(attachment, "web:Tim", (d) => setFileMeta(d, { history: [{ hash: sha256(shared), name: "old.txt", size: 1, at: 1 }] } as never));
  s.change(project, "web:Tim", (d) => replaceBody(d, "the secret plan"));
  s.flush();
  s.change(project, "web:Tim", (d) => replaceBody(d, "the secret plan, version two"));
  s.flush();
  return { dir, w, s, project, task, attachment, copy, other, shared, own };
}

test("purging removes every trace on the server and tells connected devices", async () => {
  const { w, s, project, task, attachment, copy, other, shared, own } = await setUp();
  const device = serverSide(w);
  w.message(device.ws, { t: "hello", area: PERSONAL, since: 0 });
  // a cursor on one of the project's rows, as a device has it that saw the delete last
  const ix = s.index();
  deleteItem(storeWriter(s, "web:Tim"), ix, project);
  deleteItem(storeWriter(s, "web:Tim"), s.index(), attachment);
  deleteItem(storeWriter(s, "web:Tim"), s.index(), copy);
  s.flush();
  const cursor = s.last(PERSONAL);
  expect((s.db.query("SELECT doc FROM updates WHERE seq = ?").get(cursor.seq) as { doc: string }).doc).toBe(copy);
  expect(rowsOf(s, [project, task]).every((n) => n > 0)).toBe(true);

  const ops = new Ops(s, w.blobs);
  expect(() => ops.purge(other)).toThrow("Nothing in the trash");
  expect(ops.purge(project).sort()).toEqual([project, task].sort());
  expect(rowsOf(s, [project, task])).toEqual([0, 0, 0, 0]);
  expect(s.records.has(project) || s.records.has(task)).toBe(false);
  expect(device.got.at(-1)).toEqual({ t: "purged", area: PERSONAL, ids: expect.arrayContaining([project, task]) });
  expect((s.db.query("SELECT count(*) AS n FROM events WHERE title IN ('Secret project', 'Secret task')").get() as { n: number }).n).toBe(0);

  // empty the trash: the file goes with its own content; content another file uses stays
  expect(ops.purge().sort()).toEqual([attachment, copy].sort());
  expect(w.blobs.has(sha256(own))).toBe(false);
  expect(w.blobs.has(sha256(shared))).toBe(true);
  expect(s.records.has(other)).toBe(true);

  // a device whose cursor sat on a purged row catches up without a reset and learns what went
  const late = serverSide(w);
  w.message(late.ws, { t: "hello", area: PERSONAL, since: cursor.seq, sinceId: cursor.uid });
  const updates = late.got.find((m) => m.t === "updates") as Extract<ServerMsg, { t: "updates" }>;
  expect(updates.reset).toBe(false);
  expect((late.got.find((m) => m.t === "purged") as Extract<ServerMsg, { t: "purged" }>).ids.sort()).toEqual([project, task, attachment, copy].sort());
  w.shut();
});

test("a device that was offline cannot push a purged document back, not even after a restart", async () => {
  const { dir, w, s, project } = await setUp();
  const stale = new Y.Doc({ guid: project });
  Y.applyUpdate(stale, s.stateOf(project));
  deleteItem(storeWriter(s, "web:Tim"), s.index(), project);
  s.flush();
  new Ops(s, w.blobs).purge(project);
  const seq = s.seq;
  // the offline device edits its copy and comes back
  stale.transact(() => replaceBody(stale, "edited offline"));
  const device = serverSide(w);
  w.message(device.ws, { t: "hello", area: PERSONAL, since: 0 });
  w.message(device.ws, { t: "push", area: PERSONAL, items: [{ k: "k1", d: project, u: toB64(Y.encodeStateAsUpdate(stale)) }] });
  expect(device.got.at(-1)).toMatchObject({ t: "ack", keys: ["k1"] });
  expect(s.seq).toBe(seq);
  expect(s.records.has(project)).toBe(false);
  w.shut();

  const again = new Store(dir);
  again.applyRemote(project, docUpdate({ id: project, title: "back?" }), "web:x");
  expect(again.records.has(project)).toBe(false);
  expect(rowsOf(again, [project])).toEqual([0, 0, 0, 0]);
});

test("a device drops purged documents from memory and storage and ignores them afterwards", async () => {
  const { w, s, project, task } = await setUp();
  const dropped: string[][] = [];
  const rows: StoredRow[] = [];
  const outbox: OutItem[] = [];
  const storage: ReplicaStorage = {
    open: async () => {},
    load: async () => ({ rows: [], outbox: [] }),
    compact: async () => {},
    write: async (x) => void (rows.push(...(x.rows ?? [])), outbox.push(...(x.outbox ?? []))),
    outbox: async () => outbox,
    drop: async (ids) => void dropped.push(ids),
    serverId: async () => undefined,
    destroy: async () => {},
  };
  // the device talks to the workspace in this process
  const conn = serverSide(w);
  const socket: SyncSocket = { readyState: 1, send: (m) => w.message(conn.ws, JSON.parse(m)), close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
  conn.ws = Object.assign(conn.ws, { send: (m: string) => socket.onmessage?.({ data: m }) });
  const repo = new Repo({
    storage,
    device: "test",
    connect: () => (queueMicrotask(() => socket.onopen?.()), socket),
    post: async (path, body) => {
      const res = await w.handle(new Request("http://x/w/w" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), path, { user: { id: "u", name: "Tim" } });
      return { ok: res.ok, statusText: res.statusText, body: await res.json() };
    },
    askOtherServer: async () => null,
    confirmDiscard: async () => false,
    tooNew() {},
    reload() {},
  });
  await repo.init();
  for (let i = 0; i < 50 && !repo.status.synced; i++) await Bun.sleep(5);
  expect(repo.get(project)?.title).toBe("Secret project");

  repo.remove(project);
  s.flush();
  expect(s.records.get(project)?.deleted).toBe(true);
  expect(await repo.purge({ id: project })).toBe(true);
  expect(repo.get(project) ?? repo.get(task)).toBeUndefined();
  expect(repo.docs.has(project)).toBe(false);
  expect(dropped.flat().sort()).toEqual(expect.arrayContaining([project, task].sort()));
  // edits for it, from the server or this app, change nothing any more
  repo.change(project, (d) => replaceBody(d, "again"));
  expect(repo.docs.has(project)).toBe(false);
  w.shut();
});

test("agents delete for good only from the trash, one item or all of it", async () => {
  const { s } = setupStore("obtion-purge-mcp-");
  const tool = async (name: string, args: unknown) => (await storeTool(s, name, args)).text;
  await tool("create", { items: [{ title: "Alt" }, { title: "Auch alt" }, { title: "Bleibt" }] });
  expect(await tool("purge", { ref: "Alt" })).toContain("Nothing in the trash");
  await tool("delete", { ref: "Alt" });
  await tool("delete", { ref: "Auch alt" });
  expect(await tool("purge", { ref: "Alt" })).toBe('Deleted "Alt" for good.');
  expect(await tool("restore", { ref: "Alt" })).toContain("Nothing in the trash");
  expect(await tool("purge", {})).toContain("Give ref");
  expect(await tool("purge", { empty_trash: true })).toBe("Emptied the trash: deleted 1 item(s) for good.");
  expect([...s.records.values()].map((r) => r.title)).not.toContain("Auch alt");
  expect(s.index().resolveTitle("Bleibt")).toBeDefined();
});

test("a purge after a restart still reaches a device whose cursor sat on purged rows", () => {
  const dir = tempDir("obtion-purge-seq-");
  const s = new Store(dir);
  for (const id of ["a", "b", "c"]) s.applyRemote(id, docUpdate({ id, title: id }), "web:x");
  const cursor = s.last(PERSONAL); // on c's row, the newest
  s.purge(["c"]);
  s.db.close();
  const again = new Store(dir);
  again.purge(["b"]);
  expect(again.knowsCursor(PERSONAL, cursor.seq, cursor.uid)).toBe(true);
  expect(again.purgedSince(PERSONAL, cursor.seq).sort()).toEqual(["b", "c"]);
});
