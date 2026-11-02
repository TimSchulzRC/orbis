// A device's full offline replica of the server's data. Platform-free: storage, the server
// connection and questions to the user come from the RepoHost.
import * as Y from "yjs";
import {
  FORMAT,
  PERSONAL,
  areaOf,
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
  renameLinksIn,
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
  setRules,
  setView,
  touch,
} from "@obtion/core/model";
import { Index } from "@obtion/core/graph";
import { initialProps, template, writeProp } from "@obtion/core/traits";
import { deleteItem, resolveCascade, restoreItem } from "@obtion/core/trash";
import type { Writer } from "@obtion/core/setup";
import { nextPinKey } from "@obtion/core/sortkey";
import { type ActivityEvent, type ClientMsg, type PushItem, type ServerMsg, fromB64, toB64 } from "@obtion/core/protocol";
import type { UndoRequest } from "@obtion/core/api";
import { createIndex, indexRecord, searchIds } from "@obtion/core/search";
import { type Person, personOrigin } from "@obtion/core/origin";

const REMOTE = Symbol("remote");
/** One area until teams come; the single sync cursor belongs to it. */
const AREAS = [PERSONAL];
export type OutItem = PushItem & { a?: string };

const LOAD = Symbol("load");
const TAB = Symbol("tab");

const COMPACT_AFTER_ROWS = 8;
const SEARCH_DEBOUNCE_MS = 400;
/** Typing into the same text continues its undo step while pauses stay shorter than this. */
const TYPING_STEP_GAP_MS = 120_000;
const PING_MS = 25_000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
const PUSH_BATCH = 200;
const MAX_EVENTS = 100;

/** `key` is the storage's own, used for compaction. */
export interface StoredRow {
  key?: unknown;
  d: string;
  u: Uint8Array;
}

/** Every write must be atomic, so a reload in between loses nothing. */
export interface ReplicaStorage {
  open(): Promise<void>;
  load(): Promise<{ rows: StoredRow[]; outbox: OutItem[]; lastSeq?: number; lastId?: string }>;
  compact(docs: { keys: unknown[]; row: StoredRow }[]): Promise<void>;
  write(w: { rows?: StoredRow[]; outbox?: OutItem[]; acked?: string[]; cursor?: { lastSeq: number; lastId?: string }; serverId?: string }): Promise<void>;
  outbox(): Promise<OutItem[]>;
  serverId(): Promise<string | undefined>;
  destroy(): Promise<void>;
}

/** A WebSocket to the server's /sync endpoint. */
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

export type TabMsg = { d: string; u: Uint8Array };

export interface RepoHost {
  storage: ReplicaStorage;
  /** e.g. "Mac-x3f9"; recorded with its changes, never shown. */
  device: string;
  person?: Person;
  connect(): SyncSocket;
  /** null when the server cannot be reached. */
  post(path: string, body: unknown): Promise<{ ok: boolean; statusText: string; body: unknown } | null>;
  /** Other windows of the app on this device that share the storage (browser tabs). */
  tabs?: { post(msg: TabMsg): void; listen(fn: (msg: TabMsg) => void): void };
  /** Calls fn when it is worth trying the server again (back online, app in front). */
  onWake?(fn: () => void): void;
  /** Browsers may evict stored data unless asked to persist it. */
  persist?(): void;
  /** This device knew another server. null means no answer. */
  askOtherServer(): Promise<"upload" | "replace" | null>;
  confirmDiscard(count: number): Promise<boolean>;
  /** The data are newer than this app; called once. */
  tooNew(): void;
  /** Called after the replica was replaced. */
  reload(): void;
}

export interface SyncStatus {
  loaded: boolean;
  online: boolean;
  synced: boolean; // initial catch-up done in this session
  pending: number; // local changes not yet acked
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
  readonly device: string;

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

  /** e.g. "web:Tim;u=…;d=Mac-x3f9" */
  get origin(): string {
    return this.host.person ? personOrigin(this.host.person, this.device) : `web:${this.device}`;
  }

