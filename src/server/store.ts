// The hub's replica: an append-only update log in SQLite, every doc held in
// memory, and plain-object records materialised from the docs for queries,
// search, activity events and the markdown mirror.
import { Database } from "bun:sqlite";
import * as Y from "yjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Item, type ItemInit, initItem, isContent, newId, readItem } from "../shared/model";
import { Index } from "../shared/graph";
import { resolveCascade } from "../shared/trash";
import type { ActivityEvent, FieldChange } from "../shared/protocol";
import { createIndex, indexRecord, type SearchIndex } from "../shared/search";

const REMOTE = Symbol("remote");

export interface StoredUpdate {
  seq: number;
  uid: string; // unique id of this log row: a restored backup reuses seq numbers, never uids
  doc: string;
  data: Uint8Array;
  origin: string;
  step?: string;
}

type Listener = {
  update?: (u: StoredUpdate, conn?: unknown) => void;
  event?: (e: ActivityEvent) => void;
  record?: (r: Item) => void;
};

export class Store {
  db: Database;
  docs = new Map<string, Y.Doc>();
  records = new Map<string, Item>();
  searchIndex: SearchIndex = createIndex();
  seq = 0;
  lastUid = "";
  private listeners = new Set<Listener>();
  private pending = new Map<string, { origins: Set<string>; quiet: boolean; step?: string }>();
  /** The step changes made on the hub belong to (a tool call, an undo); see step(). */
  private stepCtx: { id: string; actor: string; undoes?: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _ix: Index | null = null;
  /** While an atomic call runs: its updates, written only if the whole call succeeds. */
  private held: { docId: string; data: Uint8Array; origin: string; quiet: boolean; step?: string }[] | null = null;
  private heldPrev = new Map<string, Item | undefined>();

  constructor(public dir: string) {
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
    // Each log row has a unique id, so a replica's cursor (seq + uid) tells whether the hub
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
    this.load();
    if (!this.kvGet("hubId")) this.kvSet("hubId", newId());
  }

  /** Identity of this hub database. A device seeing a different id knows it met a new hub. */
  get hubId(): string {
    return this.kvGet("hubId")!;
  }

  // ---------- loading ----------

  private load() {
    const snapshots = this.db.query("SELECT id, state, seq FROM docstate").all() as { id: string; state: Uint8Array; seq: number }[];
    const snapSeq = new Map<string, number>();
    for (const s of snapshots) {
      const doc = this.getDoc(s.id);
      Y.applyUpdate(doc, s.state, REMOTE);
      snapSeq.set(s.id, s.seq);
    }
    // Replay log rows newer than the snapshots (crash between log append and snapshot).
    // Every flush snapshots all pending docs at the current seq, so rows at or below the
    // oldest snapshot are already contained in snapshots.
    const minSnap = snapshots.length ? Math.min(...snapshots.map((s) => s.seq)) : 0;
    const rows = this.db.query("SELECT seq, doc, data FROM updates WHERE seq > ? ORDER BY seq").iterate(minSnap) as Iterable<{ seq: number; doc: string; data: Uint8Array }>;
    for (const r of rows) {
      if (r.seq > (snapSeq.get(r.doc) ?? 0)) Y.applyUpdate(this.getDoc(r.doc), r.data, REMOTE);
    }
    const last = this.db.query("SELECT seq, uid FROM updates ORDER BY seq DESC LIMIT 1").get() as { seq: number; uid: string } | null;
    this.seq = last?.seq ?? 0;
    this.lastUid = last?.uid ?? "";
    for (const [id, doc] of this.docs) {
      const rec = readItem(id, doc);
      if (rec) this.records.set(id, rec);
    }
    resolveCascade(this.records);
    for (const rec of this.records.values()) indexRecord(this.searchIndex, rec);
  }

  getDoc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new Y.Doc({ guid: id, gc: true });
      this.docs.set(id, doc);
    }
    return doc;
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ---------- writing ----------

