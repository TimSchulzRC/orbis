// Sources are only read. Re-running is safe: the same source gives the same item (source key or
// deterministic id).
import { type Stats, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  type PropDef,
  type PropKind,
  type TypeSchema,
  type Value,
  META_TYPE,
  addParent,
  fileTypeOf,
  initItem,
  initSchema,
  mimeOf,
  newId,
  normalizeTag,
  parseWikiLinks,
  setFileMeta,
  setMember,
  setMeta,
  setRel,
  titleKey,
} from "@obtion/core/model";
import { type Lang, CATALOGS, translate } from "@obtion/core/i18n";
import { SYS, defaultTypes, runSetup, type Writer } from "@obtion/core/setup";
import { EXAMPLE_ORIGIN, addExamples, fileFacts } from "@obtion/core/examples";
import { nextPinKey } from "@obtion/core/sortkey";
import { dueProp, statusProp } from "@obtion/core/traits";
import type { Store } from "./store";
import { type Blobs, sha256 } from "./blobs";

/** Also the origin of upgrades to shipped types. */
export const SETUP_ORIGIN = "system:setup";

export function storeWriter(store: Store, origin: string, quiet = true): Writer {
  return {
    change: (id, fn) => store.change(id, origin, fn, { quiet }),
    get: (id) => store.records.get(id),
  };
}

/** Same code the setup page runs. */
export async function setUp(store: Store, blobs: Blobs, lang: Lang, opts: { examples?: boolean; quiet?: boolean } = {}) {
  runSetup(storeWriter(store, SETUP_ORIGIN, opts.quiet), lang, SETUP_ORIGIN);
  if (opts.examples)
    await addExamples(storeWriter(store, EXAMPLE_ORIGIN, opts.quiet), lang, async (f) => {
      const hash = sha256(f.bytes);
      await blobs.put(hash, f.bytes);
      return fileFacts(f, hash);
    });
  store.flush();
}

export type Log = (msg: string) => void;

/** Old English status names from Notion → setup keys, to match options in any language. */
const STATUS_KEYS: Record<string, string> = {
  backlog: "backlog",
  planning: "planning",
  "in progress": "inProgress",
  paused: "paused",
  done: "done",
  canceled: "canceled",
  cancelled: "canceled",
  "not started": "notStarted",
  aborted: "dropped",
  archived: "archived",
};
const STATUS_GROUP: Record<string, "todo" | "active" | "done"> = {
  backlog: "todo",
  "not started": "todo",
  planning: "active",
  "in progress": "active",
  paused: "active",
  done: "done",
  canceled: "done",
  cancelled: "done",
  aborted: "done",
  archived: "done",
};

/** Match by name, then the same status in another language, then by group. */
function statusOption(schema: TypeSchema | undefined, name?: string): string | undefined {
  const p = statusProp(schema);
  if (!p || !name) return undefined;
  const k = titleKey(name);
  const names = [k];
  const key = STATUS_KEYS[k];
  if (key) for (const lang of Object.keys(CATALOGS) as Lang[]) names.push(translate(lang, `setup.status.${key}`).toLowerCase());
  const hit = p.options?.find((o) => names.includes(o.name.toLowerCase()));
  if (hit) return hit.id;
  const group = STATUS_GROUP[k];
  return group ? p.options?.find((o) => (o.group ?? "todo") === group)?.id : undefined;
}

/** The shipped property, or one with its name in any language. */
function columnProp(schema: TypeSchema | undefined, id: string, key: string, kind: PropKind): PropDef | undefined {
  const names = (Object.keys(CATALOGS) as Lang[]).map((l) => translate(l, `setup.prop.${key}`).toLowerCase());
  return schema?.properties.find((x) => x.kind === kind && (x.id === id || names.includes(x.name.toLowerCase())));
}

function priorityOption(p: PropDef | undefined, name?: string): string | undefined {
  if (!name || !p?.options) return undefined;
  const k = name.toLowerCase();
  const key = { high: "high", medium: "medium", low: "low" }[k];
  const names = [k, ...(key ? (Object.keys(CATALOGS) as Lang[]).map((l) => translate(l, `setup.priority.${key}`).toLowerCase()) : [])];
  return p.options.find((o) => names.includes(o.name.toLowerCase()))?.id;
}

