// Typing goes to the server as a few push items per document and step, not one per keystroke,
// while every keystroke is stored on the device at once (outbox and updates).
import { test, expect, afterAll } from "bun:test";
import { tempDir, removeTempDirs } from "../support/helpers";
import { Store } from "@obtion/server/store";
import { undoStep } from "@obtion/server/undo";
import { FORMAT, PERSONAL, touch } from "@obtion/core/model";
import { fromB64, type ClientMsg, type ServerMsg } from "@obtion/core/protocol";
import { PUSH_DELAY, Repo, type OutItem, type ReplicaStorage, type StoredRow, type SyncSocket } from "@obtion/sync";

afterAll(removeTempDirs);

/** A device's storage in memory, with the same write order as IndexedDB's (puts, then deletes). */
function memStorage() {
  const rows: StoredRow[] = [];
  const outbox = new Map<string, OutItem>();
  const storage: ReplicaStorage = {
    open: async () => {},
    load: async () => ({ rows: [...rows], outbox: [...outbox.values()] }),
    compact: async () => {},
    write: async (w) => {
      rows.push(...(w.rows ?? []));
      for (const o of w.outbox ?? []) outbox.set(o.k, o);
      for (const k of w.acked ?? []) outbox.delete(k);
    },
    outbox: async () => [...outbox.values()],
    drop: async () => {},
    serverId: async () => undefined,
    destroy: async () => {},
  };
  return { storage, rows, outbox };
}

/** A device connected to `store` the way the server's /sync endpoint answers (push → log row, ack). */
async function device(store: Store) {
  const mem = memStorage();
  let pushes = 0;
  const connect = (): SyncSocket => {
    const ws: SyncSocket = {
      readyState: 0,
      send(data) {
        const msg = JSON.parse(data) as ClientMsg;
        const reply = (m: ServerMsg) => queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify(m) }));
        if (msg.t === "hello") {
          const last = store.last(msg.area);
          reply({ t: "welcome", server: store.serverId, area: msg.area, seq: last.seq, format: FORMAT });
          reply({ t: "updates", area: msg.area, items: [], last: last.seq, lastId: last.uid || undefined, initial: true, done: true });
        } else if (msg.t === "push") {
          pushes += msg.items.length;
          for (const it of msg.items) store.applyRemote(it.d, fromB64(it.u), "web:test", ws, it.s, msg.area);
          const last = store.last(msg.area ?? PERSONAL);
          reply({ t: "ack", area: msg.area ?? PERSONAL, keys: msg.items.map((it) => it.k), last: last.seq, lastId: last.uid || undefined });
        }
      },
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    queueMicrotask(() => {
      (ws as { readyState: number }).readyState = 1;
      ws.onopen?.();
    });
    return ws;
  };
  const repo = new Repo({
    storage: mem.storage,
    device: "test",
    connect,
    post: async () => null,
    askOtherServer: async () => null,
    confirmDiscard: async () => false,
    tooNew() {},
    reload() {},
  });
  await repo.init();
  while (!repo.status.synced) await sleep(1);
  return { repo, mem, pushes: () => pushes };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = (s: Store) => (s.db.query("SELECT count(*) AS n FROM updates").get() as { n: number }).n;

/** One keystroke: a character at the end of the body, the change date with it (like the editor). */
function type(repo: Repo, id: string, ch: string) {
  repo.change(id, (doc) => {
    const body = doc.getText("body");
    body.insert(body.length, ch);
    touch(doc);
  });
}

async function settle(repo: Repo) {
  await sleep(PUSH_DELAY + 50);
  await repo.saved();
  while (repo.status.pending) await sleep(5);
}

test("typing is pushed as one item per push delay; every keystroke is stored at once", async () => {
  const store = new Store(tempDir("obtion-typing-"));
  const { repo, mem, pushes } = await device(store);
  const id = repo.create({ title: "Notiz" });
  await settle(repo);
  const before = rows(store);

  const text = "Hallo Welt, das ist ein Absatz.";
  for (const ch of text) {
    type(repo, id, ch);
    await repo.saved();
    // stored on the device right away: a reload now loses nothing
    expect(mem.outbox.size).toBeGreaterThan(0);
  }
  expect(mem.rows.length).toBeGreaterThanOrEqual(text.length);
  await settle(repo);

  expect(rows(store) - before).toBe(1);
  expect(pushes()).toBe(2); // the creation, then the paragraph
  store.flush();
  expect(store.records.get(id)!.body).toBe(text);
  expect(mem.outbox.size).toBe(0);
});

