// The server's replica: an append-only update log in SQLite plus plain-object records for queries,
// search, activity and the mirror. Only the records stay in memory for all documents; a Y.Doc is
// loaded from its snapshot and later log rows on use, and dropped again by trim().
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
import type { TextVersion as Version } from "@obtion/core/api";
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
const FLUSH_DELAY_MS = 250;
const EVENT_MERGE_WINDOW_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const MAX_UNDO_CHAIN = 20;

export class Store {
  db: Database;
  /** LRU order, oldest first. Not every document is here. */
  loaded = new Map<string, Y.Doc>();
  /** Also for documents not in memory, since sync's area check needs it. */
  private areas = new Map<string, string>();
  records = new Map<string, Item>();
  searchIndex: SearchIndex = createIndex();
  seq = 0;
  lastUid = "";
  private listeners = new Set<Listener>();
  private pending = new Map<string, { origins: Set<string>; quiet: boolean; step?: string }>();
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
      CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, data BLOB NOT NULL, origin TEXT NOT NULL, ts INTEGER NOT NULL, uid TEXT, step TEXT, area TEXT NOT NULL DEFAULT '${PERSONAL}');
      CREATE INDEX IF NOT EXISTS updates_doc ON updates(doc, seq);
      CREATE INDEX IF NOT EXISTS updates_step ON updates(step);
      CREATE INDEX IF NOT EXISTS updates_area ON updates(area, seq);
      CREATE TABLE IF NOT EXISTS docstate (id TEXT PRIMARY KEY, state BLOB NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, doc TEXT NOT NULL, title TEXT, type TEXT, kind TEXT, origin TEXT, changes TEXT, step TEXT, area TEXT NOT NULL DEFAULT '${PERSONAL}');
      CREATE INDEX IF NOT EXISTS events_doc ON events(doc, id);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, actor TEXT, ts INTEGER, undoes TEXT);
      CREATE INDEX IF NOT EXISTS steps_undoes ON steps(undoes);
      CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, ts INTEGER NOT NULL, origin TEXT NOT NULL, step TEXT, event INTEGER, len INTEGER NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS versions_doc ON versions(doc, id);
      CREATE INDEX IF NOT EXISTS versions_event ON versions(event);
    `);
    this.load();
    // the server was called hub before; renaming the key would look like a new server to devices
    if (!this.kvGet("hubId")) this.kvSet("hubId", newId());
  }

  /** A device seeing a different id knows it met a new server. */
  get serverId(): string {
    return this.kvGet("hubId")!;
  }

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

  /** For passes over all documents. Docs not in memory are read for the caller and not kept. */
  *eachDoc(): Generator<[string, Y.Doc]> {
    // a doc without snapshot has only log rows (a crash before its first flush)
    const ids = this.db.query("SELECT id FROM docstate UNION SELECT doc FROM updates").all() as { id: string }[];
    for (const { id } of ids) {
      const doc = this.loaded.get(id) ?? this.read(id);
      if (doc) yield [id, doc];
    }
  }

  private stored(id: string): Uint8Array[] {
    const snap = this.db.query("SELECT state, seq FROM docstate WHERE id = ?").get(id) as { state: Uint8Array; seq: number } | null;
    const rows = this.db.query("SELECT data FROM updates WHERE doc = ? AND seq > ? ORDER BY seq").all(id, snap?.seq ?? 0) as { data: Uint8Array }[];
    return [...(snap ? [snap.state] : []), ...rows.map((r) => r.data)];
  }

  private read(id: string): Y.Doc | null {
    const parts = this.stored(id);
    if (!parts.length) return null;
    const doc = new Y.Doc({ guid: id, gc: true });
    for (const u of parts) Y.applyUpdate(doc, u, REMOTE);
    return doc;
  }

  /** Unknown ids get a new, empty doc. */
  getDoc(id: string): Y.Doc {
    let doc = this.loaded.get(id);
    if (doc) {
      this.loaded.delete(id); // re-insert to mark it most recently used
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
   * Never drops a doc with changes not yet in its snapshot or during an atomic call, so reloading
   * it from the database gives exactly the state it had.
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

  /** Does not load the document into memory. */
  stateOf(id: string): Uint8Array {
    const doc = this.loaded.get(id);
    if (doc) return Y.encodeStateAsUpdate(doc);
    const parts = this.stored(id); // rows after the snapshot exist only after a crash before a flush
    if (parts.length === 1) return parts[0]!;
    if (parts.length) return Y.mergeUpdates(parts);
    return Y.encodeStateAsUpdate(new Y.Doc());
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

  /** Documents from before areas are personal; undefined if unknown. */
  areaOf(docId: string): string | undefined {
    return this.areas.get(docId);
  }

  /** Returns the sequence number. Throws AreaError for a document of another area: areas never mix through sync. */
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
   * Devices with a wrong clock: timestamps too far ahead are set back to now, so "geändert",
   * sorting and the activity don't jump. The fix syncs like any change.
   */
  private capFuture(docId: string) {
    const doc = this.getDoc(docId);
    const max = Date.now() + MAX_CLOCK_SKEW_MS;
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
          arr.insert(i, [{ ...(u as UpdateEntry), at: now }]);
        }
      },
      { quiet: true },
    );
  }

  /** Every change `fn` makes carries one step id, so one undo takes it all back. Nested calls join the outer step. */
  step<T>(actor: string, fn: (step: string) => T, opts: { undoes?: string } = {}): T {
    if (this.stepCtx) return fn(this.stepCtx.id);
    this.stepCtx = { id: "s" + newId(), actor, undoes: opts.undoes };
    try {
      return fn(this.stepCtx.id);
    } finally {
      this.stepCtx = null;
    }
  }

  /** For changes made on the server itself (tools, imports). */
  change(docId: string, origin: string, fn: (doc: Y.Doc) => void, opts: { quiet?: boolean } = {}): void {
    const doc = this.getDoc(docId);
    const sv = Y.encodeStateVector(doc);
    doc.transact(() => fn(doc), this.stepCtx ? { actor: origin, step: this.stepCtx.id } : origin);
    this.noteArea(docId, doc);
    const update = Y.encodeStateAsUpdate(doc, sv);
    if (update.length <= 2) return; // an empty Yjs update is 2 bytes
    this.append(docId, update, origin, undefined, opts.quiet, this.stepCtx?.id);
  }

  create(init: ItemInit, origin: string, opts: { id?: string; quiet?: boolean } = {}): string {
    const id = opts.id ?? newId();
    this.change(id, origin, (doc) => initItem(doc, { createdBy: origin, ...init }), opts);
    this.flush();
    return id;
  }

  /**
   * All or nothing. Changes are visible to reads at once but reach the log, devices and activity
   * only if `fn` returns. On a throw every touched document is reloaded from the database.
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
        for (const [id, prev] of this.heldPrev) {
          if (prev) this.records.set(id, prev);
          else this.records.delete(id);
        }
        for (const h of held) this.append(h.docId, h.data, h.origin, undefined, h.quiet, h.step);
        this.flush();
      } else if (!ok) this.reload([...new Set(held.map((h) => h.docId))]);
      this.heldPrev.clear();
    }
  }

  /** Drops changes that never reached the log. */
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
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
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
    for (const [id, was] of viaBefore) {
      const rec = this.records.get(id)!;
      if (prevs.has(id) || rec.deleted === was) continue;
      indexRecord(this.searchIndex, rec);
      changed.push(rec);
    }
    this.db.transaction(() => {
      for (const [id, p] of pending) {
        const doc = this.getDoc(id);
        saveSnap.run(id, Y.encodeStateAsUpdate(doc), this.seq);
        if (!prevs.has(id)) continue;
        const prev = prevs.get(id);
        const next = this.records.get(id)!;
        indexRecord(this.searchIndex, next);
        changed.push(next);
        const origin = [...p.origins].join(", ");
        const ts = Date.now();
        const step = p.step;
        // the settings doc shows only with its rules for agents (the workspace's)
        const event = p.quiet || (next.kind === "settings" && (!prev || prev.rules === next.rules)) ? undefined : this.saveEvent(id, prev, next, origin, step, ts, events);
        if (prev && prev.body !== next.body && hasBody(next)) this.saveVersion(id, prev, next, origin, step, ts, event);
      }
    })();
    this._ix = null;
    this.scheduleTrim();
    for (const r of changed) for (const l of this.listeners) l.record?.(r);
    for (const e of events) for (const l of this.listeners) l.event?.(e);
  }

  /**
   * The activity entry for a change of one document, unless it is not worth one. Returns the
   * entry's id and whether the change was folded into the entry before it.
   */
  private saveEvent(id: string, prev: Item | undefined, next: Item, origin: string, step: string | undefined, ts: number, out: ActivityEvent[]): { id: number; merged: boolean } | undefined {
    const { kind, changes } = diffRecords(prev, next);
    if (kind === "updated" && changes.length === 0) return undefined;
    // Blank drafts (created, then left empty) are not worth an activity entry.
    const blank = !next.title.trim() && !next.body.trim();
    if (blank && (kind === "created" || kind === "deleted")) return undefined;
    // Typing flushes constantly: fold consecutive edits by one author into one entry, but only
    // within one step, so every entry can still be undone on its own.
    const last = this.db.query("SELECT id, ts, kind, origin, changes, step FROM events WHERE doc = ? ORDER BY id DESC LIMIT 1").get(id) as
      | { id: number; ts: number; kind: string; origin: string; changes: string; step: string | null }
      | null;
    const diff = changes.some((c) => c.field === "body") && hasBody(next);
    if (kind === "updated" && last && last.kind === "updated" && last.origin === origin && (last.step ?? undefined) === step && ts - last.ts < EVENT_MERGE_WINDOW_MS) {
      const merged = mergeChanges(JSON.parse(last.changes || "[]"), changes);
      this.db.query("UPDATE events SET ts = ?, title = ?, changes = ? WHERE id = ?").run(ts, next.title, JSON.stringify(merged), last.id);
      out.push({ id: last.id, ts, doc: id, title: next.title, type: typeTag(next), kind, origin, changes: markDiff(merged, diff || this.hasVersions(last.id)), step });
      return { id: last.id, merged: true };
    }
    const row = this.db
      .query("INSERT INTO events (ts, doc, title, type, kind, origin, changes, step, area) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .get(ts, id, next.title, typeTag(next), kind, origin, JSON.stringify(changes), step ?? null, next.area) as { id: number };
    out.push({ id: row.id, ts, doc: id, title: next.title, type: typeTag(next), kind, origin, changes: markDiff(changes, diff), step });
    return { id: row.id, merged: false };
  }

  // ---------- versions of the body ----------
  //
  // Every change of an item's text keeps the whole new text (deflated) in `versions`, so any
  // earlier version can be shown, compared and restored. Versions fold like activity entries:
  // the same author in the same step within the merge window updates the newest version instead
  // of adding one – typing a paragraph makes one version, not one per keystroke. The first time
  // an item that has no version yet changes, the text it was created with is kept first, so its
  // history starts with it. Versions are never dropped: a text edited in a
  // hundred sessions costs a hundred compressed copies – a few MB for long, busy pages, which
  // is small next to the update log that keeps every keystroke anyway. Backups copy the whole
  // database (VACUUM INTO), versions included.

  /** Keep the new text of a document whose body changed (see above). */
  private saveVersion(id: string, prev: Item, next: Item, origin: string, step: string | undefined, ts: number, event?: { id: number; merged: boolean }) {
    const last = this.db.query("SELECT id, ts, origin, step, event FROM versions WHERE doc = ? ORDER BY id DESC LIMIT 1").get(id) as
      | { id: number; ts: number; origin: string; step: string | null; event: number | null }
      | null;
    const insert = this.db.query("INSERT INTO versions (doc, ts, origin, step, event, len, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
    if (!last && prev.body) insert.run(id, prev.created, prev.createdBy ?? "", null, null, prev.body.length, pack(prev.body));
    const fold = last && (event ? event.merged && last.event === event.id : last.event === null && last.origin === origin && (last.step ?? undefined) === step && ts - last.ts < EVENT_MERGE_WINDOW_MS);
    if (fold) this.db.query("UPDATE versions SET ts = ?, len = ?, data = ? WHERE id = ?").run(ts, next.body.length, pack(next.body), last.id);
    else insert.run(id, ts, origin, step ?? null, event?.id ?? null, next.body.length, pack(next.body));
  }

  private hasVersions(event: number): boolean {
    return !!this.db.query("SELECT 1 FROM versions WHERE event = ? LIMIT 1").get(event);
  }

  /** The versions of a document's text, oldest first, numbered from 1 (the number stays: versions are never dropped). */
  versions(doc: string): Version[] {
    const rows = this.db.query("SELECT id, ts, origin, step, event, len FROM versions WHERE doc = ? ORDER BY id").all(doc) as (Omit<Version, "n" | "step" | "event"> & { step: string | null; event: number | null })[];
    return rows.map((r, i) => ({ ...r, n: i + 1, step: r.step ?? undefined, event: r.event ?? undefined }));
  }

  /** The text of a version by its id (undefined if unknown, or of another document when `doc` is given). */
  versionText(id: number, doc?: string): string | undefined {
    const row = this.db.query("SELECT doc, data FROM versions WHERE id = ?").get(id) as { doc: string; data: Uint8Array } | null;
    if (!row || (doc !== undefined && row.doc !== doc)) return undefined;
    return unpack(row.data);
  }

  /**
   * What an activity entry did to the text: the version before it (the empty text when there is
   * none) and the last version it made. Undefined when the entry kept no version (older entries).
   */
  eventText(event: number): { doc: string; before: string; after: string; from?: number; to: number } | undefined {
    const mine = this.db.query("SELECT id, doc FROM versions WHERE event = ? ORDER BY id").all(event) as { id: number; doc: string }[];
    if (!mine.length) return undefined;
    const { doc } = mine[0]!;
    const all = this.versions(doc);
    const first = all.findIndex((v) => v.id === mine[0]!.id);
    const last = all.find((v) => v.id === mine.at(-1)!.id)!;
    const before = first > 0 ? all[first - 1] : undefined;
    return { doc, before: before ? this.versionText(before.id)! : "", after: this.versionText(last.id)!, from: before?.n, to: last.n };
  }

  // ---------- reading ----------

  /**
   * False if the cursor lies beyond the log or the row there has another uid. Then the server came
   * from an older backup, and other devices may have synced since, so seq alone can't tell.
   */
  knowsCursor(area: string, since: number, sinceId?: string): boolean {
    if (since <= 0) return true;
    if (since > this.last(area).seq) return false;
    if (!sinceId) return true; // replica from before cursor ids: seq is all we can check
    const row = this.db.query("SELECT uid, area FROM updates WHERE seq = ?").get(since) as { uid: string; area: string } | null;
    return row?.uid === sinceId && row.area === area;
  }

  /** The position a replica of the area has after catching up. */
  last(area: string): { seq: number; uid: string } {
    const row = this.db.query("SELECT seq, uid FROM updates WHERE area = ? ORDER BY seq DESC LIMIT 1").get(area) as { seq: number; uid: string } | null;
    return row ?? { seq: 0, uid: "" };
  }

  docsSince(area: string, since: number): string[] {
    if (since <= 0) return [...this.areas].filter(([, a]) => a === area).map(([id]) => id);
    const rows = this.db.query("SELECT DISTINCT doc FROM updates WHERE area = ? AND seq > ?").all(area, since) as { doc: string }[];
    return rows.map((r) => r.doc);
  }

  live(): Item[] {
    return [...this.records.values()].filter(isContent);
  }

  /** Rebuilt lazily after each flush. */
  index(): Index {
    if (!this._ix) this._ix = new Index(this.records);
    return this._ix;
  }

  /** Undefined before the setup. */
  setupLang(): Lang | undefined {
    return this.records.get(SETTINGS_ID)?.settings?.setupLang as Lang | undefined;
  }

  lang(): Lang {
    return this.setupLang() ?? "de";
  }

  /**
   * Activity entries. Newest first by id; with `after` (a feed position: time of an entry's last
   * change, then its id) the ones changed after it, oldest change first. `docs`: only these.
   */
  events(opts: { since?: number; doc?: string; docs?: string[]; limit?: number; before?: number; after?: { ts: number; id: number } } = {}): ActivityEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const filter = (cond: string, value: string | number) => {
      where.push(cond);
      args.push(value);
    };
    if (opts.since) filter("ts >= ?", opts.since);
    if (opts.before) filter("id < ?", opts.before);
    if (opts.doc) filter("doc = ?", opts.doc);
    if (opts.after) {
      where.push("(ts > ? OR (ts = ? AND id > ?))");
      args.push(opts.after.ts, opts.after.ts, opts.after.id);
    }
    if (opts.docs) filter("doc IN (SELECT value FROM json_each(?))", JSON.stringify(opts.docs));
    const order = opts.after ? "ts, id" : "id DESC";
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ?`;
    args.push(opts.limit ?? 50);
    const found = this.db.query(sql).all(...args) as (Omit<ActivityEvent, "step" | "changes"> & { step: string | null; changes: string | null })[];
    const rows: ActivityEvent[] = found.map((r) => ({ ...r, step: r.step ?? undefined, changes: JSON.parse(r.changes || "[]") }));
    for (const e of rows) if (e.step) Object.assign(e, this.stepState(e.step));
    const withBody = rows.filter((e) => e.changes.some((c) => c.field === "body")).map((e) => e.id);
    if (withBody.length) {
      const known = new Set((this.db.query("SELECT DISTINCT event FROM versions WHERE event IN (SELECT value FROM json_each(?))").all(JSON.stringify(withBody)) as { event: number }[]).map((r) => r.event));
      for (const e of rows) if (known.has(e.id)) e.changes = markDiff(e.changes, true);
    }
    return rows;
  }

  /** `redo` marks an undo of an undo. */
  stepState(step: string): { undoes?: string; redo?: boolean } {
    const q = this.db.query("SELECT undoes FROM steps WHERE id = ?");
    const row = q.get(step) as { undoes: string | null } | null;
    const target = row?.undoes ? (q.get(row.undoes) as { undoes: string | null } | null) : null;
    return { undoes: row?.undoes ?? undefined, redo: !!target?.undoes || undefined };
  }

  /** The undo that currently takes this step back, itself not undone. */
  activeUndo(step: string, depth = 0): string | undefined {
    if (depth > MAX_UNDO_CHAIN) return undefined;
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

/** Items whose text has versions: informations and files (not settings, not operations). */
const hasBody = (i: Item) => i.kind === "info" || i.kind === "datei" || i.kind === "zeichnung";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const pack = (text: string) => Bun.deflateSync(utf8.encode(text));
const unpack = (data: Uint8Array) => fromUtf8.decode(Bun.inflateSync(data as Uint8Array<ArrayBuffer>));

/** The body change of an entry, marked when its versions can show what changed (`diff`). */
function markDiff(changes: FieldChange[], diff: boolean): FieldChange[] {
  return diff ? changes.map((c) => (c.field === "body" ? { ...c, diff: true } : c)) : changes;
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hasDeleteSet(update: Uint8Array) {
  // A pure-deletion update does not advance the state vector. Decode to check.
  try {
    const decoded = Y.decodeUpdate(update);
    return decoded.ds.clients.size > 0;
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
      for (const x of [...added]) {
        if (!removed.has(x)) continue;
        added.delete(x);
        removed.delete(x);
      }
      prev.to = [...added];
      prev.from = [...removed];
    } else prev.to = c.to;
  }
  // Drop fields that ended where they started. The body only has lengths here, and equal lengths can be another text.
  return out.filter((c) => c.field === "update" || c.field === "schema" || c.field === "body" || moved(c));
}

function moved(c: FieldChange): boolean {
  if (!Array.isArray(c.to)) return c.from !== c.to;
  return c.to.length > 0 || ((c.from as unknown[]) ?? []).length > 0;
}

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
  if (prev.rules !== next.rules) changes.push({ field: "rules", from: prev.rules.length, to: next.rules.length });
  if (next.updates.length > prev.updates.length) for (const e of next.updates.slice(prev.updates.length)) changes.push({ field: "update", to: e.text });
  // views count separately from the schema so their changes show in the activity and can be undone
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
