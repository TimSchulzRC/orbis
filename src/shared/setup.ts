// First setup: the default types (Karte, Projekt, Task) in the chosen language,
// the start page and the pinned entries. After that they are ordinary data: renamable,
// changeable, deletable. Their fixed ids (sys:*) only serve "restore default types" and imports.
import * as Y from "yjs";
import {
  type Capabilities,
  type Item,
  type PropDef,
  type ViewTab,
  FORMAT,
  META_TYPE,
  PERSONAL,
  SETTINGS_ID,
  initItem,
  initSchema,
  newId,
  readTabs,
  replaceBody,
  setMeta,
  setSchemaField,
  setSettings,
  setTabs,
  upsertProp,
} from "./model";
import { DEFAULT_INBOX_WHERE } from "./inbox";
import type { Index } from "./graph";
import { sidebarRoots } from "./placement";
import { pluralOf } from "./plural";
import { BLOCKED_BY, WAITING_FOR } from "./traits";
import { keyBetween, keysFor } from "./sortkey";
import { type Lang, LANGS, translate } from "./i18n";
import { type Cond, type QueryDef, andWhere, blockSource, tabDef } from "./query";

export const SYS = {
  card: "sys:card",
  project: "sys:project",
  task: "sys:task",
} as const;

export interface Writer {
  change(id: string, fn: (doc: Y.Doc) => void): void;
  get(id: string): Item | undefined;
}

type TypeSpec = { name: string; icon: string; color: string; description: string; capabilities: Capabilities; properties: Omit<PropDef, "sort">[] };

export function defaultTypes(lang: Lang): Record<string, TypeSpec> {
  const t = (k: string) => translate(lang, `setup.${k}`);
  const typeKey = translate(lang, "q.key.type").split(",")[0];
  const priority: Omit<PropDef, "sort"> = {
    id: "p_priority",
    name: t("prop.priority"),
    kind: "select",
    options: [
      { id: "pr_high", name: t("priority.high"), color: "red" },
      { id: "pr_medium", name: t("priority.medium"), color: "amber" },
      { id: "pr_low", name: t("priority.low"), color: "green" },
    ],
  };
  return {
    [SYS.card]: {
      name: t("card.name"),
      icon: "sticky-note",
      color: "blue",
      description: t("card.description"),
      capabilities: {},
      properties: [],
    },
    [SYS.project]: {
      name: t("project.name"),
      icon: "folder-kanban",
      color: "green",
      description: t("project.description"),
      capabilities: { status: "p_status", progress: { of: SYS.task }, updates: true, template: { body: "" }, primaryChild: SYS.task },
      properties: [
        {
          id: "p_status",
          name: t("prop.status"),
          kind: "status",
          options: [
            { id: "st_backlog", name: t("status.backlog"), group: "todo", color: "gray" },
            { id: "st_planning", name: t("status.planning"), group: "active", color: "blue" },
            { id: "st_active", name: t("status.inProgress"), group: "active", color: "amber" },
            { id: "st_paused", name: t("status.paused"), group: "active", color: "violet" },
            { id: "st_done", name: t("status.done"), group: "done", color: "green" },
            { id: "st_canceled", name: t("status.canceled"), group: "done", color: "red" },
          ],
        },
        priority,
        { id: "p_period", name: t("prop.period"), kind: "date", range: true },
        { id: "p_summary", name: t("prop.summary"), kind: "text" },
        { id: "p_progress", name: t("prop.progress"), kind: "computed", computed: { fn: "progress", of: SYS.task } },
        { id: BLOCKED_BY, name: t("prop.blockedBy"), kind: "relation", multiple: true, target: `${typeKey}:${t("task.name")} | ${typeKey}:${t("project.name")}`, inverseName: t("prop.blocking"), hideEmpty: true },
      ],
    },
    [SYS.task]: {
      name: t("task.name"),
      icon: "circle-check",
      color: "slate",
      description: t("task.description"),
      capabilities: { status: "p_status", due: "p_due", progress: { of: SYS.task }, primaryChild: SYS.task },
      properties: [
        {
          id: "p_status",
          name: t("prop.status"),
          kind: "status",
          options: [
            { id: "st_todo", name: t("status.notStarted"), group: "todo", color: "gray" },
            { id: "st_active", name: t("status.inProgress"), group: "active", color: "amber" },
            { id: "st_paused", name: t("status.paused"), group: "active", color: "violet" },
            { id: "st_done", name: t("status.done"), group: "done", color: "green" },
            { id: "st_dropped", name: t("status.dropped"), group: "done", color: "brown" },
            { id: "st_archived", name: t("status.archived"), group: "done", color: "gray" },
          ],
        },
        priority,
        { id: "p_due", name: t("prop.due"), kind: "date" },
        { id: BLOCKED_BY, name: t("prop.blockedBy"), kind: "relation", multiple: true, target: `${typeKey}:${t("task.name")} | ${typeKey}:${t("project.name")}`, inverseName: t("prop.blocking"), hideEmpty: true },
        { id: WAITING_FOR, name: t("prop.waitingFor"), kind: "text", hideEmpty: true },
      ],
    },
  };
}

