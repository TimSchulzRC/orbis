// A device's start: documents compacted with their record are not decoded until used.
import { test, expect } from "bun:test";
import { Repo, type ReplicaStorage, type StoredRow } from "@obtion/sync";
import { RECORD_VERSION } from "@obtion/core/model";

/** Keeps its rows across repos, like IndexedDB across reloads. */
function memoryStorage(): { rows: StoredRow[]; storage: ReplicaStorage } {
  let next = 0;
  const s: { rows: StoredRow[]; storage: ReplicaStorage } = {
    rows: [],
    storage: {
      open: async () => {},
      load: async () => ({ rows: s.rows.map((r) => ({ ...r })), outbox: [] }),
      compact: async (docs) => {
        const gone = new Set(docs.flatMap((d) => d.keys));
        s.rows = [...s.rows.filter((r) => !gone.has(r.key)), ...docs.map((d) => ({ ...d.row, key: next++ }))];
      },
      write: async (w) => {
        for (const r of w.rows ?? []) s.rows.push({ d: r.d, u: r.u, key: next++ });
      },
      outbox: async () => [],
      drop: async (ids) => void (s.rows = s.rows.filter((r) => !ids.includes(r.d))),
      serverId: async () => undefined,
      destroy: async () => {},
    },
  };
  return s;
}

async function start(storage: ReplicaStorage) {
  const repo = new Repo({
    storage,
    device: "test",
    connect: () => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    post: async () => null,
    askOtherServer: async () => null,
    confirmDiscard: async () => false,
    tooNew() {},
    reload() {},
  });
  await repo.init();
  await Bun.sleep(0); // compaction
  return repo;
}

test("a start decodes only documents changed since the last one", async () => {
  const mem = memoryStorage();
  const first = await start(mem.storage);
  const a = first.create({ title: "A", body: "one" });
  const b = first.create({ title: "B", body: "two" });
  await first.saved();

  const second = await start(mem.storage); // rows without records: every document is read once
  expect(second.docs.size).toBe(2);
  expect(mem.rows.every((r) => r.r?.v === RECORD_VERSION)).toBe(true);
  second.setBody(b, "two, changed");
  await second.saved();

  const third = await start(mem.storage);
  expect([...third.docs.keys()]).toEqual([b]);
  expect(third.get(a)?.body).toBe("one");
  expect(third.get(b)?.body).toBe("two, changed");
  expect(third.search("one").map((r) => r.id)).toEqual([a]);
  // the document is read on first use, and changes to it are kept
  third.setBody(a, "one, changed");
  expect(third.getDoc(a).getText("body").toString()).toBe("one, changed");
  expect(third.get(a)?.title).toBe("A");
  await third.saved();
  const fourth = await start(mem.storage);
  expect(fourth.get(a)?.body).toBe("one, changed");
});

test("records from another RECORD_VERSION are read anew", async () => {
  const mem = memoryStorage();
  const first = await start(mem.storage);
  const a = first.create({ title: "A" });
  await first.saved();
  await start(mem.storage);
  mem.rows = mem.rows.map((r) => ({ ...r, r: { v: RECORD_VERSION - 1, item: { ...r.r!.item!, title: "old" } } }));
  const again = await start(mem.storage);
  expect(again.get(a)?.title).toBe("A");
});

test("a purge drops a document that was never decoded, and it stays gone", async () => {
  const mem = memoryStorage();
  const first = await start(mem.storage);
  const a = first.create({ title: "A", body: "geheim" });
  await first.saved();
  await start(mem.storage);
  const repo = await start(mem.storage);
  expect(repo.docs.has(a)).toBe(false); // waits undecoded
  await (repo as unknown as { drop(ids: string[]): Promise<void> }).drop([a]);
  expect(repo.get(a)).toBeUndefined();
  expect(repo.getDoc(a).getText("body").toString()).toBe("");
  expect(mem.rows.some((r) => r.d === a)).toBe(false);
});