  async init() {
    await this.db.open();
    this.host.persist?.();
    const { rows, outbox, lastSeq, lastId } = await this.db.load();
    const byDoc = new Map<string, { keys: unknown[]; updates: Uint8Array[] }>();
    for (const row of rows) {
      const e = byDoc.get(row.d) ?? { keys: [], updates: [] };
      e.keys.push(row.key);
      e.updates.push(row.u);
      byDoc.set(row.d, e);
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

  /** Merges many small stored updates per doc into one. */
  private async compact(byDoc: Map<string, { keys: unknown[]; updates: Uint8Array[] }>) {
    const heavy = [...byDoc].filter(([, e]) => e.keys.length > COMPACT_AFTER_ROWS);
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
      // remote updates are persisted in bulk by the sync handler
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
    if (!this.searchTimer) this.searchTimer = setTimeout(() => this.reindex(), SEARCH_DEBOUNCE_MS);
  }

  private materialize() {
    for (const id of this.dirty) {
      const rec = readItem(id, this.docs.get(id)!);
      if (rec) this.records.set(id, rec);
    }
    this.dirty.clear();
    // cascaded deletes follow their root; items that flip need a new search entry
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

  // One user action is one step, the undo unit. Changes in the same tick belong together (a
  // delete with its cascade, a rename with its links).
  private curStep: { id: string; at: number; doc: string; typing: boolean } | null = null;
  private sameTick = false;

  private stepFor(docId: string, tr: Y.Transaction): string {
    const doc = tr.doc;
    const body: unknown = doc.getText("body");
    const meta: unknown = doc.getMap("meta");
    const typing = [...tr.changed].every(([t, keys]) => t === body || (t === meta && [...keys].every((k) => k === "updated")));
    const now = Date.now();
    const prev = this.curStep;
    const keepsTyping = typing && prev?.typing && prev.doc === docId && now - prev.at < TYPING_STEP_GAP_MS;
    if (prev && (this.sameTick || keepsTyping)) prev.at = now;
    else this.curStep = { id: "s" + newId(), at: now, doc: docId, typing };
    if (!this.sameTick) {
      this.sameTick = true;
      queueMicrotask(() => (this.sameTick = false));
    }
    if (this.curStep!.doc !== docId) this.curStep!.typing = false;
    return this.curStep!.id;
  }

  /**
   * Run `fn` as a step of its own: not joined to typing just before, and typing right after
   * starts a new one. Returns the step's id (to undo it), undefined if nothing changed.
   */
  ownStep(fn: () => void): string | undefined {
    this.curStep = null;
    fn();
    const step = this.curStep as { id: string; typing: boolean } | null;
    if (!step) return undefined;
    step.typing = false;
    return step.id;
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

  // Everything one tick changed is stored in one transaction, so a reload right after a big
  // change (the setup writes dozens of documents) loses nothing.
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
      // stop advancing lastSeq so the server resends this doc later
      this.persistFailed = true;
      console.error("persist failed", e);
    } finally {
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
      // the outbox is pushed only after the server's "welcome" was checked
      for (const area of AREAS) this.send({ t: "hello", area, since: this.status.lastSeq, sinceId: this.lastId, device: this.device });
      ping = setInterval(() => this.send({ t: "ping" }), PING_MS);
    };
    // strictly in order: the server identity check must finish before updates apply
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMsg;
      this.inbox = this.inbox.then(() => (this.ws === ws ? this.onMessage(msg) : undefined)).catch((e) => console.error("sync message failed", e));
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (this.ws === ws) this.ws = null;
      this.status.online = false;
      this.emit();
      const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  /** Includes items that other (closed) tabs left in the storage. */
  private async flushOutbox() {
    for (const o of await this.db.outbox()) this.outbox.set(o.k, o);
    this.status.pending = this.outbox.size;
    for (const area of AREAS) {
      const items = [...this.outbox.values()].filter((o) => (o.a ?? PERSONAL) === area); // items from before areas: personal
      for (let i = 0; i < items.length; i += PUSH_BATCH) this.send({ t: "push", area, items: items.slice(i, i + PUSH_BATCH) });
    }
  }

  /** Goes through the durable outbox, so it survives disconnects. */
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
      await this.onWelcome(msg);
      return;
    }
    if (msg.t === "updates") {
      await this.onUpdates(msg);
    } else if (msg.t === "ack") {
      await this.onAck(msg);
    } else if (msg.t === "blob") {
      for (const l of this.blobListeners) l(msg.hash);
    } else if (msg.t === "event") {
      // the server folds edits by the same author into one event, so replace by id
      this.events = [msg.event, ...this.events.filter((e) => e.id !== msg.event.id)].slice(0, MAX_EVENTS);
      for (const l of this.eventListeners) l(msg.event);
      this.emit();
    }
  }

  private async onWelcome(msg: Extract<ServerMsg, { t: "welcome" }>) {
    this.serverFormat = msg.format;
    const known = this.serverId ?? (await this.db.serverId());
    if (known && known !== msg.hub && this.docs.size > 0) {
      // Usually the server was set up anew and this copy is stale (replace, recommended); rarely it
      // was restored from a backup and misses what only this device has (upload). Only the user knows.
      const answer = await this.host.askOtherServer();
      // no answer: nothing is lost, ask again on the next connection
      if (answer === null) {
        const old = this.ws;
        this.ws = null; // makes onmessage drop what this connection still sends
        old?.close();
        return;
      }
      if (answer !== "upload") {
        await this.db.write({ serverId: msg.hub });
        await this.resetLocal(true);
        return;
      }
      await this.enqueueFullUpload();
      // our sequence position belongs to the old server
      this.status.lastSeq = 0;
      this.lastId = undefined;
      await this.db.write({ cursor: { lastSeq: 0 } });
      this.send({ t: "hello", area: msg.area, since: 0, device: this.device });
    }
    this.serverId = msg.hub;
    if (known !== msg.hub) await this.db.write({ serverId: msg.hub });
    await this.flushOutbox();
  }

  private async onUpdates(msg: Extract<ServerMsg, { t: "updates" }>) {
    if (msg.reset) {
      // the server lost data (restored from a backup?)
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
      // never advance past updates we could not store; the next connect re-fetches them
      this.persistFailed = true;
      console.error("could not store updates", e);
    }
    if (msg.last > 0 && !this.persistFailed) {
      this.status.lastSeq = msg.last;
      this.lastId = msg.lastId;
    }
    if (msg.done || !msg.initial) this.status.synced = true;
    this.emit();
  }

  private async onAck(msg: Extract<ServerMsg, { t: "ack" }>) {
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
  }

  /** Runs on the server, which holds the history. Pushes local changes first; does nothing offline. */
  async undo(step: string): Promise<void> {
    await this.flushOutbox();
    await this.host.post("/api/undo", { step, device: this.device } satisfies UndoRequest);
  }

  /** Data from a newer format is read but never written: changes this app doesn't understand could damage it. */
  get readOnly(): boolean {
    return (this.records.get(SETTINGS_ID)?.settings?.format ?? 0) > FORMAT || this.serverFormat > FORMAT;
  }

  async resetLocal(force = false) {
    if (!force && this.outbox.size && !(await this.host.confirmDiscard(this.outbox.size))) return;
    await this.db.destroy();
    this.host.reload();
  }

  onBlob(l: (hash: string) => void) {
    this.blobListeners.add(l);
    return () => this.blobListeners.delete(l);
  }

  get(id?: string | null): Item | undefined {
    return id ? this.records.get(id) : undefined;
  }

  /** The index's own array: sort a copy. */
  live(): readonly Item[] {
    return this.index().live;
  }

  /** Rebuilt lazily when data changed. */
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

  change(id: string, fn: (doc: Y.Doc) => void) {
    if (this.readOnly) {
      if (!this.tooNewShown) this.host.tooNew();
      this.tooNewShown = true;
      return;
    }
    const doc = this.getDoc(id);
    doc.transact(() => fn(doc));
  }

  /** Also sets the item's "updated". */
  private changeAndTouch(id: string, fn: (doc: Y.Doc) => void) {
    this.change(id, (doc) => {
      fn(doc);
      touch(doc);
    });
  }

  writer: Writer = {
    change: (id, fn) => this.change(id, fn),
    get: (id) => this.records.get(id),
  };

  create(init: ItemInit, id = newId()): string {
    const schema = init.type ? this.records.get(init.type)?.schema : undefined;
    const props = { ...initialProps(schema), ...(init.props ?? {}) };
    const tpl = template(schema)?.body;
    this.change(id, (doc) => initItem(doc, { createdBy: this.origin, ...init, props, body: init.body ?? (tpl || undefined) }));
    return id;
  }

  setTitle(id: string, title: string) {
    const prev = this.records.get(id);
    const ownsTitle = !!prev && this.index().ownsTitle(prev);
    this.change(id, (doc) => setMeta(doc, { title }));
    if (ownsTitle && prev!.title !== title) this.renameLinks(prev!.title, title);
  }

  /** Applies the new type's initial values. Files have no type. */
  setType(id: string, type: string | null) {
    const item = this.records.get(id);
    if (!item || item.kind !== "info" || item.type === type) return;
    const schema = type ? this.records.get(type)?.schema : undefined;
    this.change(id, (doc) => {
      setMeta(doc, { type });
      for (const [k, v] of Object.entries(initialProps(schema))) if (item.props[k] === undefined) setProp(doc, k, v);
    });
  }

  /** false if it would create a cycle. */
  addParent(id: string, parent: string, sort?: string): boolean {
    if (this.index().wouldCycle(id, parent)) return false;
    this.changeAndTouch(id, (doc) => addParent(doc, parent, sort));
    return true;
  }
  removeParent(id: string, parent: string) {
    this.changeAndTouch(id, (doc) => removeParent(doc, parent));
  }
  /** Replaces the parent the item was dragged from. */
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
  /** parent null: the position among pinned items. */
  setSort(id: string, parent: string | null, sort: string) {
    this.change(id, (doc) => (parent ? setParentSort(doc, parent, sort) : setMeta(doc, { pinned: sort })));
  }

  /** Pins after everything pinned so far. */
  pin(id: string, on: boolean) {
    const pinned = on ? nextPinKey(this.live()) : null;
    this.change(id, (doc) => setMeta(doc, { pinned }));
  }

  setProp(id: string, propId: string, value: Value | null) {
    const schema = this.index().schemaOf(this.records.get(id));
    this.changeAndTouch(id, (doc) => writeProp(doc, schema, propId, value));
  }
  setExtra(id: string, name: string, value: FreeValue | null) {
    this.changeAndTouch(id, (doc) => setExtra(doc, name, value));
  }
  setRel(id: string, propId: string, target: string, on: boolean) {
    this.changeAndTouch(id, (doc) => setRel(doc, propId, target, on));
  }
  setMember(id: string, set: "tags" | "refs", key: string, on: boolean) {
    this.changeAndTouch(id, (doc) => setMember(doc, set, key, on));
  }
  setBody(id: string, body: string) {
    this.change(id, (doc) => replaceBody(doc, body));
  }
  /** "Regeln für Agenten" of an item, or of the workspace (the settings doc). */
  setRules(id: string, rules: string) {
    this.change(id, (doc) => {
      setRules(doc, rules);
      touch(doc);
    });
  }
  setView(id: string, viewId: string, def: ViewDef | null) {
    this.change(id, (doc) => setView(doc, viewId, def));
  }

  /** `status.option` is an option id of the status property. */
  addUpdate(id: string, text: string, status?: { prop: string; option: string }) {
    const schema = this.index().schemaOf(this.records.get(id));
    const at = Date.now();
    this.change(id, (doc) => {
      appendUpdate(doc, { at, text, by: "you", status: status?.option });
      if (status) writeProp(doc, schema, status.prop, status.option, at);
      touch(doc);
    });
  }

  /** Children that hang only here go along, or with "inbox" lose this parent. */
  remove(id: string, children: "trash" | "inbox" = "trash") {
    deleteItem(this.writer, this.index(), id, children);
  }
  /** Restores exactly what was deleted with it. */
  restore(id: string) {
    restoreItem(this.writer, this.records, id);
  }

  renameLinks(oldTitle: string, newTitle: string) {
    for (const r of this.live()) {
      const body = renameLinksIn(r.body, oldTitle, newTitle);
      if (body !== null) this.setBody(r.id, body);
    }
  }
}

