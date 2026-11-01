// The server's replica: an append-only update log in SQLite, and plain-object records
// materialised from the docs for queries, search, activity events and the markdown mirror.
// A document itself (Y.Doc with its history) is loaded when it is used – from its snapshot
// plus the log rows after it – and let go again when it has not been used for a while
// (see trim()); only the records stay in memory for all documents.
import { Database } from "bun:sqlite";
import * as Y from "yjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Item, type ItemInit, type UpdateEntry, PERSONAL, SETTINGS_ID, areaOf, initItem, isContent, metaMap, newId, readItem } from "@obtion/core/model";
import { sameValue } from "@obtion/core/equal";
import type { Lang } from "@obtion/core/i18n";
import { Index } from "@obtion/core/graph";
import { resolveCascade } from "@obtion/core/trash";
import type { ActivityEvent, FieldChange } from "@obtion/core/protocol";
import { createIndex, indexRecord, type SearchIndex } from "@obtion/core/search";

const REMOTE = Symbol("remote");

export interface StoredUpdate {
  seq: number;
  uid: string; // unique id of this log row: a restored backup reuses seq numbers, never uids
  doc: string;
  area: string;
  data: Uint8Array;
  origin: string;
  step?: string;
}

/** A change for a document of another area than the one it was sent for. */
export class AreaError extends Error {}

type Listener = {
  update?: (u: StoredUpdate, conn?: unknown) => void;
  event?: (e: ActivityEvent) => void;
  record?: (r: Item) => void;
};

/** How many documents stay in memory when not in use (least recently used go first). */
const CACHE_SIZE = 200;

