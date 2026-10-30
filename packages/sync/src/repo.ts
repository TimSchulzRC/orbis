// A device's full replica of the server's data. Everything lives in memory and in the device's
// storage, so the app works offline; changes go to an outbox and sync when the server is
// reachable. No UI and no platform APIs: storage, the connection to the server and the questions
// to the user come from the platform (RepoHost) – the browser's in @obtion/ui, later the
// desktop and mobile apps' own.
import * as Y from "yjs";
import {
  FORMAT,
  PERSONAL,
  SETTINGS_ID,
  type Item,
  type ItemInit,
  type FreeValue,
  type Value,
  type ViewDef,
  addParent,
  appendUpdate,
  initItem,
  isContent,
  metaMap,
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
} from "@obtion/core/model";
import { Index } from "@obtion/core/graph";
import { initialProps, template, writeProp } from "@obtion/core/traits";
import { deleteItem, resolveCascade, restoreItem } from "@obtion/core/trash";
import type { Writer } from "@obtion/core/setup";
import { keyBetween } from "@obtion/core/sortkey";
import { type ActivityEvent, type ClientMsg, type PushItem, type ServerMsg, fromB64, toB64 } from "@obtion/core/protocol";
import type { ErrorBody, UndoRequest, UndoResult } from "@obtion/core/api";
import { createIndex, indexRecord, searchIds } from "@obtion/core/search";

const REMOTE = Symbol("remote");
/** The areas this device holds. One until teams come (see PERSONAL); the cursor below is its. */
const AREAS = [PERSONAL];
/** An outbox entry: a push item and its area. */
export type OutItem = PushItem & { a?: string };

/** The area of a document (documents from before areas: personal). */
function areaOf(doc: Y.Doc | undefined): string {
  const a = doc && metaMap(doc).get("area");
  return typeof a === "string" ? a : PERSONAL;
}
const LOAD = Symbol("load");
const TAB = Symbol("tab");

/** A stored update of one document; `key` is the storage's own (for compaction). */
export interface StoredRow {
  key?: unknown;
  d: string;
  u: Uint8Array;
}

/**
 * Where the replica keeps its data on the device. Every write is one transaction: it either
 * happens completely or not at all (a reload in between loses nothing).
 */
export interface ReplicaStorage {
  open(): Promise<void>;
  load(): Promise<{ rows: StoredRow[]; outbox: OutItem[]; lastSeq?: number; lastId?: string }>;
  /** Replace a document's stored updates by one merged update. */
  compact(docs: { keys: unknown[]; row: StoredRow }[]): Promise<void>;
  write(w: { rows?: StoredRow[]; outbox?: OutItem[]; acked?: string[]; cursor?: { lastSeq: number; lastId?: string }; serverId?: string }): Promise<void>;
  outbox(): Promise<OutItem[]>;
  serverId(): Promise<string | undefined>;
  /** Delete everything stored. */
  destroy(): Promise<void>;
}

/** The connection to the server's /sync endpoint (a WebSocket). */
export interface SyncSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}
const CONNECTING = 0;
const OPEN = 1;

/** A window of the same app on this device that shares the storage (browser tabs). */
export type TabMsg = { d: string; u: Uint8Array };

/** What the platform gives the replica. */
export interface RepoHost {
  storage: ReplicaStorage;
  /** This device's name, e.g. "Mac-x3f9" (activity, origin of changes). */
  device: string;
  /** Opens a connection to the server's sync endpoint. */
  connect(): SyncSocket;
  /** Sends JSON to the server's API (e.g. "/api/undo"); null when the server cannot be reached. */
  post(path: string, body: unknown): Promise<{ ok: boolean; statusText: string; body: unknown } | null>;
  /** Other windows on this device, if the platform has several. */
  tabs?: { post(msg: TabMsg): void; listen(fn: (msg: TabMsg) => void): void };
  /** Calls fn whenever it is worth trying the server again (back online, app in front). */
  onWake?(fn: () => void): void;
  /** Asks the platform to keep the stored data (browsers may delete it otherwise). */
  persist?(): void;
  /** This device knew another server: upload its copy, replace it with the server's, or no answer. */
  askOtherServer(): Promise<"upload" | "replace" | null>;
  /** Drop changes the server does not have yet? */
  confirmDiscard(count: number): Promise<boolean>;
  /** The data are newer than this app: tell the user (once). */
  tooNew(): void;
  /** Start the app anew (after the replica was replaced). */
  reload(): void;
}

export interface SyncStatus {
  loaded: boolean;
  online: boolean;
  synced: boolean; // initial catch-up done in this session
  pending: number; // local changes not yet acknowledged by the server
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
  device: string;

  private db: ReplicaStorage;
  private ws: SyncSocket | null = null;
  private listeners = new Set<Listener>();
  private eventListeners = new Set<(e: ActivityEvent) => void>();
  private dirty = new Set<string>();
  private searchDirty = new Set<string>();
  private flushScheduled = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private outbox = new Map<string, OutItem>();
  private serverFormat = 0;
  private tooNewShown = false;
  private retry = 0;
  private persistFailed = false;
  private ix: { v: number; index: Index } | null = null;
  private blobListeners = new Set<(hash: string) => void>();

