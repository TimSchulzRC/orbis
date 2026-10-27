// The browser's full local replica. All data lives in IndexedDB and memory, so
// the app works offline; changes go to an outbox and sync when the hub is
// reachable. The same class is meant to back the future desktop/mobile apps.
import * as Y from "yjs";
import { openDB, type IDBPDatabase } from "idb";
import {
  type Item,
  type ItemInit,
  type FreeValue,
  type Value,
  type ViewDef,
  addParent,
  appendUpdate,
  initItem,
  isContent,
  newId,
  readItem,
  removeParent,
  replaceBody,
  setExtra,
  setHome,
  setMember,
  setMeta,
  setParentSort,
  setProp,
  setRel,
  setView,
  touch,
} from "../shared/model";
import { Index } from "../shared/graph";
import { initialProps, template, writeProp } from "../shared/traits";
import { deleteItem, resolveCascade, restoreItem } from "../shared/trash";
import type { Writer } from "../shared/setup";
import { keyBetween } from "../shared/sortkey";
import { type ActivityEvent, type ClientMsg, type ServerMsg, fromB64, toB64 } from "../shared/protocol";
import { createIndex, indexRecord, searchIds } from "../shared/search";
import { tr } from "./i18n";

const REMOTE = Symbol("remote");
const LOAD = Symbol("load");
const TAB = Symbol("tab");

export interface SyncStatus {
  loaded: boolean;
  online: boolean;
  synced: boolean; // initial catch-up done in this session
  pending: number; // local changes not yet acknowledged by the hub
  lastSeq: number;
}

type Listener = () => void;

export class Repo {
  docs = new Map<string, Y.Doc>();
  records = new Map<string, Item>();
  version = 0;
  status: SyncStatus = { loaded: false, online: false, synced: false, pending: 0, lastSeq: 0 };
  searchIndex = createIndex();
  events: ActivityEvent[] = [];
  device = deviceName();

  private db!: IDBPDatabase;
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private eventListeners = new Set<(e: ActivityEvent) => void>();
  private dirty = new Set<string>();
  private searchDirty = new Set<string>();
  private flushScheduled = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private outbox = new Map<string, { k: string; d: string; u: string; s?: string }>();
  private bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("obtion") : null;
  private retry = 0;
  private persistFailed = false;
  private ix: { v: number; index: Index } | null = null;
  private blobListeners = new Set<(hash: string) => void>();

  // ---------- lifecycle ----------

