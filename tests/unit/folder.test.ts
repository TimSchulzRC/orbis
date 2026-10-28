import { test, expect } from "bun:test";
import { Repo, type OutItem, type RepoHost, type ReplicaStorage, type StoredRow } from "../../packages/sync/src/repo";
import { type Dir, folderStorage, readInfo, writeInfo, encodeRows, decodeRows } from "../../packages/sync/src/folder";

/** A folder in memory, shared by every storage made on it (like two apps on one folder). */
function memDir(): Dir & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async list(sub) {
      return [...files.keys()].filter((p) => p.startsWith(sub + "/")).map((p) => p.slice(sub.length + 1));
    },
    async read(path) {
      return files.get(path);
    },
    async write(path, data) {
      files.set(path, data.slice());
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

/** What one app instance keeps for the server (outbox, position). */
function memSync(): ReplicaStorage {
  const outbox = new Map<string, OutItem>();
  let lastSeq: number | undefined;
  let serverId: string | undefined;
  return {
    async open() {},
    async load() {
      return { rows: [], outbox: [...outbox.values()], lastSeq };
    },
    async compact() {},
    async write(w) {
      for (const o of w.outbox ?? []) outbox.set(o.k, o);
      for (const k of w.acked ?? []) outbox.delete(k);
      if (w.cursor) lastSeq = w.cursor.lastSeq;
      if (w.serverId) serverId = w.serverId;
    },
    async outbox() {
      return [...outbox.values()];
    },
    async serverId() {
      return serverId;
    },
    async destroy() {
      outbox.clear();
    },
  };
}

/** A replica on `dir`; it looks for other writers' files every 10 ms. `server`: it has one (that never answers). */
function open(dir: Dir, server = false) {
  const storage = folderStorage(Promise.resolve(dir), memSync());
  const follow = storage.follow;
  storage.follow = (fn) => follow(fn, 10);
  const host: RepoHost = {
    storage,
    device: "test",
    connect: server ? () => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }) : undefined,
    post: async () => null,
    askOtherServer: async () => null,
    confirmDiscard: async () => false,
    tooNew() {},
    reload() {},
  };
  const repo = new Repo(host);
  return { repo, ready: repo.init() };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("rows survive the file format", () => {
  const rows = [
    { d: "a", u: new Uint8Array([1, 2, 3]) },
    { d: "Notiz-ä€😀", u: new Uint8Array([]) },
  ];
  expect(decodeRows(encodeRows(rows))).toEqual(rows);
});

test("the folder names its workspace", async () => {
  const dir = memDir();
  expect(await readInfo(dir)).toBeUndefined();
  await writeInfo(dir, { id: "w1", name: "Privat" });
  expect(await readInfo(dir)).toEqual({ folder: 1, id: "w1", name: "Privat" });
});

test("a workspace without a server keeps everything in the folder, with no outbox", async () => {
  const dir = memDir();
  const a = open(dir);
  await a.ready;
  const id = a.repo.create({ title: "Erste Notiz" });
  await a.repo.saved();
  expect(a.repo.status.pending).toBe(0);
  expect([...dir.files.keys()].some((p) => p.startsWith("updates/"))).toBe(true);

  // opened again (a reload, or another app): all there
  const b = open(dir);
  await b.ready;
  expect(b.repo.get(id)?.title).toBe("Erste Notiz");
});

test("two apps on one folder see each other's changes", async () => {
  const dir = memDir();
  const a = open(dir);
  const b = open(dir);
  await Promise.all([a.ready, b.ready]);
  const x = a.repo.create({ title: "Von A" });
  const y = b.repo.create({ title: "Von B" });
  await Promise.all([a.repo.saved(), b.repo.saved()]);
  await wait(60);
  expect(b.repo.get(x)?.title).toBe("Von A");
  expect(a.repo.get(y)?.title).toBe("Von B");
  // what came from the folder is not written there again
  const count = dir.files.size;
  await wait(60);
  expect(dir.files.size).toBe(count);
});

test("many files are merged into one when the folder is opened", async () => {
  const dir = memDir();
  const a = open(dir);
  await a.ready;
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    ids.push(a.repo.create({ title: `Notiz ${i}` }));
    await a.repo.saved();
  }
  expect((await dir.list("updates")).length).toBeGreaterThan(40);
  const b = open(dir);
  await b.ready;
  await wait(30);
  expect((await dir.list("updates")).length).toBe(1);
  const c = open(dir);
  await c.ready;
  for (const [i, id] of ids.entries()) expect(c.repo.get(id)?.title).toBe(`Notiz ${i}`);
});

test("with a server, changes another app wrote into the folder go to the outbox too", async () => {
  const dir = memDir();
  const synced = open(dir, true);
  const alone = open(dir);
  await Promise.all([synced.ready, alone.ready]);
  synced.repo.create({ title: "Hier" });
  expect(synced.repo.status.pending).toBe(1);
  const id = alone.repo.create({ title: "Aus der anderen App" });
  await alone.repo.saved();
  await wait(60);
  expect(synced.repo.get(id)?.title).toBe("Aus der anderen App");
  expect(synced.repo.status.pending).toBe(2);
});