  constructor(private host: RepoHost) {
    this.db = host.storage;
    this.device = host.device;
  }

  // ---------- lifecycle ----------

  async init() {
    await this.db.open();
    this.host.persist?.();
    const { rows, outbox, lastSeq, lastId } = await this.db.load();
    const byDoc = new Map<string, { keys: unknown[]; updates: Uint8Array[] }>();
    for (const v of rows) {
      const e = byDoc.get(v.d) ?? { keys: [], updates: [] };
      e.keys.push(v.key);
      e.updates.push(v.u);
      byDoc.set(v.d, e);
    }
    for (const [id, e] of byDoc) {
      const doc = this.getDoc(id);
      Y.applyUpdate(doc, e.updates.length === 1 ? e.updates[0]! : Y.mergeUpdates(e.updates), LOAD);
    }
    for (const o of outbox) this.outbox.set(o.k, o);
    this.status.lastSeq = lastSeq ?? 0;
    this.lastId = lastId;
    this.status.pending = this.outbox.size;
    for (const id of this.docs.keys()) this.dirty.add(id), this.searchDirty.add(id);
    this.materialize();
    this.reindex();
    this.status.loaded = true;
    this.emit();
    this.compact(byDoc).catch((e) => console.warn("compact failed", e));

    this.host.tabs?.listen((msg) => this.applyFromTab(msg));
    this.connect();
    this.host.onWake?.(() => {
      if (!this.status.online) this.connect();
    });
  }

  /** Merge many small stored updates per doc into one, keeping the device's storage small. */
  private async compact(byDoc: Map<string, { keys: unknown[]; updates: Uint8Array[] }>) {
    const heavy = [...byDoc].filter(([, e]) => e.keys.length > 8);
    if (!heavy.length) return;
    await this.db.compact(heavy.map(([id, e]) => ({ keys: e.keys, row: { d: id, u: Y.encodeStateAsUpdate(this.docs.get(id)!) } })));
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
    const typing = [...tr.changed].every(([t, keys]) => t === body || (t === meta && [...keys].every((k) => k === "updated")));
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
    const area = areaOf(this.docs.get(docId));
    const k = newId();
    const item: OutItem = { k, d: docId, u: toB64(update), s: step, a: area };
    this.outbox.set(k, item);
    this.status.pending = this.outbox.size;
    this.store({ d: docId, u: update }, item);
    this.host.tabs?.post({ d: docId, u: update });
    this.send({ t: "push", area, items: [item] });
  }

  // Everything one tick changed is stored in one transaction: quick to commit, so a reload
  // right after a big change (the setup writes dozens of documents) loses nothing.
  private toStore: { row: StoredRow; out: OutItem }[] = [];
  private storing: Promise<void> | null = null;

  private store(row: StoredRow, out: OutItem) {
    this.toStore.push({ row, out });
    this.storing ??= Promise.resolve().then(() => this.storeNow());
  }

  private async storeNow(): Promise<void> {
    const batch = this.toStore.splice(0);
    try {
      await this.db.write({ rows: batch.map((b) => b.row), outbox: batch.map((b) => b.out) });
    } catch (e) {
      // Not stored locally: stop advancing lastSeq so the server resends this doc later.
      this.persistFailed = true;
      console.error("persist failed", e);
    } finally {
      // what came in meanwhile goes in the next transaction
      this.storing = this.toStore.length ? this.storeNow() : null;
    }
  }

  /** Resolves once every change so far is stored on this device. */
  async saved(): Promise<void> {
    while (this.storing) await this.storing;
  }

  private applyFromTab(msg: TabMsg) {
    Y.applyUpdate(this.getDoc(msg.d), msg.u, TAB);
  }

  // ---------- sync ----------