const AREA_KEY: Record<string, string> = { work: "work", arbeit: "work", study: "study", "studium informatik": "study", studium: "study", personal: "personal", persönlich: "personal", business: "business", gewerbe: "business" };
const AREA_NAME: Record<string, Record<Lang, string>> = {
  work: { de: "Arbeit", en: "Work" },
  study: { de: "Studium", en: "Study" },
  personal: { de: "Persönlich", en: "Personal" },
  business: { de: "Gewerbe", en: "Business" },
};

/** "Work (MOC)" → "work" */
function areaOfTitle(title: string): string | undefined {
  const k = titleKey(title.replace(/\s*\(MOC\)\s*$/i, ""));
  return AREA_KEY[k];
}

function areaName(area: string, lang: Lang): string {
  const k = AREA_KEY[area.toLowerCase()];
  return k ? AREA_NAME[k]![lang] : area;
}

/** `ref` is an id or name. A missing default type is created from the shipped definition. */
function ensureType(w: Writer, ref: string, lang: Lang, store: Store): string {
  const ix = store.index();
  if (ix.types.has(ref)) return ref;
  const byName = ix.typeByName(ref);
  if (byName) return byName;
  const specs = defaultTypes(lang);
  const spec = specs[ref];
  if (spec) {
    const cur = store.records.get(ref);
    w.change(ref, (doc) => {
      if (!cur) initItem(doc, { type: META_TYPE, title: spec.name });
      else doc.getMap("meta").delete("deleted");
      initSchema(doc, spec);
    });
    store.flush();
    return ref;
  }
  const id = newId();
  w.change(id, (doc) => {
    initItem(doc, { type: META_TYPE, title: ref });
    initSchema(doc, { name: ref, icon: "circle", color: "teal", description: "", capabilities: {} });
  });
  store.flush();
  return id;
}

function nextPin(store: Store): string {
  return nextPinKey(store.live());
}

/** Untyped and pinned, so it shows as an overview once it has children. Created if missing. */
function ensurePinnedOverview(w: Writer, store: Store, title: string): string {
  const ix = store.index();
  const hit = ix.live.find((i) => i.kind === "info" && titleKey(i.title) === titleKey(title) && ix.parentsOf(i.id).length === 0 && (i.pinned || !i.type));
  if (hit) {
    if (!hit.pinned) w.change(hit.id, (doc) => setMeta(doc, { pinned: nextPin(store) }));
    store.flush();
    return hit.id;
  }
  const id = newId();
  w.change(id, (doc) => initItem(doc, { title, pinned: nextPin(store) }));
  store.flush();
  return id;
}

function pinTopLevel(w: Writer, store: Store, ids: string[]): number {
  const ix = store.index();
  let n = 0;
  for (const id of ids) {
    const i = ix.get(id);
    if (!i || i.pinned || ix.parentsOf(id).length) continue;
    w.change(id, (doc) => setMeta(doc, { pinned: nextPin(store) }));
    store.flush();
    n++;
  }
  return n;
}

// birth time where the file system keeps one, else mtime
const createdAt = (st: Stats) => Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs);

async function importFile(w: Writer, store: Store, blobs: Blobs, path: string, opts: { created?: number; source?: string } = {}): Promise<string> {
  const hash = await blobs.putFile(path);
  const name = basename(path);
  // same content and name = same item; a copy under another name stays linkable by that name
  const id = "f_" + hash.slice(0, 20) + Bun.hash(name).toString(36).slice(0, 6);
  if (store.records.get(id)) return id;
  const st = statSync(path);
  const mime = mimeOf(name);
  w.change(id, (doc) => {
    initItem(doc, { kind: "datei", title: name, created: opts.created ?? createdAt(st), source: opts.source });
    setFileMeta(doc, { hash, name, mime, filetype: fileTypeOf(name, mime), size: st.size });
  });
  return id;
}

const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "Calendar", "Extras", "Excalidraw", "textgenerator", ".stfolder"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