function createType(w: Writer, id: string, spec: TypeSpec, origin?: string) {
  w.change(id, (doc) => {
    initItem(doc, { kind: "info", type: META_TYPE, title: spec.name, createdBy: origin });
    initSchema(doc, spec);
  });
}

/**
 * Properties shipped later than a default type: added to existing default types once, unless
 * the type already has (or had and removed) them. Nothing else is touched.
 */
const LATER_PROPS = [WAITING_FOR, BLOCKED_BY];
export function addLaterDefaultProps(w: Writer, lang: Lang): string[] {
  const changed: string[] = [];
  for (const [id, spec] of Object.entries(defaultTypes(lang))) {
    const cur = w.get(id);
    if (!cur?.schema || cur.deleted) continue;
    const known = new Set([...cur.schema.properties, ...cur.schema.removedProperties].map((p) => p.id));
    const missing = spec.properties.filter((p) => LATER_PROPS.includes(p.id) && !known.has(p.id));
    if (!missing.length) continue;
    w.change(id, (doc) => {
      for (const p of missing) upsertProp(doc, p.id, p); // appended after the existing ones
    });
    changed.push(id);
  }
  return changed;
}

/**
 * Shipped labels renamed later: changed on existing default types only while they still carry
 * the old shipped wording (a name the user chose stays).
 */
const RENAMED: { type: string; prop: string; field: "inverseName"; was: Record<Lang, string>; key: string }[] = [
  { type: SYS.task, prop: BLOCKED_BY, field: "inverseName", was: { de: "Blockiert", en: "Blocking" }, key: "setup.prop.blocking" },
];
export function renameShippedLabels(w: Writer, lang: Lang): number {
  let n = 0;
  for (const r of RENAMED) {
    const p = w.get(r.type)?.schema?.properties.find((x) => x.id === r.prop);
    if (!p || p[r.field] !== r.was[lang]) continue;
    w.change(r.type, (doc) => upsertProp(doc, r.prop, { [r.field]: translate(lang, r.key) }));
    n++;
  }
  return n;
}

/** Create the default types that are missing, undelete deleted ones. Returns what changed. */
export function restoreDefaultTypes(w: Writer, lang: Lang, origin?: string): string[] {
  const specs = defaultTypes(lang);
  const changed: string[] = [];
  for (const [id, spec] of Object.entries(specs)) {
    const cur = w.get(id);
    if (!cur) {
      createType(w, id, spec, origin);
      changed.push(id);
    } else if (cur.deleted) {
      w.change(id, (doc) => setMeta(doc, { deleted: null }));
      changed.push(id);
    }
  }
  return changed;
}

/**
 * The start page: focus (overdue, today, 7 days, in progress – nothing from paused or finished
 * projects, nothing twice), active projects with their next task, inbox, recently done,
 * recently edited. All saved queries, so the page is ordinary, editable text.
 * Earlier shipped versions stay here (by number) so an unchanged page can be brought up to date.
 */