  connect() {
    if (this.ws && (this.ws.readyState === OPEN || this.ws.readyState === CONNECTING)) return;
    const ws = this.host.connect();
    this.ws = ws;
    let ping: ReturnType<typeof setInterval> | undefined;
    ws.onopen = () => {
      this.retry = 0;
      this.status.online = true;
      this.status.synced = false;
      this.emit();
      // The outbox is pushed after the server's "welcome" was checked (see onMessage).
      for (const area of AREAS) this.send({ t: "hello", area, since: this.status.lastSeq, sinceId: this.lastId, device: this.device });
      ping = setInterval(() => this.send({ t: "ping" }), 25000);
    };
    // Handle messages strictly in order (the server-identity check must finish before updates apply).
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

  /** Push everything in the outbox, including items other (closed) tabs left in the storage. */
  private async flushOutbox() {
    for (const o of await this.db.outbox()) this.outbox.set(o.k, o);
    this.status.pending = this.outbox.size;
    for (const area of AREAS) {
      const items = [...this.outbox.values()].filter((o) => (o.a ?? PERSONAL) === area); // items from before areas: personal
      for (let i = 0; i < items.length; i += 200) this.send({ t: "push", area, items: items.slice(i, i + 200) });
    }
  }

  /** Queue this device's full state for upload. Goes through the durable outbox, so it survives disconnects. */
  private async enqueueFullUpload() {
    const items: OutItem[] = [...this.docs].map(([d, doc]) => ({ k: newId(), d, u: toB64(Y.encodeStateAsUpdate(doc)), a: areaOf(doc) }));
    await this.db.write({ outbox: items });
    for (const it of items) this.outbox.set(it.k, it);
    this.status.pending = this.outbox.size;
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  private serverId: string | undefined;
  /** Id of the server's log row at lastSeq: lets the server notice it was restored from an older backup. */
  private lastId: string | undefined;
  private inbox: Promise<void> = Promise.resolve();

  private async onMessage(msg: ServerMsg) {
    if (msg.t === "denied") return;
    if (msg.t === "welcome") {
      this.serverFormat = msg.format ?? 0;
      const known = this.serverId ?? (await this.db.serverId());
      if (known && known !== msg.hub && this.docs.size > 0) {
        // A different server: mostly it was set up anew and this device's copy is stale (replace it,
        // the recommended answer); rarely it was restored from a backup and misses what only this
        // device has (upload, which adds this copy to the server). Only the user knows.
        const answer = await this.host.askOtherServer();
        // no answer (closed): the safe way, nothing is lost – ask again on the next connection
        if (answer === null) {
          const old = this.ws;
          this.ws = null; // what this connection still sends is dropped (see onmessage)
          old?.close();
          return;
        }
        const upload = answer === "upload";
        if (!upload) {
          await this.db.write({ serverId: msg.hub });
          await this.resetLocal(true);
          return;
        }
        await this.enqueueFullUpload();
        // Our sequence position belongs to the old server: start over against the new one.
        this.status.lastSeq = 0;
        this.lastId = undefined;
        await this.db.write({ cursor: { lastSeq: 0 } });
        this.send({ t: "hello", area: msg.area, since: 0, device: this.device });
      }
      this.serverId = msg.hub;
      if (known !== msg.hub) await this.db.write({ serverId: msg.hub });
      await this.flushOutbox();
      return;
    }
    if (msg.t === "updates") {
      if (msg.reset) {
        // The server lost data (restored from backup?). Give it everything we have.
        await this.enqueueFullUpload();
        await this.flushOutbox();
      }
      const rows: StoredRow[] = [];
      for (const it of msg.items) {
        const u = fromB64(it.u);
        Y.applyUpdate(this.getDoc(it.d), u, REMOTE);
        rows.push({ d: it.d, u });
      }
      try {
        await this.db.write({ rows, cursor: msg.last > 0 && !this.persistFailed ? { lastSeq: msg.last, lastId: msg.lastId } : undefined });
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
      for (const k of msg.keys) this.outbox.delete(k);
      let cursor: { lastSeq: number; lastId?: string } | undefined;
      if (this.status.synced && !this.persistFailed && msg.last > this.status.lastSeq) {
        this.status.lastSeq = msg.last;
        this.lastId = msg.lastId;
        cursor = { lastSeq: msg.last, lastId: msg.lastId };
      }
      await this.db.write({ acked: msg.keys, cursor });
      this.status.pending = this.outbox.size;
      this.emit();
    } else if (msg.t === "blob") {
      for (const l of this.blobListeners) l(msg.hash);
    } else if (msg.t === "event") {
      // Edits by the same author are folded into one event on the server, so replace by id.
      this.events = [msg.event, ...this.events.filter((e) => e.id !== msg.event.id)].slice(0, 100);
      for (const l of this.eventListeners) l(msg.event);
      this.emit();
    }
  }

  /**
   * Take back a step (one user action or tool call) on the server, or redo it. Needs the server:
   * it holds the history. This device's own changes are pushed first, so they are included.
   */
  async undo(step: string, redo = false): Promise<{ ok: true; changed: number; kept: number } | { ok: false; error: string }> {
    await this.flushOutbox();
    const res = await this.host.post("/api/undo", { step, redo, device: this.device } satisfies UndoRequest);
    if (!res) return { ok: false, error: "offline" };
    if (!res.ok) return { ok: false, error: (res.body as Partial<ErrorBody> | null)?.error ?? res.statusText };
    const body = res.body as UndoResult;
    return { ok: true, changed: body.changed.length + body.trashed.length, kept: body.kept.length };
  }

  /**
   * The data (or the server) are newer than this app: it still reads them but does not write – a
   * newer format might be damaged by changes it does not understand (see FORMAT). Reloading
   * brings the new app.
   */
  get readOnly(): boolean {
    return (this.records.get(SETTINGS_ID)?.settings?.format ?? 0) > FORMAT || this.serverFormat > FORMAT;
  }

  /** Drop the local replica and download everything again. */
  async resetLocal(force = false) {
    if (!force && this.outbox.size && !(await this.host.confirmDiscard(this.outbox.size))) return;
    await this.db.destroy();
    this.host.reload();
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
    if (this.readOnly) {
      if (!this.tooNewShown) this.host.tooNew();
      this.tooNewShown = true;
      return;
    }
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
      const wasHome = from && metaMap(doc).get("home") === from;
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