function parseCreated(s?: string): number | undefined {
  const m = s?.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return undefined;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00`).getTime();
}

interface ObsidianOptions {
  lang: Lang;
  mocParents: boolean;
}

/**
 * Encounters go to the inbox, cards become Karte, MOCs untyped items below the area's pinned
 * overview (top-level ones pinned). Folders become tags, Refs:: explicit refs.
 */
export async function importObsidian(store: Store, blobs: Blobs, vault: string, opts: ObsidianOptions, log: Log) {
  const origin = "import:obsidian";
  const w = storeWriter(store, origin);
  const card = store.index().types.has(SYS.card) ? SYS.card : ensureType(w, SYS.card, opts.lang, store);
  const existing = new Set([...store.records.values()].map((r) => r.source).filter(Boolean));
  const files = walk(vault);
  const attachments = new Map<string, string>();
  const indexFiles = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".obsidian" || name === ".trash") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) indexFiles(p);
      else if (!name.endsWith(".md")) attachments.set(name, p);
    }
  };
  indexFiles(vault);
  const AREA: Record<string, string> = { Arbeit: "work", "Studium Informatik": "study", Personal: "personal" };
  const pendingRefs: { id: string; refs: string[] }[] = [];
  const maps: string[] = [];
  let made = 0;
  let skipped = 0;
  for (const path of files) {
    const rel = relative(vault, path);
    const source = `obsidian:${rel}`;
    if (existing.has(source)) {
      skipped++;
      continue;
    }
    const parts = rel.split("/");
    const top = parts[0]!;
    if (rel === "Home 🏠.md" || (top === "Atlas" && !rel.includes("MOCs"))) continue;
    const raw = readFileSync(path, "utf8");
    const st = statSync(path);
    let text = raw.replace(/\r\n/g, "\n");
    let tags: string[] = [];
    const refs: string[] = [];
    let created: number | undefined;
    const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fm) {
      try {
        const y = (Bun.YAML.parse(fm[1]!) ?? {}) as Record<string, any>;
        const t = y.tags ?? y.Tags;
        if (Array.isArray(t)) tags.push(...t.map(String));
        else if (typeof t === "string") tags.push(...t.split(/[ ,]+/));
        if (y.created) created = Date.parse(y.created) || undefined;
      } catch (e) {
        log(`${rel}: frontmatter not read (${(e as Error).message})`);
      }
      text = text.slice(fm[0].length);
    }
    const out: string[] = [];
    for (const line of text.split("\n")) {
      if (/^\[\[Home 🏠\]\]/.test(line)) {
        created = parseCreated(line) ?? created;
        continue;
      }
      const tm = line.match(/^Tags::(.*)$/);
      if (tm) {
        tags.push(...(tm[1]!.match(/#[^\s#]+/g) ?? []));
        continue;
      }
      const rm = line.match(/^Refs::(.*)$/);
      if (rm) {
        refs.push(...parseWikiLinks(rm[1]!).map((l) => l.target));
        continue;
      }
      if (/^`=.*`\s*$/.test(line.trim())) continue;
      out.push(line);
    }
    const body = out.join("\n").replace(/^(?:[ \t]*(?:___)?[ \t]*\n)+/, "").trim();
    const title = basename(path, ".md");
    if (!body && !refs.length && (!tags.length || /^Unbenannt|^Untitled|\.pdf$/i.test(title))) continue;
    let type: string | null = card;
    if (top === "Encounters" || top === "Readwise") type = null;
    const isMap = rel.includes("• MOCs") || tags.some((t) => /^#?map$/i.test(t));
    if (isMap) type = null; // its children make it an overview
    let area = isMap ? areaOfTitle(title) : undefined;
    if (top === "Spaces") {
      area = AREA[parts[1]!];
      tags.push(...parts.slice(2, -1).filter((p) => !["Areas", "Projects", "• MOCs"].includes(p)));
      if (area && !isMap) tags.push(areaName(area, opts.lang));
    }
    if (top === "Sources") tags.push("source", parts[1] ?? "");
    if (top === "Readwise") tags.push("readwise", parts[1] ?? "");
    tags = [...new Set(tags.map(normalizeTag).filter((t) => t && t !== "map" && !/^[0-9a-f]{6}$/i.test(t)))];
    const parents = isMap && area ? [ensurePinnedOverview(w, store, areaName(area, opts.lang))] : [];
    for (const l of parseWikiLinks(body)) {
      const src = attachments.get(basename(l.target));
      if (src) await importFile(w, store, blobs, src, { source: `obsidian-file:${basename(l.target)}` });
    }
    const id = newId();
    w.change(id, (doc) =>
      initItem(doc, { title, body, tags, type, parents, source, created: created ?? createdAt(st), updated: st.mtimeMs }),
    );
    if (refs.length) pendingRefs.push({ id, refs });
    if (isMap) maps.push(id);
    made++;
  }
  store.flush();
  const ix = store.index();
  let refCount = 0;
  for (const p of pendingRefs)
    w.change(p.id, (doc) => {
      for (const t of p.refs) {
        const target = ix.resolveTitle(t);
        if (target && target !== p.id) (setMember(doc, "refs", target, true), refCount++);
      }
    });
  let placed = 0;
  if (opts.mocParents)
    for (const m of maps) {
      const map = ix.get(m)!;
      for (const l of ix.textLinks(map)) {
        const target = ix.get(l.to);
        if (!target || target.type !== card || ix.wouldCycle(target.id, m)) continue;
        w.change(target.id, (doc) => addParent(doc, m, undefined, map.created));
        placed++;
      }
    }
  store.flush();
  const pinned = pinTopLevel(w, store, maps);
  store.logEvent(`Imported ${made} notes from Obsidian`, origin);
  log(`Obsidian: ${made} notes (${skipped} already there), ${refCount} Refs:: resolved, ${placed} cards placed below MOCs, ${pinned} top-level MOCs pinned.`);
}

interface NotionOptions {
  lang: Lang;
  projectType: string; // id or name; created if missing
  taskType: string;
}

interface NotionExport {
  projects: { id: string; title: string; area?: string; status?: string; priority?: string; start?: string; end?: string; summary?: string; created: string }[];
  tasks: [id: string, title: string, status: string | null, priority: string | null, due: string | null, tags: string[], project: string | null, parent: string | null, blockedBy: string[], created: string][];
}

/** Projects go below the area's pinned overview, tasks below their project or parent task. */
export function importNotion(store: Store, file: string, opts: NotionOptions, log: Log) {
  const origin = "import:notion";
  const w = storeWriter(store, origin);
  const data: NotionExport = JSON.parse(readFileSync(file, "utf8"));
  const projectType = ensureType(w, opts.projectType, opts.lang, store);
  const taskType = ensureType(w, opts.taskType, opts.lang, store);
  const ix = store.index();
  const ps = ix.types.get(projectType)!.schema;
  const ts = ix.types.get(taskType)!.schema;
  const idFor = (nid: string) => "n_" + nid;
  let made = 0;
  for (const p of data.projects) {
    if (store.records.get(idFor(p.id))) continue;
    const parents = p.area ? [ensurePinnedOverview(w, store, areaName(p.area, opts.lang))] : [];
    const props: Record<string, Value> = {};
    const st = statusOption(ps, p.status);
    if (st && statusProp(ps)) props[statusProp(ps)!.id] = st;
    const prio = columnProp(ps, "p_priority", "priority", "select");
    const pr = priorityOption(prio, p.priority);
    if (pr) props[prio!.id] = pr;
    const period = columnProp(ps, "p_period", "period", "date");
    if ((p.start || p.end) && period) props[period.id] = `${p.start ?? ""}/${p.end ?? ""}`;
    const summary = columnProp(ps, "p_summary", "summary", "text");
    if (p.summary && summary) props[summary.id] = p.summary;
    w.change(idFor(p.id), (doc) => initItem(doc, { title: p.title, type: projectType, parents, props, source: `notion:${p.id}`, created: Date.parse(p.created) }));
    made++;
  }
  const taskProject = new Map<string, string | null>(data.tasks.map((t) => [t[0], t[6]]));
  for (const t of data.tasks) {
    const [nid, title, status, priority, due, tags, project, parent, blockedBy, created] = t;
    if (store.records.get(idFor(nid))) continue;
    const proj = project ?? (parent ? taskProject.get(parent) : null);
    const parents = parent ? [idFor(parent)] : proj ? [idFor(proj)] : [];
    const props: Record<string, Value> = {};
    const st = statusOption(ts, status ?? undefined);
    if (st && statusProp(ts)) props[statusProp(ts)!.id] = st;
    const prio = columnProp(ts, "p_priority", "priority", "select");
    const pr = priorityOption(prio, priority ?? undefined);
    if (pr) props[prio!.id] = pr;
    const dp = dueProp(ts);
    if (due && dp) props[dp.id] = due;
    const rel = ts?.properties.find((x) => x.kind === "relation" && x.blocks);
    w.change(idFor(nid), (doc) => {
      initItem(doc, { title, type: taskType, parents, props, tags, source: `notion:${nid}`, created: Date.parse(created) });
      if (rel) for (const b of blockedBy) setRel(doc, rel.id, idFor(b), true);
    });
    made++;
  }
  store.flush();
  store.logEvent(`Imported ${made} projects and tasks from Notion`, origin);
  log(`Notion: ${made} projects/tasks.`);
}