export function defaultStartBody(lang: Lang, version = START_VERSION): string {
  const t = (k: string) => translate(lang, `setup.start.${k}`);
  const block = (q: QueryDef) => "```abfrage\n" + blockSource(q) + "\n```";
  const open = { status: "open" as const };
  const awake = version >= 2 ? [{ not: { dormant: true as const } }] : [];
  const notSoon = version >= 3 ? [{ not: { prop: "due", op: "<=" as const, value: "+7d" } }] : [];
  const focus = [
    `## ${t("focus")}`,
    block({ title: t("overdue"), hideEmpty: true, where: { and: [open, ...awake, { prop: "due", op: "<", value: "+0d" }] }, sort: [{ key: "due" }] }),
    block({ title: t("today"), hideEmpty: true, where: { and: [open, ...awake, { prop: "due", op: ":", value: "+0d" }] } }),
    block({ title: t("week"), hideEmpty: true, where: { and: [open, ...awake, { prop: "due", op: ">", value: "+0d" }, { prop: "due", op: "<=", value: "+7d" }] }, sort: [{ key: "due" }] }),
    block({ title: t("inProgress"), hideEmpty: true, where: { and: [{ type: SYS.task }, { status: "active" }, ...awake, ...notSoon] } }),
  ];
  // since version 5 (design rules § 4.3): cards in two columns split by "---"; projects as a table
  // with progress and next task, the inbox's newest three, "Kürzlich erledigt" closed; no "recent"
  if (version >= 5)
    return [
      ...focus,
      `\n## ${t("projects")}`,
      block({ where: { and: [{ type: SYS.project }, { status: "active" }, ...awake] }, sort: [{ key: "updated", desc: true }], columns: ["progress", "next"] }),
      "\n---\n",
      `## ${t("inbox")}`,
      block({ where: { inbox: true }, sort: [{ key: "created", desc: true }], limit: 3 }),
      `\n## ${t("done")}`,
      block({ hideEmpty: true, collapsed: true, where: { and: [{ status: "done" }, { prop: "done", op: ">=", value: "-7d" }] }, sort: [{ key: "done", desc: true }], limit: 6 }),
    ].join("\n");
  return [
    ...focus,
    `\n## ${t("projects")}`,
    block(version >= 2 ? { where: { and: [{ type: SYS.project }, { status: "active" }, ...awake] }, sort: [{ key: "updated", desc: true }], columns: ["next"] } : { where: { and: [{ type: SYS.project }, { status: "active" }] }, sort: [{ key: "updated", desc: true }] }),
    `\n## ${t("inbox")}`,
    block({ where: { inbox: true }, sort: [{ key: "created", desc: true }], limit: 5 }),
    ...(version >= 2 ? [`\n## ${t("done")}`, block({ hideEmpty: true, where: { and: [{ status: "done" }, { prop: "done", op: ">=", value: "-7d" }] }, sort: [{ key: "done", desc: true }], limit: 6 })] : []),
    `\n## ${t("recent")}`,
    // since version 4 without files: an inserted image shows through the note it is in, not as an entry of its own
    block(version >= 4 ? { where: { and: [{ not: { inbox: true } }, { not: { file: true } }] }, sort: [{ key: "updated", desc: true }], limit: 6 } : { where: { not: { inbox: true } }, sort: [{ key: "updated", desc: true }], limit: 6 }),
  ].join("\n");
}
export const START_VERSION = 5;

/** A start page still exactly as an earlier version shipped it gets the current default; edited ones stay. */
export function upgradeStartPage(w: Writer, lang: Lang): boolean {
  const s = w.get(SETTINGS_ID);
  if (!s || s.body === defaultStartBody(lang)) return false;
  const earlier = Array.from({ length: START_VERSION - 1 }, (_, i) => defaultStartBody(lang, i + 1));
  if (!earlier.includes(s.body)) return false;
  w.change(SETTINGS_ID, (doc) => replaceBody(doc, defaultStartBody(lang)));
  return true;
}

export const DEFAULT_CAPTURE_TYPES = [SYS.card, SYS.task, SYS.project];

/**
 * Once: the shipped task shows "Blockiert durch" and "Wartet auf" only when set (pages show every
 * property of a type since this version). Marked in the settings, so it never runs again – if the
 * user turns the option off afterwards, it stays off.
 */
export function upgradeHideEmptyTaskFields(w: Writer): boolean {
  const KEY = "task-hide-empty-1";
  const settings = w.get(SETTINGS_ID)?.settings;
  if (!settings || settings.upgrades?.includes(KEY)) return false;
  const task = w.get(SYS.task);
  if (task?.schema)
    w.change(SYS.task, (doc) => {
      for (const id of [BLOCKED_BY, WAITING_FOR]) if (task.schema!.properties.some((p) => p.id === id)) upsertProp(doc, id, { hideEmpty: true });
    });
  w.change(SETTINGS_ID, (doc) => setSettings(doc, { upgrades: [...(settings.upgrades ?? []), KEY] }));
  return true;
}

/**
 * The views of "Projekte" and "Tasks", like a project board in Notion: what is going on grouped
 * by status, a timeline, a board, everything, a calendar; tasks by project, by progress and by
 * priority. Names and columns in the setup language (like the type names); a view named like its
 * kind keeps no name, so it follows the UI language.
 */