export class Store {
  db: Database;
  /** The documents in memory, least recently used first. Not all documents: see getDoc(). */
  loaded = new Map<string, Y.Doc>();
  /** The area of every document, also of the ones not in memory (sync and the area check need it). */
  private areas = new Map<string, string>();
  records = new Map<string, Item>();
  searchIndex: SearchIndex = createIndex();
  seq = 0;
  lastUid = "";
  private listeners = new Set<Listener>();
  private pending = new Map<string, { origins: Set<string>; quiet: boolean; step?: string }>();
  /** The step changes made on the server belong to (a tool call, an undo); see step(). */
  private stepCtx: { id: string; actor: string; undoes?: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trimTimer: ReturnType<typeof setTimeout> | null = null;
  private _ix: Index | null = null;
  /** While an atomic call runs: its updates, written only if the whole call succeeds. */
  private held: { docId: string; data: Uint8Array; origin: string; quiet: boolean; step?: string }[] | null = null;
  private heldPrev = new Map<string, Item | undefined>();

  constructor(
    public dir: string,
    private cacheSize = CACHE_SIZE,
  ) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "obtion.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, data BLOB NOT NULL, origin TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS updates_doc ON updates(doc, seq);
      CREATE TABLE IF NOT EXISTS docstate (id TEXT PRIMARY KEY, state BLOB NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, doc TEXT NOT NULL, title TEXT, type TEXT, kind TEXT, origin TEXT, changes TEXT);
      CREATE INDEX IF NOT EXISTS events_doc ON events(doc, id);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, actor TEXT, ts INTEGER, undoes TEXT);
      CREATE INDEX IF NOT EXISTS steps_undoes ON steps(undoes);
    `);
    // Each log row has a unique id, so a replica's cursor (seq + uid) tells whether the server
    // still has the row it saw. Older databases get ids for their existing rows once.
    const cols = this.db.query("PRAGMA table_info(updates)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "uid")) {
      this.db.exec("ALTER TABLE updates ADD COLUMN uid TEXT");
      this.db.exec("UPDATE updates SET uid = lower(hex(randomblob(9))) WHERE uid IS NULL");
    }
    // One user action or tool call = one step = one undo unit (rows from before have none).
    if (!cols.some((c) => c.name === "step")) {
      this.db.exec("ALTER TABLE updates ADD COLUMN step TEXT");
      this.db.exec("CREATE INDEX IF NOT EXISTS updates_step ON updates(step)");
    }
    const ecols = this.db.query("PRAGMA table_info(events)").all() as { name: string }[];
    if (!ecols.some((c) => c.name === "step")) this.db.exec("ALTER TABLE events ADD COLUMN step TEXT");
    // Every log row and activity entry belongs to one area (27.10.); rows from before are personal.
    if (!cols.some((c) => c.name === "area")) {
      this.db.exec(`ALTER TABLE updates ADD COLUMN area TEXT NOT NULL DEFAULT '${PERSONAL}'`);
      this.db.exec("CREATE INDEX IF NOT EXISTS updates_area ON updates(area, seq)");
    }
    if (!ecols.some((c) => c.name === "area")) this.db.exec(`ALTER TABLE events ADD COLUMN area TEXT NOT NULL DEFAULT '${PERSONAL}'`);
    this.load();
    // stored as "hubId" (the server was called hub before); renaming it would look like a new server
    if (!this.kvGet("hubId")) this.kvSet("hubId", newId());
  }

  /** Identity of this server database. A device seeing a different id knows it met a new server. */
  get serverId(): string {
    return this.kvGet("hubId")!;
  }

  // ---------- loading ----------

  /** Records, areas and search index for every document, reading one document at a time. */
  private load() {
    const last = this.db.query("SELECT seq, uid FROM updates ORDER BY seq DESC LIMIT 1").get() as { seq: number; uid: string } | null;
    this.seq = last?.seq ?? 0;
    this.lastUid = last?.uid ?? "";
    for (const [id, doc] of this.eachDoc()) {
      this.noteArea(id, doc);
      const rec = readItem(id, doc);
      if (rec) this.records.set(id, rec);
    }
    resolveCascade(this.records);
    for (const rec of this.records.values()) indexRecord(this.searchIndex, rec);
  }

  /**
   * Every stored document, one at a time: the ones in memory as they are, the others read for
   * the caller and not kept. For a pass over all documents (startup, one-time upgrades).
   */
  *eachDoc(): Generator<[string, Y.Doc]> {
    // a doc without snapshot has only log rows (a crash before its first flush)
    const ids = this.db.query("SELECT id FROM docstate UNION SELECT doc FROM updates").all() as { id: string }[];
    for (const { id } of ids) {
      const doc = this.loaded.get(id) ?? this.read(id);
      if (doc) yield [id, doc];
    }
  }

  /** What the database holds of a document: its snapshot (if any) and the log rows after it. */
  private stored(id: string): Uint8Array[] {
    const snap = this.db.query("SELECT state, seq FROM docstate WHERE id = ?").get(id) as { state: Uint8Array; seq: number } | null;
    const rows = this.db.query("SELECT data FROM updates WHERE doc = ? AND seq > ? ORDER BY seq").all(id, snap?.seq ?? 0) as { data: Uint8Array }[];
    return [...(snap ? [snap.state] : []), ...rows.map((r) => r.data)];
  }

  /** A document from the database (null if unknown). */
  private read(id: string): Y.Doc | null {
    const parts = this.stored(id);
    if (!parts.length) return null;
    const doc = new Y.Doc({ guid: id, gc: true });
    for (const u of parts) Y.applyUpdate(doc, u, REMOTE);
    return doc;
  }

  /** A document to read or change, loaded if it is not in memory (a new, empty one if unknown). */
  getDoc(id: string): Y.Doc {
    let doc = this.loaded.get(id);
    if (doc) {
      this.loaded.delete(id); // most recently used: to the end
      this.loaded.set(id, doc);
      return doc;
    }
    doc = this.read(id) ?? new Y.Doc({ guid: id, gc: true });
    this.loaded.set(id, doc);
    this.scheduleTrim();
    return doc;
  }

  /** Not right away: whoever is running may still hold documents it got in the same call. */
  private scheduleTrim() {
    if (this.loaded.size > this.cacheSize && !this.trimTimer) this.trimTimer = setTimeout(() => this.trim(), 0);
  }

  /**
   * Let go of the least recently used documents beyond the cache size. Never one with changes
   * not yet in its snapshot (pending) or inside an atomic call: loading it again from the
   * database gives exactly the state it had.
   */
  trim() {
    if (this.trimTimer) clearTimeout(this.trimTimer);
    this.trimTimer = null;
    if (this.held) return;
    let over = this.loaded.size - this.cacheSize;
    for (const id of this.loaded.keys()) {
      if (over <= 0) break;
      if (this.pending.has(id)) continue;
      this.loaded.delete(id);
      over--;
    }
  }

  /** A document's full state as one update, without loading it if it is not in memory. */
  stateOf(id: string): Uint8Array {
    const doc = this.loaded.get(id);
    if (doc) return Y.encodeStateAsUpdate(doc);
    const parts = this.stored(id); // usually just the snapshot (rows after it only after a crash before a flush)
    return parts.length === 1 ? parts[0]! : parts.length ? Y.mergeUpdates(parts) : Y.encodeStateAsUpdate(new Y.Doc());
  }

  private noteArea(id: string, doc: Y.Doc) {
    const meta = metaMap(doc);
    const area = meta.has("area") || meta.has("kind") ? areaOf(doc) : undefined;
    if (area) this.areas.set(id, area);
    else this.areas.delete(id);
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ---------- writing ----------

  /** The area of a document (personal for documents from before areas); undefined if unknown. */
  areaOf(docId: string): string | undefined {
    return this.areas.get(docId);
  }

  /**
   * Apply an update that came from another replica for `area`. Returns its sequence number.
   * A document of another area is refused (AreaError): areas never mix through sync.
   */
  applyRemote(docId: string, data: Uint8Array, origin: string, conn?: unknown, step?: string, area = PERSONAL): number {
    const known = this.areaOf(docId);
    if (known && known !== area) throw new AreaError(`${docId} belongs to the area ${known}, not ${area}`);
    const doc = this.getDoc(docId);
    const before = Y.encodeStateVector(doc);
    Y.applyUpdate(doc, data, REMOTE);
    this.noteArea(docId, doc);
    // Skip log rows only for true duplicates (re-sent outbox items). An update whose
    // dependencies are missing is parked by Yjs without changing the state vector –
    // it must still be logged and relayed, or it would be acked and then lost.
    const after = Y.encodeStateVector(doc);
    const pending = doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
    if (!pending && equalBytes(before, after) && !hasDeleteSet(data)) return this.seq;
    const seq = this.append(docId, data, origin, conn, false, step, area);
    this.capFuture(docId);
    return seq;
  }

  /**
   * A device with a wrong clock: timestamps more than 10 minutes ahead are set back to now,
   * so "geändert", sorting and the activity don't jump. The fix syncs like any change.
   */
  private capFuture(docId: string) {
    const doc = this.getDoc(docId);
    const max = Date.now() + 10 * 60_000;
    const meta = metaMap(doc);
    const late = ["created", "updated", "done"].filter((k) => {
      const v = meta.get(k);
      return typeof v === "number" && v > max;
    });
    const updates: (UpdateEntry | undefined)[] = doc.getArray<UpdateEntry | undefined>("updates").toArray();
    const lateUpdates = updates.map((u, i) => [u, i] as const).filter(([u]) => typeof u?.at === "number" && u.at > max);
    if (!late.length && !lateUpdates.length) return;
    const now = Date.now();
    this.change(
      docId,
      "system:clock",
      (d) => {
        const m = metaMap(d);
        for (const k of late) m.set(k, now);
        const arr = d.getArray<UpdateEntry | undefined>("updates");
        for (const [u, i] of lateUpdates) {
          arr.delete(i, 1);
          arr.insert(i, [{ ...u, at: now }]);
        }
      },
      { quiet: true },
    );
  }

  /**
   * Run `fn` as one step: every change it makes on the server carries the same step id, so
   * "Rückgängig" can take back all of it, across documents. Nested calls join the outer step.
   */
  step<T>(actor: string, fn: (step: string) => T, opts: { undoes?: string } = {}): T {
    if (this.stepCtx) return fn(this.stepCtx.id);
    this.stepCtx = { id: "s" + newId(), actor, undoes: opts.undoes };
    try {
      return fn(this.stepCtx.id);
    } finally {
      this.stepCtx = null;
    }
  }

  /** Make a change on the server itself (MCP tools, imports). */
  change(docId: string, origin: string, fn: (doc: Y.Doc) => void, opts: { quiet?: boolean } = {}): void {
    const doc = this.getDoc(docId);
    const sv = Y.encodeStateVector(doc);
    doc.transact(() => fn(doc), this.stepCtx ? { actor: origin, step: this.stepCtx.id } : origin);
    this.noteArea(docId, doc);
    const update = Y.encodeStateAsUpdate(doc, sv);
    if (update.length <= 2) return; // nothing changed
    this.append(docId, update, origin, undefined, opts.quiet, this.stepCtx?.id);
  }

  create(init: ItemInit, origin: string, opts: { id?: string; quiet?: boolean } = {}): string {
    const id = opts.id ?? newId();
    this.change(id, origin, (doc) => initItem(doc, { createdBy: origin, ...init }), opts);
    this.flush();
    return id;
  }

  /**
   * All or nothing: run `fn`; its changes are visible to reads right away, but reach the log,
   * the devices and the activity only if it returns without throwing. On an error every
   * touched document is reloaded from the database, as if nothing had happened.
   */
  atomic<T>(fn: () => T): T {
    if (this.held) return fn(); // nested: part of the outer call
    this.held = [];
    let ok = false;
    try {
      const res = fn();
      ok = true;
      return res;
    } finally {
      const held = this.held;
      this.held = null;
      if (ok && held.length) {
        // records as before the call, so the activity sees what really changed
        for (const [id, prev] of this.heldPrev) prev ? this.records.set(id, prev) : this.records.delete(id);
        for (const h of held) this.append(h.docId, h.data, h.origin, undefined, h.quiet, h.step);
        this.flush();
      } else if (!ok) this.reload([...new Set(held.map((h) => h.docId))]);
      this.heldPrev.clear();
    }
  }

  /** Rebuild documents from snapshot + log (drops changes that never reached the log). */
  private reload(ids: string[]) {
    for (const id of ids) {
      this.pending.delete(id);
      this.loaded.delete(id);
      const doc = this.read(id);
      const rec = doc && readItem(id, doc);
      if (doc) this.noteArea(id, doc);
      else this.areas.delete(id);
      if (rec) this.records.set(id, rec);
      else {
        this.records.delete(id);
        if (this.searchIndex.has(id)) this.searchIndex.discard(id);
      }
    }
    resolveCascade(this.records);
    for (const id of ids) {
      const rec = this.records.get(id);
      if (rec) indexRecord(this.searchIndex, rec);
    }
    this._ix = null;
  }

  private append(docId: string, data: Uint8Array, origin: string, conn?: unknown, quiet = false, step?: string, area = this.areaOf(docId) ?? PERSONAL): number {
    if (this.held) {
      this.held.push({ docId, data, origin, quiet, step });
      this.refresh(docId);
      return this.seq;
    }
    const uid = newId();
    const res = this.db
      .query("INSERT INTO updates (doc, data, origin, ts, uid, step, area) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq")
      .get(docId, data, origin, Date.now(), uid, step ?? null, area) as { seq: number };
    this.seq = res.seq;
    this.lastUid = uid;
    if (step) {
      const undoes = this.stepCtx?.id === step ? (this.stepCtx.undoes ?? null) : null;
      this.db.query("INSERT OR IGNORE INTO steps (id, actor, ts, undoes) VALUES (?, ?, ?, ?)").run(step, origin, Date.now(), undoes);
    }
    const u: StoredUpdate = { seq: res.seq, uid, doc: docId, area, data, origin, step };
    for (const l of this.listeners) l.update?.(u, conn);
    const p = this.pending.get(docId) ?? { origins: new Set<string>(), quiet };
    p.origins.add(origin);
    if (step) p.step = step;
    p.quiet = p.quiet && quiet;
    this.pending.set(docId, p);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 250);
    return res.seq;
  }

  /** Inside an atomic call: make a held change visible to reads (records, index) without persisting it. */
  private refresh(docId: string) {
    if (!this.heldPrev.has(docId)) this.heldPrev.set(docId, this.records.get(docId));
    const rec = readItem(docId, this.getDoc(docId));
    if (rec) this.records.set(docId, rec);
    resolveCascade(this.records);
    this._ix = null;
  }

  /** Materialise pending docs: snapshot, record, search index, activity event. */
  flush() {
    if (this.held) return; // persisted when the atomic call ends
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = [...this.pending];
    this.pending.clear();
    if (!pending.length) return;
    const saveSnap = this.db.prepare("INSERT OR REPLACE INTO docstate (id, state, seq) VALUES (?, ?, ?)");
    const saveEvent = this.db.prepare(
      "INSERT INTO events (ts, doc, title, type, kind, origin, changes, step, area) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const lastEvent = this.db.prepare("SELECT id, ts, kind, origin, changes, step FROM events WHERE doc = ? ORDER BY id DESC LIMIT 1");
    const updateEvent = this.db.prepare("UPDATE events SET ts = ?, title = ?, changes = ? WHERE id = ?");
    const events: ActivityEvent[] = [];
    const changed: Item[] = [];
    const prevs = new Map<string, Item | undefined>();
    for (const [id] of pending) {
      const next = readItem(id, this.getDoc(id));
      if (!next) continue;
      prevs.set(id, this.records.get(id));
      this.records.set(id, next);
    }
    // Cascaded deletes depend on their root: recompute them over all records.
    const viaBefore = new Map([...this.records.values()].filter((r) => r.deletedVia).map((r) => [r.id, r.deleted]));
    resolveCascade(this.records);
    for (const [id, was] of viaBefore) if (!prevs.has(id) && this.records.get(id)!.deleted !== was) indexRecord(this.searchIndex, this.records.get(id)!), changed.push(this.records.get(id)!);
    this.db.transaction(() => {
      for (const [id, p] of pending) {
        const doc = this.getDoc(id);
        saveSnap.run(id, Y.encodeStateAsUpdate(doc), this.seq);
        if (!prevs.has(id)) continue;
        const prev = prevs.get(id);
        const next = this.records.get(id)!;
        indexRecord(this.searchIndex, next);
        changed.push(next);
        if (p.quiet || next.kind === "settings") continue;
        const { kind, changes } = diffRecords(prev, next);
        if (kind === "updated" && changes.length === 0) continue;
        // Blank drafts (created, then left empty) are not worth an activity entry.
        const blank = !next.title.trim() && !next.body.trim();
        if (blank && (kind === "created" || kind === "deleted")) continue;
        const origin = [...p.origins].join(", ");
        const ts = Date.now();
        // Typing produces a flush every 250 ms: fold consecutive edits by the same author
        // within a few minutes into one activity entry instead of flooding the feed.
        // ... but only within one step, so every entry can be undone on its own.
        const step = p.step;
        const last = lastEvent.get(id) as { id: number; ts: number; kind: string; origin: string; changes: string; step: string | null } | null;
        if (kind === "updated" && last && last.kind === "updated" && last.origin === origin && (last.step ?? undefined) === step && ts - last.ts < 5 * 60_000) {
          const merged = mergeChanges(JSON.parse(last.changes || "[]"), changes);
          updateEvent.run(ts, next.title, JSON.stringify(merged), last.id);
          events.push({ id: last.id, ts, doc: id, title: next.title, type: typeTag(next), kind, origin, changes: merged, step });
          continue;
        }
        const row = saveEvent.get(ts, id, next.title, typeTag(next), kind, origin, JSON.stringify(changes), step ?? null, next.area) as { id: number };
        events.push({ id: row.id, ts, doc: id, title: next.title, type: typeTag(next), kind, origin, changes, step });
      }
    })();
    this._ix = null;
    this.scheduleTrim();
    for (const r of changed) for (const l of this.listeners) l.record?.(r);
    for (const e of events) for (const l of this.listeners) l.event?.(e);
  }

  // ---------- reading ----------

  /**
   * Does this server still hold the log row a replica last saw? Not if the position lies beyond
   * the log, or if the row there has another id: the server came from an older backup, and maybe
   * another device has synced since, so seq alone has grown past the cursor again.
   */
  knowsCursor(area: string, since: number, sinceId?: string): boolean {
    if (since <= 0) return true;
    if (since > this.last(area).seq) return false;
    if (!sinceId) return true; // replica from before cursor ids: seq is all we can check
    const row = this.db.query("SELECT uid, area FROM updates WHERE seq = ?").get(since) as { uid: string; area: string } | null;
    return row?.uid === sinceId && row.area === area;
  }

  /** The newest log row of an area: the position a replica of it has after catching up. */
  last(area: string): { seq: number; uid: string } {
    const row = this.db.query("SELECT seq, uid FROM updates WHERE area = ? ORDER BY seq DESC LIMIT 1").get(area) as { seq: number; uid: string } | null;
    return row ?? { seq: 0, uid: "" };
  }

  /** Docs of an area changed after `since`, as full state updates (what a reconnecting replica needs). */
  docsSince(area: string, since: number): string[] {
    if (since <= 0) return [...this.areas].filter(([, a]) => a === area).map(([id]) => id);
    const rows = this.db.query("SELECT DISTINCT doc FROM updates WHERE area = ? AND seq > ?").all(area, since) as { doc: string }[];
    return rows.map((r) => r.doc);
  }

  live(): Item[] {
    return [...this.records.values()].filter(isContent);
  }

  /** Structure, titles, links and aggregation over the current records (rebuilt after each flush). */
  index(): Index {
    if (!this._ix) this._ix = new Index(this.records);
    return this._ix;
  }

  /** The language the workspace was set up in; undefined before the setup. */
  setupLang(): Lang | undefined {
    return this.records.get(SETTINGS_ID)?.settings?.setupLang as Lang | undefined;
  }

  /** The workspace's language: the setup's, German before it. */
  lang(): Lang {
    return this.setupLang() ?? "de";
  }

  events(opts: { since?: number; doc?: string; limit?: number; before?: number } = {}): ActivityEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.since) (where.push("ts >= ?"), args.push(opts.since));
    if (opts.before) (where.push("id < ?"), args.push(opts.before));
    if (opts.doc) (where.push("doc = ?"), args.push(opts.doc));
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    args.push(opts.limit ?? 50);
    const found = this.db.query(sql).all(...args) as (Omit<ActivityEvent, "step" | "changes"> & { step: string | null; changes: string | null })[];
    const rows: ActivityEvent[] = found.map((r) => ({ ...r, step: r.step ?? undefined, changes: JSON.parse(r.changes || "[]") }));
    for (const e of rows) if (e.step) Object.assign(e, this.stepState(e.step));
    return rows;
  }

  /** An activity entry of its own, not about one document (an import). */
  logEvent(title: string, origin: string) {
    this.db.query("INSERT INTO events (ts, doc, title, type, kind, origin, changes) VALUES (?, ?, ?, ?, ?, ?, ?)").run(Date.now(), "", title, "import", "created", origin, "[]");
  }

  /** Is a step an undo (of which step) – or a redo, an undo of an undo? */
  stepState(step: string): { undoes?: string; redo?: boolean } {
    const q = this.db.query("SELECT undoes FROM steps WHERE id = ?");
    const row = q.get(step) as { undoes: string | null } | null;
    const target = row?.undoes ? (q.get(row.undoes) as { undoes: string | null } | null) : null;
    return { undoes: row?.undoes ?? undefined, redo: !!target?.undoes || undefined };
  }

  /** The undo that currently takes this step back (itself not undone), if any. */
  activeUndo(step: string, depth = 0): string | undefined {
    if (depth > 20) return undefined;
    const undos = this.db.query("SELECT id FROM steps WHERE undoes = ? ORDER BY ts").all(step) as { id: string }[];
    for (const u of undos.reverse()) if (!this.activeUndo(u.id, depth + 1)) return u.id;
    return undefined;
  }

  kvGet(key: string): string | undefined {
    return (this.db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null)?.value;
  }
  kvSet(key: string, value: string) {
    this.db.query("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }
}

// ---------- helpers ----------

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hasDeleteSet(update: Uint8Array) {
  // A pure-deletion update does not advance the state vector. Decode to check.
  try {
    const d = Y.decodeUpdate(update);
    return d.ds.clients.size > 0;
  } catch {
    return true;
  }
}

/** Combine two change lists: keep the first "from" and the last "to" per field. */
function mergeChanges(a: FieldChange[], b: FieldChange[]): FieldChange[] {
  const out = a.map((c) => ({ ...c }));
  for (const c of b) {
    if (c.field === "update") {
      out.push(c);
      continue;
    }
    const prev = out.find((x) => x.field === c.field);
    if (!prev) out.push({ ...c });
    else if (Array.isArray(c.to) || Array.isArray(c.from)) {
      const added = new Set([...((prev.to as string[]) ?? []), ...((c.to as string[]) ?? [])]);
      const removed = new Set([...((prev.from as string[]) ?? []), ...((c.from as string[]) ?? [])]);
      for (const x of [...added]) if (removed.has(x)) (added.delete(x), removed.delete(x));
      prev.to = [...added];
      prev.from = [...removed];
    } else prev.to = c.to;
  }
  // Drop fields that ended where they started.
  return out.filter((c) => c.field === "update" || c.field === "schema" || (Array.isArray(c.to) ? (c.to as unknown[]).length || ((c.from as unknown[]) ?? []).length : c.from !== c.to));
}

/** Short type tag for activity rows: the type id, "datei", "op" … */
function typeTag(i: Item): string {
  return i.kind === "info" ? (i.type ?? "") : i.kind;
}


function setDiff(field: string, a: string[], b: string[], out: FieldChange[]) {
  const added = b.filter((x) => !a.includes(x));
  const removed = a.filter((x) => !b.includes(x));
  if (added.length || removed.length) out.push({ field, from: removed, to: added });
}

function diffRecords(prev: Item | undefined, next: Item): { kind: ActivityEvent["kind"]; changes: FieldChange[] } {
  if (!prev) return { kind: next.deleted ? "deleted" : "created", changes: [] };
  const changes: FieldChange[] = [];
  for (const f of ["title", "type", "home", "pinned"] as const) if (prev[f] !== next[f]) changes.push({ field: f, from: prev[f] ?? undefined, to: next[f] ?? undefined });
  setDiff("parents", Object.keys(prev.parents), Object.keys(next.parents), changes);
  setDiff("tags", prev.tags, next.tags, changes);
  setDiff("refs", prev.refs, next.refs, changes);
  for (const k of new Set([...Object.keys(prev.props), ...Object.keys(next.props)]))
    if (!sameValue(prev.props[k], next.props[k])) changes.push({ field: "p:" + k, from: prev.props[k], to: next.props[k] });
  for (const k of new Set([...Object.keys(prev.extra), ...Object.keys(next.extra)]))
    if (!sameValue(prev.extra[k], next.extra[k])) changes.push({ field: "x:" + k, from: prev.extra[k]?.v, to: next.extra[k]?.v });
  for (const k of new Set([...Object.keys(prev.rels), ...Object.keys(next.rels)])) setDiff("r:" + k, prev.rels[k] ?? [], next.rels[k] ?? [], changes);
  if (prev.body !== next.body) changes.push({ field: "body", from: prev.body.length, to: next.body.length });
  if (next.updates.length > prev.updates.length) for (const e of next.updates.slice(prev.updates.length)) changes.push({ field: "update", to: e.text });
  // a type: its schema, and apart from it its views (visible in the activity, so they can be taken back)
  if (prev.schema || next.schema) {
    const { views: va, ...sa } = prev.schema ?? ({} as NonNullable<Item["schema"]>);
    const { views: vb, ...sb } = next.schema ?? ({} as NonNullable<Item["schema"]>);
    if (!sameValue(sa, sb)) changes.push({ field: "schema" });
    if (!sameValue(va, vb)) changes.push({ field: "views" });
  }
  if (prev.file?.hash !== next.file?.hash && prev.file) changes.push({ field: "file", from: prev.file?.name, to: next.file?.name });
  if (!sameValue(prev.suggestion, next.suggestion)) changes.push({ field: "suggestion", to: next.suggestion ? true : undefined });
  if (!sameValue(prev.op, next.op)) changes.push({ field: "op", to: next.op?.undone ? "undone" : undefined });
  let kind: ActivityEvent["kind"] = "updated";
  if (!prev.deleted && next.deleted) kind = "deleted";
  if (prev.deleted && !next.deleted) kind = "restored";
  return { kind, changes };
}
