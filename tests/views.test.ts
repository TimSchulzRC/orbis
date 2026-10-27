// Views as tabs on a type's page: stored on the type, one map each; without stored ones the
// defaults; the tab filter added to the type (AND), grouping, the agent's way in, and the one
// migration from the former collections.
import { test, expect, beforeEach, afterAll } from "bun:test";
import * as Y from "yjs";
import { tempDir, removeTempDirs, MemRepo } from "./helpers";
import { Store } from "../src/server/store";
import { Ops } from "../src/server/ops";
import { storeWriter } from "../src/server/importers";
import { SYS, migrateCollections, runSetup, typeTabs } from "../src/shared/setup";
import { SETTINGS_ID, readItem, setTab, setTabs } from "../src/shared/model";
import { DEFAULT_INBOX_WHERE } from "../src/shared/inbox";
import { type Cond, groupId, groupItems, runQuery, tabDef } from "../src/shared/query";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
const A = "agent:test";
beforeEach(() => {
  s = new Store(tempDir("obtion-views-"));
  runSetup(storeWriter(s, "system:setup"), "de");
  s.flush();
  ops = new Ops(s);
});
const tabsOf = (id: string) => typeTabs(s.records.get(id)!, "de");

test("a type's views: the defaults until one is changed, then each a map of its own on the type", () => {
  expect(tabsOf(SYS.project).map((t) => t.name ?? t.kind)).toEqual(["Aktiv", "timeline", "board", "Alle", "calendar"]);
  expect(tabsOf(SYS.task).map((t) => t.name)).toEqual(["Nach Projekt", "Fortschritt", "Priorität", "Alle"]);
  expect(tabsOf(SYS.card).map((t) => [t.name, t.kind])).toEqual([["Alle", "table"]]);
  expect(s.index().typesInOrder().map((x) => x.id)).toEqual([SYS.project, SYS.task, SYS.card]);
  expect(s.records.get(SYS.card)!.schema!.views).toBeUndefined();
  const before = tabsOf(SYS.card);
  s.change(SYS.card, "web:x", (d) => (setTabs(d, before), setTab(d, "b", { kind: "board", group: "status", pos: "A" })));
  s.flush();
  expect(tabsOf(SYS.card).map((t) => t.id)).toEqual(["b", "v_all"]); // "b" sorts before
  s.change(SYS.card, "web:x", (d) => setTab(d, "v_all", { name: "Alles", columns: ["area"], widths: { area: 120 } }));
  s.change(SYS.card, "web:x", (d) => setTab(d, "b", { group: null }));
  s.flush();
  expect(tabsOf(SYS.card)[1]).toMatchObject({ name: "Alles", columns: ["area"], widths: { area: 120 } });
  expect(tabsOf(SYS.card)[0]!.group).toBeUndefined();
  expect(s.getDoc(SYS.card).getMap("tabs").get("b")).toBeInstanceOf(Y.Map);
  s.change(SYS.card, "web:x", (d) => setTab(d, "b", null));
  s.flush();
  expect(tabsOf(SYS.card).map((t) => t.id)).toEqual(["v_all"]);
});

test("a tab's filter is added to the type (AND)", () => {
  ops.create({ title: "Offen", type: "Task" }, A);
  ops.create({ title: "Läuft", type: "Task", properties: { Status: "In Arbeit" } }, A);
  ops.create({ title: "Fertig", type: "Task", properties: { Status: "Erledigt" } }, A);
  s.flush();
  const ix = s.index();
  const base = { type: SYS.task };
  expect(runQuery(tabDef(base, { id: "x", pos: "V", kind: "table" }), { ix }).items.map((i) => i.title).sort()).toEqual(["Fertig", "Läuft", "Offen"]);
  const active = tabDef(base, { id: "y", pos: "V", kind: "table", where: { status: "active" } });
  expect(active.where).toEqual({ and: [{ type: SYS.task }, { status: "active" }] });
  expect(runQuery(active, { ix }).items.map((i) => i.title)).toEqual(["Läuft"]);
});