export function defaultViews(lang: Lang): { project: Omit<ViewTab, "pos">[]; task: Omit<ViewTab, "pos">[] } {
  const p = (k: string) => translate(lang, `setup.prop.${k}`);
  const v = (k: string) => translate(lang, `setup.view.${k}`);
  const projectCols = [p("status"), "area", p("period"), p("priority"), p("progress"), p("blockedBy")];
  return {
    project: [
      // "Aktiv": what is planned, running or paused – Backlog and the finished ones hidden, one click brings them back
      { id: "v_active", name: v("active"), kind: "table", group: "status", hideEmpty: true, hiddenGroups: ["st_backlog", "st_done", "st_canceled"], columns: projectCols },
      { id: "v_timeline", kind: "timeline", group: "statusGroup", date: p("period") },
      { id: "v_board", kind: "board", group: "status", columns: [p("period"), p("status")] },
      { id: "v_all", name: v("all"), kind: "table", sort: [{ key: "status" }, { key: "updated", desc: true }], columns: projectCols },
      { id: "v_calendar", kind: "calendar", date: p("period") },
    ],
    task: [
      { id: "v_byproject", name: v("byProject"), kind: "table", where: { status: "open" }, group: "project", hideEmpty: true, sort: [{ key: "due" }], columns: [p("status"), p("priority"), p("blockedBy"), p("blocking"), p("due"), "tags"] },
      { id: "v_progress", name: v("progress"), kind: "board", group: "status", hiddenGroups: ["st_dropped", "st_archived"], subgroup: "project", sort: [{ key: p("priority") }], columns: [p("due")] },
      { id: "v_priority", name: p("priority"), kind: "board", where: { status: "open" }, group: p("priority"), sort: [{ key: "status" }], columns: ["subtasks"] },
      { id: "v_all", name: v("all"), kind: "table", sort: [{ key: "status" }, { key: "due" }], columns: ["project", p("status"), p("priority"), p("due"), p("blockedBy"), p("blocking"), p("waitingFor"), "tags", "area"] },
    ],
  };
}

/** Is the start page still the shipped one (any language, current version)? Then it is shown in the UI language. */
export function isDefaultStartBody(body: string): boolean {
  return LANGS.some((l) => body === defaultStartBody(l));
}

/** The views of a type's page: the stored ones, else the defaults ("Alle" as a table). */
export function typeTabs(type: Item, lang: Lang): ViewTab[] {
  if (type.schema?.views?.length) return type.schema.views;
  const views = defaultViews(lang);
  const list: Omit<ViewTab, "pos">[] = type.id === SYS.project ? views.project : type.id === SYS.task ? views.task : [{ id: "v_all", name: translate(lang, "setup.view.all"), kind: "table" }];
  const pos = keysFor(list.length); // as setTabs writes them
  return list.map((tab, i) => ({ ...tab, pos: pos[i]! }));
}

/** "Standard wiederherstellen" of the inbox: back to the rule from the code. */
export function resetInbox(w: Writer) {
  w.change(SETTINGS_ID, (doc) => setSettings(doc, { inbox: null }));
}

export function isSetUp(w: Writer): boolean {
  return !!w.get(SETTINGS_ID);
}

/** First setup in the chosen language. Safe to run twice (fixed ids merge). */
export function runSetup(w: Writer, lang: Lang, origin?: string) {
  const fresh = !w.get(SYS.project);
  restoreDefaultTypes(w, lang, origin);
  // the order under "Typen" (and in the phone's bar): Projekte, Tasks, Karten
  if (fresh) [SYS.project, SYS.task, SYS.card].forEach((id, i) => w.change(id, (d) => setSchemaField(d, "pos", keysFor(3)[i]!)));
  if (!w.get(SETTINGS_ID))
    w.change(SETTINGS_ID, (doc) => {
      initItem(doc, { kind: "settings", title: "Settings" });
      setSettings(doc, { setupLang: lang, format: FORMAT, captureTypes: DEFAULT_CAPTURE_TYPES });
      replaceBody(doc, defaultStartBody(lang));
    });
}

/**
 * Once (27.10.): areas. Every document from before gets the personal area written into it, and
 * the data the format version 1. Returns how many documents were marked.
 */