  async init() {
    this.db = await openDB("obtion", 1, {
      // Another tab wants to delete/upgrade the database (e.g. "re-download everything"): step aside.
      blocking: () => {
        this.db.close();
        location.reload();
      },
      upgrade(db) {
        db.createObjectStore("updates", { autoIncrement: true });
        db.createObjectStore("outbox", { keyPath: "k" });
        db.createObjectStore("meta");
      },
    });
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    const tx = this.db.transaction(["updates", "outbox", "meta"]);
    const [keys, values, outbox, lastSeq, lastId] = await Promise.all([
      tx.objectStore("updates").getAllKeys(),
      tx.objectStore("updates").getAll(),
      tx.objectStore("outbox").getAll(),
      tx.objectStore("meta").get("lastSeq"),
      tx.objectStore("meta").get("lastId"),
    ]);
    const byDoc = new Map<string, { keys: IDBValidKey[]; updates: Uint8Array[] }>();
    values.forEach((v: { d: string; u: Uint8Array }, i) => {
      const e = byDoc.get(v.d) ?? { keys: [], updates: [] };
      e.keys.push(keys[i]!);
      e.updates.push(v.u);
      byDoc.set(v.d, e);
    });
    for (const [id, e] of byDoc) {
      const doc = this.getDoc(id);
      Y.applyUpdate(doc, e.updates.length === 1 ? e.updates[0]! : Y.mergeUpdates(e.updates), LOAD);
    }
    for (const o of outbox) this.outbox.set(o.k, o);
    this.status.lastSeq = (lastSeq as number) ?? 0;
    this.lastId = (lastId as string | undefined) ?? undefined;
    this.status.pending = this.outbox.size;
    for (const id of this.docs.keys()) this.dirty.add(id), this.searchDirty.add(id);
    this.materialize();
    this.reindex();
    this.status.loaded = true;
    this.emit();
    this.compact(byDoc).catch((e) => console.warn("compact failed", e));

    if (this.bc) this.bc.onmessage = (ev) => this.applyFromTab(ev.data);
    this.connect();
    window.addEventListener("online", () => this.connect());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.status.online) this.connect();
    });
  }

  /** Merge many small stored updates per doc into one, keeping IndexedDB small. */
  private async compact(byDoc: Map<string, { keys: IDBValidKey[]; updates: Uint8Array[] }>) {
    const heavy = [...byDoc].filter(([, e]) => e.keys.length > 8);
    if (!heavy.length) return;
    const tx = this.db.transaction("updates", "readwrite");
    for (const [id, e] of heavy) {
      for (const k of e.keys) tx.store.delete(k);
      tx.store.add({ d: id, u: Y.encodeStateAsUpdate(this.docs.get(id)!) });
    }
    await tx.done;
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;

  onEvent(l: (e: ActivityEvent) => void) {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  }

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ---------- docs ----------

  getDoc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (doc) return doc;
    doc = new Y.Doc({ guid: id });
    this.docs.set(id, doc);
    doc.on("update", (update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
      if (origin === LOAD) return;
      if (origin === TAB) {
        this.touch(id);
        return;
      }
      // Remote updates are persisted in bulk by the sync handler.
      if (origin !== REMOTE) this.local(id, update, this.stepFor(id, tr));
      this.touch(id);
    });
    return doc;
  }

  private touch(id: string) {
    this.dirty.add(id);
    this.searchDirty.add(id);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        this.materialize();
        this.emit();
      });
    }
    if (!this.searchTimer) this.searchTimer = setTimeout(() => this.reindex(), 400);
  }

  private materialize() {
    for (const id of this.dirty) {
      const rec = readItem(id, this.docs.get(id)!);
      if (rec) this.records.set(id, rec);
    }
    this.dirty.clear();
    // Cascaded deletes follow their root; items that flip need a new search entry.
    const before = new Map([...this.records.values()].filter((r) => r.deletedVia).map((r) => [r.id, r]));
    resolveCascade(this.records);
    for (const [id, r] of before) if (this.records.get(id) !== r) this.searchDirty.add(id);
  }

  private reindex() {
    this.searchTimer = null;
    for (const id of this.searchDirty) {
      const r = this.records.get(id);
      if (r) indexRecord(this.searchIndex, r);
    }
    this.searchDirty.clear();
  }

  // ---------- steps ----------
  // One user action = one step = one undo unit. Changes in the same tick belong together
  // (a delete with its cascade, a rename with its links); typing into one text continues
  // its step while the pauses stay under two minutes.
  private curStep: { id: string; at: number; doc: string; typing: boolean } | null = null;
  private sameTick = false;

  private stepFor(docId: string, tr: Y.Transaction): string {
    const doc = tr.doc;
    const body: unknown = doc.getText("body");
    const meta: unknown = doc.getMap("meta");
    const typing = [...tr.changed.keys()].every((t: unknown) => t === body || (t === meta && [...tr.changed.get(t as Y.AbstractType<any>)!].every((k) => k === "updated")));
    const now = Date.now();
    const c = this.curStep;
    const goOn = c && (this.sameTick || (typing && c.typing && c.doc === docId && now - c.at < 120_000));
    if (!goOn) this.curStep = { id: "s" + newId(), at: now, doc: docId, typing };
    else c.at = now;
    if (!this.sameTick) {
      this.sameTick = true;
      queueMicrotask(() => (this.sameTick = false));
    }
    if (this.curStep!.doc !== docId) this.curStep!.typing = false;
    return this.curStep!.id;
  }

  private local(docId: string, update: Uint8Array, step?: string) {
    const k = newId();
    const item = { k, d: docId, u: toB64(update), s: step };
    this.outbox.set(k, item);
    this.status.pending = this.outbox.size;
    const tx = this.db.transaction(["updates", "outbox"], "readwrite");
    tx.objectStore("updates").add({ d: docId, u: update });
    tx.objectStore("outbox").put(item);
    tx.done.catch((e) => {
      // Not stored locally: stop advancing lastSeq so the hub resends this doc later.
      this.persistFailed = true;
      console.error("persist failed", e);
    });
    this.bc?.postMessage({ d: docId, u: update });
    this.send({ t: "push", items: [item] });
  }

  private applyFromTab(msg: { d: string; u: Uint8Array }) {
    Y.applyUpdate(this.getDoc(msg.d), msg.u, TAB);
  }

  // ---------- sync ----------

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/sync`);
    this.ws = ws;
    let ping: ReturnType<typeof setInterval> | undefined;
    ws.onopen = () => {
      this.retry = 0;
      this.status.online = true;
      this.status.synced = false;
      this.emit();
      // The outbox is pushed after the hub's "welcome" was checked (see onMessage).
      this.send({ t: "hello", since: this.status.lastSeq, sinceId: this.lastId, client: this.device, device: this.device });
      ping = setInterval(() => this.send({ t: "ping" }), 25000);
    };
    // Handle messages strictly in order (the hub-identity check must finish before updates apply).
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMsg;
      this.inbox = this.inbox.then(() => (this.ws === ws ? this.onMessage(msg) : undefined)).catch((e) => console.error("sync message failed", e));
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (this.ws === ws) this.ws = null;
      this.status.online = false;
      this.emit();
      const delay = Math.min(30000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  /** Push everything in the outbox, including items other (closed) tabs left in IndexedDB. */
  private async flushOutbox() {
    for (const o of (await this.db.getAll("outbox")) as { k: string; d: string; u: string; s?: string }[]) this.outbox.set(o.k, o);
    this.status.pending = this.outbox.size;
    const items = [...this.outbox.values()];
    for (let i = 0; i < items.length; i += 200) this.send({ t: "push", items: items.slice(i, i + 200) });
  }

  /** Queue this device's full state for upload. Goes through the durable outbox, so it survives disconnects. */
  private async enqueueFullUpload() {
    const items = [...this.docs].map(([d, doc]) => ({ k: newId(), d, u: toB64(Y.encodeStateAsUpdate(doc)) }));
    const tx = this.db.transaction("outbox", "readwrite");
    for (const it of items) tx.store.put(it);
    await tx.done;
    for (const it of items) this.outbox.set(it.k, it);
    this.status.pending = this.outbox.size;
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private hubId: string | undefined;
  /** Id of the hub's log row at lastSeq: lets the hub notice it was restored from an older backup. */
  private lastId: string | undefined;
  private inbox: Promise<void> = Promise.resolve();

  private async onMessage(msg: ServerMsg) {
    if (msg.t === "welcome") {
      const known = this.hubId ?? ((await this.db.get("meta", "hubId")) as string | undefined);
      if (known && known !== msg.hub && this.docs.size > 0) {
        // A different hub: mostly it was set up anew and this device's copy is stale (replace it,
        // the recommended answer); rarely it was restored from a backup and misses what only this
        // device has (upload, which adds this copy to the hub). Only the user knows.
        const { chooseAction } = await import("./ui/feedback");
        const answer = await chooseAction({
          title: tr("sync.otherHub.title"),
          body: tr("sync.otherHub.body"),
          choices: [
            { key: "upload", label: tr("sync.otherHub.upload") },
            { key: "replace", label: tr("sync.otherHub.replace"), primary: true },
          ],
        });
        // no answer (closed): the safe way, nothing is lost – ask again on the next connection
        if (answer === null) {
          const old = this.ws;
          this.ws = null; // what this connection still sends is dropped (see onmessage)
          old?.close();
          return;
        }
        const upload = answer === "upload";
        if (!upload) {
          await this.db.put("meta", msg.hub, "hubId");
          await this.resetLocal(true);
          return;
        }
        await this.enqueueFullUpload();
        // Our sequence position belongs to the old hub: start over against the new one.
        this.status.lastSeq = 0;
        this.lastId = undefined;
        await this.db.put("meta", 0, "lastSeq");
        await this.db.delete("meta", "lastId");
        this.send({ t: "hello", since: 0, client: this.device, device: this.device });
      }
      this.hubId = msg.hub;
      if (known !== msg.hub) await this.db.put("meta", msg.hub, "hubId");
      await this.flushOutbox();
      return;
    }
    if (msg.t === "updates") {
      if (msg.reset) {
        // The hub lost data (restored from backup?). Give it everything we have.
        await this.enqueueFullUpload();
        await this.flushOutbox();
      }
      const rows: { d: string; u: Uint8Array }[] = [];
      for (const it of msg.items) {
        const u = fromB64(it.u);
        Y.applyUpdate(this.getDoc(it.d), u, REMOTE);
        rows.push({ d: it.d, u });
      }
      const tx = this.db.transaction(["updates", "meta"], "readwrite");
      for (const r of rows) tx.objectStore("updates").add(r);
      if (msg.last > 0 && !this.persistFailed) {
        tx.objectStore("meta").put(msg.last, "lastSeq");
        if (msg.lastId) tx.objectStore("meta").put(msg.lastId, "lastId");
        else tx.objectStore("meta").delete("lastId");
      }
      try {
        await tx.done;
      } catch (e) {
        // Never advance past updates we could not store; the next connect re-fetches them.
        this.persistFailed = true;
        console.error("could not store updates", e);
      }
      if (msg.last > 0 && !this.persistFailed) {
        this.status.lastSeq = msg.last;
        this.lastId = msg.lastId;
      }
      if (msg.done || !msg.initial) this.status.synced = true;
      this.emit();
    } else if (msg.t === "ack") {
      const tx = this.db.transaction(["outbox", "meta"], "readwrite");
      for (const k of msg.keys) {
        this.outbox.delete(k);
        tx.objectStore("outbox").delete(k);
      }
      if (this.status.synced && !this.persistFailed && msg.last > this.status.lastSeq) {
        this.status.lastSeq = msg.last;
        this.lastId = msg.lastId;
        tx.objectStore("meta").put(msg.last, "lastSeq");
        if (msg.lastId) tx.objectStore("meta").put(msg.lastId, "lastId");
        else tx.objectStore("meta").delete("lastId");
      }
      await tx.done;
      this.status.pending = this.outbox.size;
      this.emit();
    } else if (msg.t === "blob") {
      for (const l of this.blobListeners) l(msg.hash);
    } else if (msg.t === "event") {
      // Edits by the same author are folded into one event on the hub, so replace by id.
      this.events = [msg.event, ...this.events.filter((e) => e.id !== msg.event.id)].slice(0, 100);
      for (const l of this.eventListeners) l(msg.event);
      this.emit();
    }
  }

  /**
   * Take back a step (one user action or tool call) on the hub, or redo it. Needs the hub:
   * it holds the history. This device's own changes are pushed first, so they are included.
   */
  async undo(step: string, redo = false): Promise<{ ok: true; changed: number; kept: number } | { ok: false; error: string }> {
    await this.flushOutbox();
    const res = await fetch("/api/undo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step, redo, device: this.device }) }).catch(() => null);
    if (!res) return { ok: false, error: "offline" };
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error ?? res.statusText };
    return { ok: true, changed: body.changed.length + body.trashed.length, kept: body.kept.length };
  }

  /** Drop the local replica and download everything again. */
  async resetLocal(force = false) {
    if (!force && this.outbox.size) {
      const { chooseAction } = await import("./ui/feedback");
      const ok = await chooseAction({ title: tr("sync.unsynced.title"), body: tr("sync.unsynced.body", { count: this.outbox.size }), choices: [{ key: "yes", label: tr("sync.unsynced.confirm"), danger: true }] });
      if (ok !== "yes") return;
    }
    this.db.close();
    await new Promise((res) => {
      const r = indexedDB.deleteDatabase("obtion");
      r.onsuccess = r.onerror = r.onblocked = res;
    });
    location.reload();
  }

  onBlob(l: (hash: string) => void) {
    this.blobListeners.add(l);
    return () => this.blobListeners.delete(l);
  }

  // ---------- queries ----------

  get(id?: string | null): Item | undefined {
    return id ? this.records.get(id) : undefined;
  }

  live(): Item[] {
    return [...this.records.values()].filter(isContent);
  }

  /** Structure, titles, links, aggregation – rebuilt lazily when data changed. */
  index(): Index {
    if (this.ix?.v !== this.version) this.ix = { v: this.version, index: new Index(this.records) };
    return this.ix.index;
  }

  resolveTitle = (title: string) => this.index().resolveTitle(title);

  search(q: string, limit = 30): Item[] {
    this.reindex();
    return searchIds(this.searchIndex, q, limit)
      .map((id) => this.records.get(id)!)
      .filter((r) => r && isContent(r));
  }

  // ---------- mutations ----------

  /** Run a change on one document (the generic way; everything else builds on it). */
  change(id: string, fn: (doc: Y.Doc) => void) {
    const doc = this.getDoc(id);
    doc.transact(() => fn(doc));
  }

  /** Writer for shared bulk operations (setup, type operations). */
  writer: Writer = {
    change: (id, fn) => this.change(id, fn),
    get: (id) => this.records.get(id),
  };

  create(init: ItemInit, id = newId()): string {
    const schema = init.type ? this.records.get(init.type)?.schema : undefined;
    const props = { ...initialProps(schema), ...(init.props ?? {}) };
    const tpl = template(schema)?.body;
    this.change(id, (doc) => initItem(doc, { createdBy: `web:${this.device}`, ...init, props, body: init.body ?? (tpl || undefined) }));
    return id;
  }

  setTitle(id: string, title: string) {
    const prev = this.records.get(id);
    const ownsTitle = !!prev && prev.title.trim() !== "" && this.resolveTitle(prev.title) === id;
    this.change(id, (doc) => setMeta(doc, { title }));
    if (ownsTitle && prev!.title !== title) this.renameLinks(prev!.title, title);
  }

  /** Give an information a type (or none). New type: template values and first status apply. Files have no type. */
  setType(id: string, type: string | null) {
    const item = this.records.get(id);
    if (!item || item.kind !== "info" || item.type === type) return;
    const schema = type ? this.records.get(type)?.schema : undefined;
    this.change(id, (doc) => {
      setMeta(doc, { type });
      for (const [k, v] of Object.entries(initialProps(schema))) if (item.props[k] === undefined) setProp(doc, k, v);
    });
  }

  /** Add a parent. Refuses (returns false) if it would create a cycle. */
  addParent(id: string, parent: string, sort?: string): boolean {
    if (this.index().wouldCycle(id, parent)) return false;
    this.change(id, (doc) => {
      addParent(doc, parent, sort);
      touch(doc);
    });
    return true;
  }
  removeParent(id: string, parent: string) {
    this.change(id, (doc) => {
      removeParent(doc, parent);
      touch(doc);
    });
  }
  /** Move: replace the parent you came from (drag). */
  moveParent(id: string, from: string | null, to: string, sort?: string): boolean {
    if (this.index().wouldCycle(id, to)) return false;
    this.change(id, (doc) => {
      const wasHome = from && doc.getMap<any>("meta").get("home") === from;
      addParent(doc, to, sort);
      if (from && from !== to) removeParent(doc, from);
      if (wasHome) setHome(doc, to);
      touch(doc);
    });
    return true;
  }
  setHome(id: string, parent: string) {
    this.change(id, (doc) => setHome(doc, parent));
  }
  /** Order below a parent, or (parent null) the position among pinned items. */
  setSort(id: string, parent: string | null, sort: string) {
    this.change(id, (doc) => (parent ? setParentSort(doc, parent, sort) : setMeta(doc, { pinned: sort })));
  }

  /** Pin to the top of the sidebar (after everything pinned) or unpin. Pinned counts as a place. */
  pin(id: string, on: boolean) {
    const last = this.live().map((i) => i.pinned).filter(Boolean).sort().at(-1) ?? null;
    this.change(id, (doc) => setMeta(doc, { pinned: on ? keyBetween(last, null) : null }));
  }

  setProp(id: string, propId: string, value: Value | null) {
    const schema = this.index().schemaOf(this.records.get(id));
    this.change(id, (doc) => {
      writeProp(doc, schema, propId, value);
      touch(doc);
    });
  }
  setExtra(id: string, name: string, value: FreeValue | null) {
    this.change(id, (doc) => {
      setExtra(doc, name, value);
      touch(doc);
    });
  }
  setRel(id: string, propId: string, target: string, on: boolean) {
    this.change(id, (doc) => {
      setRel(doc, propId, target, on);
      touch(doc);
    });
  }
  setMember(id: string, set: "tags" | "refs", key: string, on: boolean) {
    this.change(id, (doc) => {
      setMember(doc, set, key, on);
      touch(doc);
    });
  }
  setBody(id: string, body: string) {
    this.change(id, (doc) => replaceBody(doc, body));
  }
  setView(id: string, viewId: string, def: ViewDef | null) {
    this.change(id, (doc) => setView(doc, viewId, def));
  }

  /** Dated update, optionally with a status change (option id of the status property). */
  addUpdate(id: string, text: string, status?: { prop: string; option: string }) {
    const schema = this.index().schemaOf(this.records.get(id));
    const at = Date.now();
    this.change(id, (doc) => {
      appendUpdate(doc, { at, text, by: "you", status: status?.option });
      if (status) writeProp(doc, schema, status.prop, status.option, at);
      touch(doc);
    });
  }

  /** To the trash. Children that hang only here go along, or with "inbox" lose this place. */
  remove(id: string, children: "trash" | "inbox" = "trash") {
    deleteItem(this.writer, this.index(), id, children);
  }
  /** Back from the trash, together with exactly what was deleted with it. */
  restore(id: string) {
    restoreItem(this.writer, this.records, id);
  }

  /** Keep [[links]] pointing at a renamed item. */
  renameLinks(oldTitle: string, newTitle: string) {
    if (!newTitle.trim()) return;
    const esc = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(!?\\[\\[)${esc}(?=[\\]|#])`, "gi");
    for (const r of this.live()) {
      if (!r.body.includes("[[")) continue;
      re.lastIndex = 0;
      if (!re.test(r.body)) continue;
      re.lastIndex = 0;
      this.setBody(r.id, r.body.replace(re, (_m, open: string) => open + newTitle));
    }
  }
}

function deviceName(): string {
  const saved = localStorage.getItem("obtion.device");
  if (saved) return saved;
  const ua = navigator.userAgent;
  const name = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser";
  const full = `${name}-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem("obtion.device", full);
  return full;
}

export const repo = new Repo();