test("grouping: status in the order of the work, with empty options; project, area and status group", () => {
  const r = new MemRepo();
  runSetup(r.writer, "de");
  const area = r.add({ title: "Arbeit", pinned: "a0" });
  const p1 = r.add({ title: "Portal", type: "sys:project", parents: [area], props: { p_status: "st_active" } });
  const t1 = r.add({ title: "Login", type: "sys:task", parents: [p1], props: { p_status: "st_active" } });
  const sub = r.add({ title: "Passwort", type: "sys:task", parents: [t1], props: { p_status: "st_todo" } });
  const loose = r.add({ title: "Lose", type: "sys:task", props: { p_status: "st_done" } });
  const ix = r.index();
  const items = [t1, sub, loose].map((id) => ix.get(id)!);
  const ctx = { ix };
  const byStatus = groupItems(items, "status", ctx);
  expect(byStatus.map((g) => g.label)).toEqual(["Nicht begonnen", "In Bearbeitung", "Erledigt"]);
  expect(byStatus[1]!.option?.color).toBe("amber");
  const withEmpty = groupItems(items, "status", ctx, undefined, { types: ["sys:task"] });
  expect(withEmpty.map((g) => g.label)).toEqual(["Nicht begonnen", "In Bearbeitung", "Pausiert", "Erledigt", "Verworfen", "Archiviert"]);
  expect(withEmpty.find((g) => g.label === "Pausiert")!.items).toEqual([]);
  // under status:offen the empty done options say nothing and stay away
  const open = groupItems(items, "status", ctx, undefined, { types: ["sys:task"], where: { and: [{ type: "sys:task" }, { status: "open" }] } });
  expect(open.map((g) => g.label)).toEqual(["Nicht begonnen", "In Bearbeitung", "Pausiert", "Erledigt"]); // "Erledigt" has an entry here
  // a sub-task belongs to its project, not to its parent task; without one: last
  const byProject = groupItems(items, "project", ctx);
  expect(byProject.map((g) => [g.label ?? "", g.items.map((i) => i.title)])).toEqual([
    ["Portal", ["Login", "Passwort"]],
    ["", ["Lose"]],
  ]);
  expect(byProject[0]!.ref).toBe(p1);
  expect(groupItems([ix.get(p1)!], "area", ctx).map((g) => g.label)).toEqual(["Arbeit"]);
  expect(groupItems(items, "statusGroup", ctx).map((g) => g.key)).toEqual(["todo", "active", "done"]);
});

test("update_type sets the views; the same name keeps its tab; hidden groups are kept as option ids", () => {
  ops.updateType("Projekt", { views: [{ name: "Aktiv", query: "status:aktiv gruppe:status spalten:Status,bereich,Fortschritt", hide_empty_groups: true }, { name: "Plan", view: "board", query: "gruppe:status", hidden_groups: ["Backlog", "Erledigt", "Abgebrochen"] }] }, A);
  let tabs = tabsOf(SYS.project);
  expect(tabs[0]).toMatchObject({ id: "v_active", name: "Aktiv", kind: "table", where: { status: "active" }, group: "status", columns: ["Status", "area", "progress"], hideEmpty: true });
  expect(tabs[1]!.hiddenGroups).toEqual(["st_backlog", "st_done", "st_canceled"]);
  ops.create({ title: "Läuft", type: "Projekt", properties: { Status: "In Bearbeitung" } }, A);
  ops.create({ title: "Später", type: "Projekt", properties: { Status: "Backlog" } }, A);
  s.flush();
  const ix = s.index();
  const def = tabDef({ type: SYS.project }, tabs[1]!);
  const hidden = new Set(tabs[1]!.hiddenGroups);
  const groups = groupItems(runQuery(def, { ix }).items, "status", { ix }, undefined, { types: [SYS.project], where: def.where });
  expect(groups.filter((g) => !hidden.has(groupId(g))).map((g) => g.label)).toEqual(["Planung", "In Bearbeitung", "Pausiert"]);
  ops.updateType("Projekt", { views: [{ name: "Aktiv", view: "board" }] }, A);
  tabs = tabsOf(SYS.project);
  expect(tabs.map((t) => [t.id, t.kind])).toEqual([["v_active", "board"]]);
  expect(() => ops.updateType("Projekt", { views: [] }, A)).toThrow(/at least one view/);
});