  /** Apply an update that came from another replica. Returns its sequence number. */
  applyRemote(docId: string, data: Uint8Array, origin: string, conn?: unknown, step?: string): number {
    const doc = this.getDoc(docId);
    const before = Y.encodeStateVector(doc);
    Y.applyUpdate(doc, data, REMOTE);
    // Skip log rows only for true duplicates (re-sent outbox items). An update whose
    // dependencies are missing is parked by Yjs without changing the state vector –
    // it must still be logged and relayed, or it would be acked and then lost.
    const after = Y.encodeStateVector(doc);
    const pending = doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
    if (!pending && equalBytes(before, after) && !hasDeleteSet(data)) return this.seq;
    const seq = this.append(docId, data, origin, conn, false, step);
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
    const meta = doc.getMap<any>("meta");
    const late = ["created", "updated", "done"].filter((k) => typeof meta.get(k) === "number" && meta.get(k) > max);
    const updates = doc.getArray<any>("updates");
    const lateUpdates = updates.toArray().map((u, i) => [u, i] as const).filter(([u]) => typeof u?.at === "number" && u.at > max);
    if (!late.length && !lateUpdates.length) return;
    const now = Date.now();
    this.change(
      docId,
      "system:clock",
      (d) => {
        const m = d.getMap<any>("meta");
        for (const k of late) m.set(k, now);
        const arr = d.getArray<any>("updates");
        for (const [u, i] of lateUpdates) {
          arr.delete(i, 1);
          arr.insert(i, [{ ...u, at: now }]);
        }
      },
      { quiet: true },
    );
  }