export function upgradeAreas(w: Writer, docs: Iterable<[string, Y.Doc]>): number {
  const KEY = "areas-1";
  const settings = w.get(SETTINGS_ID)?.settings;
  if (!settings || settings.upgrades?.includes(KEY)) return 0;
  const ids = [...docs].filter(([, d]) => d.getMap<any>("meta").has("kind") && !d.getMap<any>("meta").has("area")).map(([id]) => id);
  for (const id of ids) w.change(id, (d) => d.getMap<any>("meta").set("area", PERSONAL));
  w.change(SETTINGS_ID, (d) => setSettings(d, { format: Math.max(settings.format ?? 0, FORMAT), upgrades: [...(settings.upgrades ?? []), KEY] }));
  return ids.length;
}

/** The collections shipped for the default types (until 26.10.). */
const SHIPPED_FOR: Record<string, string> = { "sys:c-project": SYS.project, "sys:c-task": SYS.task, "sys:c-card": SYS.card };

/**
 * Once (26.10.): collections are gone. The inbox's rule goes to the settings; a type's collection
 * gives its views (and its name, if not the usual plural) to the type – what it filtered beyond
 * the type stays as each view's filter; the files' collections go (files have their own page);
 * any other collection becomes a page with a query block with the same views, pinned if it was.
 * The old documents stay as they are and are no longer read. Returns what happened, for the log.
 */
export function migrateCollections(w: Writer, ix: Index, docs: Iterable<[string, Y.Doc]>, lang: Lang): string[] {
  const KEY = "no-collections-1";
  const settings = w.get(SETTINGS_ID)?.settings;
  if (!settings || settings.upgrades?.includes(KEY)) return [];
  const log: string[] = [];
  const given = new Set<string>(); // types that got their views (the first collection wins)
  let lastPin = sidebarRoots(ix).at(-1)?.pinned ?? null;
  for (const [id, doc] of docs) {
    const meta = doc.getMap<any>("meta");
    if (meta.get("kind") !== "sammlung" || meta.get("deleted")) continue;
    const name: string = meta.get("name") ?? "";
    const where = doc.getMap<any>("query").get("where") as Cond | undefined;
    const tabs = readTabs(doc);
    const type = SHIPPED_FOR[id] ?? (where && "type" in where ? where.type : undefined);
    const pos: string | undefined = doc.getMap<any>("pin").get("sidebar") || undefined; // its place in the sidebar
    if (meta.get("system") === "eingang") {
      const own = where && JSON.stringify(where) !== JSON.stringify(DEFAULT_INBOX_WHERE);
      if (own) w.change(SETTINGS_ID, (d) => setSettings(d, { inbox: where }));
      log.push(`${name}: ${own ? "its own rule to the settings" : "the default rule"}`);
    } else if (type && ix.types.get(type) && !ix.types.get(type)!.schema!.views && !given.has(type)) {
      given.add(type);
      // what the collection filtered beyond the type stays in every view
      const parts = where && "and" in where ? where.and : where ? [where] : [];
      const rest = parts.filter((c) => JSON.stringify(c) !== JSON.stringify({ type }));
      const extra: Cond | undefined = rest.length > 1 ? { and: rest } : rest[0];
      const schema = ix.types.get(type)!.schema!;
      w.change(type, (d) => {
        setTabs(d, tabs.map(({ pos: _, ...tab }) => ({ ...tab, where: andWhere(extra, tab.where) })));
        if (name && name !== pluralOf(schema.name, lang)) setSchemaField(d, "plural", name);
        if (pos && !schema.pos) setSchemaField(d, "pos", pos); // under "Typen" in the order the collections had
      });
      log.push(`${name}: views to the type ${schema.name}`);
    } else if (id === "sys:c-files" || id === "sys:c-images" || (where && ("file" in where || "filetype" in where))) {
      if (id === "sys:c-files" && pos) w.change(SETTINGS_ID, (d) => setSettings(d, { filesPos: pos }));
      log.push(`${name}: dropped (files have their own page)`);
    } else {
      const page = newId();
      const pin = pos ? (lastPin = keyBetween(lastPin, null)) : undefined;
      const def: QueryDef = tabs.length > 1 ? { where, tabs } : tabDef(where, tabs[0]!);
      w.change(page, (d) => initItem(d, { title: name, pinned: pin, body: "```abfrage\n" + blockSource(def) + "\n```" }));
      log.push(`${name}: now the page ${page} with a query block${pin ? ", pinned" : ""}`);
    }
  }
  w.change(SETTINGS_ID, (d) => setSettings(d, { upgrades: [...(settings.upgrades ?? []), KEY] }));
  return log;
}