test("updates of different steps or documents are never merged; undo pushes what is unsent", async () => {
  const store = new Store(tempDir("obtion-typing-"));
  const { repo } = await device(store);
  const a = repo.create({ title: "A" });
  const b = repo.create({ title: "B" });
  await settle(repo);
  const before = rows(store);

  // one action per tick (changes in one tick are one step)
  for (const act of [() => type(repo, a, "x"), () => type(repo, a, "y"), () => type(repo, b, "z"), () => repo.setTitle(a, "A2"), () => type(repo, a, "w")]) {
    act();
    await sleep(1);
  }
  await settle(repo);
  store.flush();
  expect(rows(store) - before).toBe(4);
  const steps = store.db.query("SELECT step FROM updates ORDER BY seq DESC LIMIT 4").all() as { step: string }[];
  expect(new Set(steps.map((s) => s.step)).size).toBe(4);
  expect(store.records.get(a)!.body).toBe("xyw");
  expect(store.records.get(a)!.title).toBe("A2");

  // undo pushes the outbox before it asks the server, without waiting for the push delay
  type(repo, a, "!");
  const n = rows(store);
  await repo.undo("s-none");
  expect(rows(store)).toBe(n + 1);
});

test("a flush before the push delay keeps a later step behind the typing it builds on", async () => {
  const store = new Store(tempDir("obtion-typing-"));
  const { repo } = await device(store);
  const id = repo.create({ title: "A" });
  await settle(repo);
  type(repo, id, "x");
  await sleep(1);
  type(repo, id, "y");
  await sleep(1);
  repo.setTitle(id, "B");
  await repo.undo("s-none"); // flushes the outbox at once
  await settle(repo);
  store.flush();
  const last = store.db.query("SELECT step FROM updates ORDER BY seq DESC LIMIT 1").get() as { step: string };
  expect(store.records.get(id)!.title).toBe("B");
  undoStep(store, last.step, "web:test");
  store.flush();
  expect(store.records.get(id)!.title).toBe("A");
  expect(store.records.get(id)!.body).toBe("xy");
});

test("changes other than typing go to the server without the delay", async () => {
  const store = new Store(tempDir("obtion-typing-"));
  const { repo } = await device(store);
  const id = repo.create({ title: "A" });
  await sleep(5);
  repo.setTitle(id, "B");
  await sleep(5);
  store.flush();
  expect(store.records.get(id)!.title).toBe("B");
  // a step of its own (e.g. a version brought back) is no typing either
  repo.ownStep(() => repo.setBody(id, "restored"));
  await sleep(5);
  store.flush();
  expect(store.records.get(id)!.body).toBe("restored");
});

test("a reload before the push finds every keystroke in the stored outbox", async () => {
  const store = new Store(tempDir("obtion-typing-"));
  const first = await device(store);
  const id = first.repo.create({ title: "Notiz" });
  await settle(first.repo);
  for (const ch of "abc") type(first.repo, id, ch);
  await first.repo.saved();
  const stored = [...first.mem.outbox.values()];
  expect(stored.length).toBe(3);
  // what a fresh start would push: the three updates bring the text
  for (const o of stored) store.applyRemote(o.d, fromB64(o.u), "web:test", undefined, o.s);
  store.flush();
  expect(store.records.get(id)!.body).toBe("abc");
  await settle(first.repo);
});

test("a title typed key by key, every key its own step and push, is one entry in the history", async () => {
  const store = new Store(tempDir("obtion-typing-"));
  const { repo } = await device(store);
  const id = repo.create({ title: "" });
  await settle(repo);
  for (const title of ["F", "Fr", "Fri", "Fritz", "Fritzme", "Fritzmeier"]) {
    repo.setTitle(id, title);
    await settle(repo);
    store.flush();
  }
  const steps = store.db.query("SELECT DISTINCT step FROM updates WHERE doc = ?").all(id);
  expect(steps.length).toBe(7); // the creation and six keys
  const events = store.events({ doc: id });
  expect(events.length).toBe(1);
  expect(events[0]!.changes).toEqual([{ field: "title", from: "", to: "Fritzmeier" }]);
});