  /**
   * Run `fn` as one step: every change it makes on the hub carries the same step id, so
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

  /** Make a change on the hub itself (MCP tools, imports). */
  change(docId: string, origin: string, fn: (doc: Y.Doc) => void, opts: { quiet?: boolean } = {}): void {
    const doc = this.getDoc(docId);
    const sv = Y.encodeStateVector(doc);
    doc.transact(() => fn(doc), this.stepCtx ? { actor: origin, step: this.stepCtx.id } : origin);
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
      const snap = this.db.query("SELECT state, seq FROM docstate WHERE id = ?").get(id) as { state: Uint8Array; seq: number } | null;
      const rows = this.db.query("SELECT data FROM updates WHERE doc = ? AND seq > ? ORDER BY seq").all(id, snap?.seq ?? 0) as { data: Uint8Array }[];
      if (!snap && !rows.length) {
        this.docs.delete(id);
        this.records.delete(id);
        if (this.searchIndex.has(id)) this.searchIndex.discard(id);
        continue;
      }
      const doc = new Y.Doc({ guid: id, gc: true });
      if (snap) Y.applyUpdate(doc, snap.state, REMOTE);
      for (const r of rows) Y.applyUpdate(doc, r.data, REMOTE);
      this.docs.set(id, doc);
      const rec = readItem(id, doc);
      if (rec) this.records.set(id, rec);
      else this.records.delete(id);
    }
    resolveCascade(this.records);
    for (const id of ids) {
      const rec = this.records.get(id);
      if (rec) indexRecord(this.searchIndex, rec);
    }
    this._ix = null;
  }

  private append(docId: string, data: Uint8Array, origin: string, conn?: unknown, quiet = false, step?: string): number {
    if (this.held) {
      this.held.push({ docId, data, origin, quiet, step });
      this.refresh(docId);
      return this.seq;
    }
    const uid = newId();
    const res = this.db
      .query("INSERT INTO updates (doc, data, origin, ts, uid, step) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq")
      .get(docId, data, origin, Date.now(), uid, step ?? null) as { seq: number };
    this.seq = res.seq;
    this.lastUid = uid;
    if (step) {
      const undoes = this.stepCtx?.id === step ? (this.stepCtx.undoes ?? null) : null;
      this.db.query("INSERT OR IGNORE INTO steps (id, actor, ts, undoes) VALUES (?, ?, ?, ?)").run(step, origin, Date.now(), undoes);
    }
    const u: StoredUpdate = { seq: res.seq, uid, doc: docId, data, origin, step };
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
      "INSERT INTO events (ts, doc, title, type, kind, origin, changes, step) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
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
        const row = saveEvent.get(ts, id, next.title, typeTag(next), kind, origin, JSON.stringify(changes), step ?? null) as { id: number };
        events.push({ id: row.id, ts, doc: id, title: next.title, type: typeTag(next), kind, origin, changes, step });
      }
    })();
    this._ix = null;
    for (const r of changed) for (const l of this.listeners) l.record?.(r);
    for (const e of events) for (const l of this.listeners) l.event?.(e);
  }

  // ---------- reading ----------

  /**
   * Does this hub still hold the log row a replica last saw? Not if the position lies beyond
   * the log, or if the row there has another id: the hub came from an older backup, and maybe
   * another device has synced since, so seq alone has grown past the cursor again.
   */
  knowsCursor(since: number, sinceId?: string): boolean {
    if (since <= 0) return true;
    if (since > this.seq) return false;
    if (!sinceId) return true; // replica from before cursor ids: seq is all we can check
    const row = this.db.query("SELECT uid FROM updates WHERE seq = ?").get(since) as { uid: string } | null;
    return row?.uid === sinceId;
  }

  /** Docs changed after `since`, as full state updates (what a reconnecting replica needs). */
  docsSince(since: number): string[] {
    if (since <= 0) return [...this.docs.keys()];
    const rows = this.db.query("SELECT DISTINCT doc FROM updates WHERE seq > ?").all(since) as { doc: string }[];
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

  resolveTitle = (title: string) => this.index().resolveTitle(title);

  events(opts: { since?: number; doc?: string; limit?: number; before?: number } = {}): ActivityEvent[] {
    const where: string[] = [];
    const args: any[] = [];
    if (opts.since) (where.push("ts >= ?"), args.push(opts.since));
    if (opts.before) (where.push("id < ?"), args.push(opts.before));
    if (opts.doc) (where.push("doc = ?"), args.push(opts.doc));
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    args.push(opts.limit ?? 50);
    const rows = (this.db.query(sql).all(...args) as any[]).map((r) => ({ ...r, step: r.step ?? undefined, changes: JSON.parse(r.changes || "[]") })) as ActivityEvent[];
    for (const e of rows) if (e.step) Object.assign(e, this.stepState(e.step));
    return rows;
  }

  /** Is a step an undo (of which step) – or a redo, an undo of an undo – and is it undone right now? */
  stepState(step: string): { undoes?: string; undone?: boolean; redo?: boolean } {
    const q = this.db.query("SELECT undoes FROM steps WHERE id = ?");
    const row = q.get(step) as { undoes: string | null } | null;
    const target = row?.undoes ? (q.get(row.undoes) as { undoes: string | null } | null) : null;
    return { undoes: row?.undoes ?? undefined, undone: !!this.activeUndo(step), redo: !!target?.undoes || undefined };
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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function setDiff(field: string, a: string[], b: string[], out: FieldChange[]) {
  const added = b.filter((x) => !a.includes(x));
  const removed = a.filter((x) => !b.includes(x));
  if (added.length || removed.length) out.push({ field, from: removed, to: added });
}

export function diffRecords(prev: Item | undefined, next: Item): { kind: ActivityEvent["kind"]; changes: FieldChange[] } {
  if (!prev) return { kind: next.deleted ? "deleted" : "created", changes: [] };
  const changes: FieldChange[] = [];
  for (const f of ["title", "type", "home", "pinned"] as const) if (prev[f] !== next[f]) changes.push({ field: f, from: prev[f] ?? undefined, to: next[f] ?? undefined });
  setDiff("parents", Object.keys(prev.parents), Object.keys(next.parents), changes);
  setDiff("tags", prev.tags, next.tags, changes);
  setDiff("refs", prev.refs, next.refs, changes);
  for (const k of new Set([...Object.keys(prev.props), ...Object.keys(next.props)]))
    if (!same(prev.props[k], next.props[k])) changes.push({ field: "p:" + k, from: prev.props[k], to: next.props[k] });
  for (const k of new Set([...Object.keys(prev.extra), ...Object.keys(next.extra)]))
    if (!same(prev.extra[k], next.extra[k])) changes.push({ field: "x:" + k, from: prev.extra[k]?.v, to: next.extra[k]?.v });
  for (const k of new Set([...Object.keys(prev.rels), ...Object.keys(next.rels)])) setDiff("r:" + k, prev.rels[k] ?? [], next.rels[k] ?? [], changes);
  if (prev.body !== next.body) changes.push({ field: "body", from: prev.body.length, to: next.body.length });
  if (next.updates.length > prev.updates.length) for (const e of next.updates.slice(prev.updates.length)) changes.push({ field: "update", to: e.text });
  // a type: its schema, and apart from it its views (visible in the activity, so they can be taken back)
  if (prev.schema || next.schema) {
    const { views: va, ...sa } = prev.schema ?? ({} as NonNullable<Item["schema"]>);
    const { views: vb, ...sb } = next.schema ?? ({} as NonNullable<Item["schema"]>);
    if (!same(sa, sb)) changes.push({ field: "schema" });
    if (!same(va, vb)) changes.push({ field: "views" });
  }
  if (prev.file?.hash !== next.file?.hash && prev.file) changes.push({ field: "file", from: prev.file?.name, to: next.file?.name });
  if (!same(prev.suggestion, next.suggestion)) changes.push({ field: "suggestion", to: next.suggestion ? true : undefined });
  if (!same(prev.op, next.op)) changes.push({ field: "op", to: next.op?.undone ? "undone" : undefined });
  let kind: ActivityEvent["kind"] = "updated";
  if (!prev.deleted && next.deleted) kind = "deleted";
  if (prev.deleted && !next.deleted) kind = "restored";
  return { kind, changes };
}