test("once: the former collections give their views to the types, the inbox rule to the settings, the rest becomes a page", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  const old = (id: string, meta: Record<string, unknown>, where: unknown, tabs?: Record<string, Record<string, unknown>>, view?: Record<string, unknown>, pin?: Record<string, unknown>) =>
    m.change(id, (d) => {
      for (const [k, v] of Object.entries({ kind: "sammlung", created: 1, updated: 1, ...meta })) d.getMap("meta").set(k, v);
      if (where) d.getMap("query").set("where", where);
      for (const [k, v] of Object.entries(view ?? {})) d.getMap("view").set(k, v);
      for (const [k, v] of Object.entries(pin ?? {})) d.getMap("pin").set(k, v);
      for (const [tid, t] of Object.entries(tabs ?? {})) {
        const map = new Y.Map();
        for (const [k, v] of Object.entries(t)) map.set(k, v);
        d.getMap("tabs").set(tid, map);
      }
    });
  const mine: Cond = { or: [{ without: "type" }, { tag: "später" }] };
  old("sys:inbox", { name: "Eingang", system: "eingang" }, mine, undefined, { display: "triage" });
  old("sys:c-task", { name: "Aufgaben" }, { and: [{ type: SYS.task }, { status: "open" }] }, { a: { kind: "table", pos: "V", name: "Liste" }, b: { kind: "board", pos: "W", where: { tag: "x" } } }, undefined, { sidebar: "a" });
  old("sys:c-card", { name: "Karten" }, { type: SYS.card }, undefined, { display: "list" });
  old("sys:c-files", { name: "Dateien" }, { file: true }, undefined, { display: "gallery" }, { sidebar: "b" });
  old("c_mix", { name: "Gemischt" }, { or: [{ type: SYS.card }, { type: SYS.project }] }, undefined, { display: "table", group: "type" }, { sidebar: "zz" });
  old("c_gone", { name: "Weg", deleted: true }, { tag: "y" });
  expect(readItem("sys:c-task", m.doc("sys:c-task"))).toBeNull(); // the old documents are no longer read
  const log = migrateCollections(m.writer, m.index(), m.docs, "de");
  expect(log).toHaveLength(5);
  expect(m.get(SETTINGS_ID)!.settings!.inbox).toEqual(mine);
  const task = m.get(SYS.task)!.schema!;
  expect(task.plural).toBe("Aufgaben"); // not the usual plural: kept as the list's name
  expect(task.views!.map((t) => [t.id, t.kind, t.where])).toEqual([
    ["a", "table", { status: "open" }],
    ["b", "board", { and: [{ status: "open" }, { tag: "x" }] }],
  ]);
  expect(task.pos).toBe("l"); // a fresh setup has an order already; the collection's place only fills a gap
  expect(m.get(SETTINGS_ID)!.settings!.filesPos).toBe("b");
  const card = m.get(SYS.card)!.schema!;
  expect(card.plural).toBeUndefined();
  expect(card.views!.map((t) => t.kind)).toEqual(["list"]);
  const page = m.index().live.find((i) => i.title === "Gemischt")!;
  expect(page.pinned).toBeTruthy();
  expect(page.body).toContain('"group":"type"');
  expect(m.index().live.some((i) => i.title === "Weg" || i.title === "Dateien")).toBe(false);
  expect(migrateCollections(m.writer, m.index(), m.docs, "de")).toEqual([]); // once only
  // a fresh setup has nothing to migrate and the default rule
  const f = new MemRepo();
  runSetup(f.writer, "de");
  expect(migrateCollections(f.writer, f.index(), f.docs, "de")).toEqual([]);
  expect(f.get(SETTINGS_ID)!.settings!.inbox).toBeUndefined();
  expect(DEFAULT_INBOX_WHERE).toBeTruthy();
});
