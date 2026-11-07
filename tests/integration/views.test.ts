import { test, expect, beforeEach, afterAll } from "bun:test";
import * as Y from "yjs";
import { removeTempDirs, MemRepo } from "../support/helpers";
import { setupStore } from "../support/store";
import type { Store } from "@obtion/server/store";
import type { Ops } from "@obtion/server/ops";
import { SYS, runSetup, typeTabs, upgradeSetup } from "@obtion/core/setup";
import { FORMAT, SETTINGS_ID, setSettings, setTab, setTabs } from "@obtion/core/model";
import { groupId, groupItems, runQuery, tabDef } from "@obtion/core/query";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
const A = "agent:test";
// set up in German: the shipped view names, status options and query words checked here are German
beforeEach(() => ({ s, ops } = setupStore("obtion-views-")));
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
  s.change(SYS.card, "web:x", (d) => setTab(d, "v_all", { name: "Everything", columns: ["area"], widths: { area: 120 } }));
  s.change(SYS.card, "web:x", (d) => setTab(d, "b", { group: null }));
  s.flush();
  expect(tabsOf(SYS.card)[1]).toMatchObject({ name: "Everything", columns: ["area"], widths: { area: 120 } });
  expect(tabsOf(SYS.card)[0]!.group).toBeUndefined();
  expect(s.getDoc(SYS.card).getMap("tabs").get("b")).toBeInstanceOf(Y.Map);
  s.change(SYS.card, "web:x", (d) => setTab(d, "b", null));
  s.flush();
  expect(tabsOf(SYS.card).map((t) => t.id)).toEqual(["v_all"]);
});

test("\"Reset views\": the stored views go, the defaults show again", () => {
  s.change(SYS.card, "web:x", (d) => setTab(d, "v_x", { kind: "board", pos: "W" }));
  s.flush();
  expect(s.records.get(SYS.card)!.schema!.views!.map((t) => t.kind)).toEqual(["board"]);
  s.change(SYS.card, "web:x", (d) => setTabs(d, []));
  s.flush();
  expect(s.records.get(SYS.card)!.schema!.views).toBeUndefined();
  expect(tabsOf(SYS.card).map((t) => t.kind)).toEqual(["table"]);
});

test("a tab's filter is added to the type (AND)", () => {
  ops.create({ title: "Open", type: "Task" }, A);
  ops.create({ title: "Running", type: "Task", properties: { Status: "In Arbeit" } }, A);
  ops.create({ title: "Finished", type: "Task", properties: { Status: "Erledigt" } }, A);
  s.flush();
  const ix = s.index();
  const base = { type: SYS.task };
  expect(runQuery(tabDef(base, { id: "x", pos: "V", kind: "table" }), { ix }).items.map((i) => i.title).sort()).toEqual(["Finished", "Open", "Running"]);
  const active = tabDef(base, { id: "y", pos: "V", kind: "table", where: { status: "active" } });
  expect(active.where).toEqual({ and: [{ type: SYS.task }, { status: "active" }] });
  expect(runQuery(active, { ix }).items.map((i) => i.title)).toEqual(["Running"]);
});

test("grouping: status in the order of the work, with empty options; above, area and status group", () => {
  const r = new MemRepo();
  runSetup(r.writer, "de");
  const area = r.add({ title: "Work", pinned: "a0" });
  const p1 = r.add({ title: "Portal", type: "sys:project", parents: [area], props: { p_status: "st_active" } });
  const t1 = r.add({ title: "Login", type: "sys:task", parents: [p1], props: { p_status: "st_active" } });
  const sub = r.add({ title: "Password", type: "sys:task", parents: [t1], props: { p_status: "st_todo" } });
  const loose = r.add({ title: "Loose", type: "sys:task", props: { p_status: "st_done" } });
  const ix = r.index();
  const items = [t1, sub, loose].map((id) => ix.get(id)!);
  const ctx = { ix };
  const byStatus = groupItems(items, "status", ctx);
  expect(byStatus.map((g) => g.label)).toEqual(["Nicht begonnen", "In Bearbeitung", "Erledigt"]);
  expect(byStatus[1]!.option?.color).toBe("amber");
  const withEmpty = groupItems(items, "status", ctx, undefined, { types: ["sys:task"] });
  expect(withEmpty.map((g) => g.label)).toEqual(["Nicht begonnen", "In Bearbeitung", "Pausiert", "Erledigt", "Verworfen", "Archiviert"]);
  expect(withEmpty.find((g) => g.label === "Pausiert")!.items).toEqual([]);
  // under status:offen (German query word) the empty done options say nothing and stay away
  const open = groupItems(items, "status", ctx, undefined, { types: ["sys:task"], where: { and: [{ type: "sys:task" }, { status: "open" }] } });
  expect(open.map((g) => g.label)).toEqual(["Nicht begonnen", "In Bearbeitung", "Pausiert", "Erledigt"]); // "Erledigt" has an entry here
  // grouped by "Darüber" (above): the entry it lives under, whatever its type; without one: last
  const byProject = groupItems(items, "project", ctx);
  expect(byProject.map((g) => [g.label ?? "", g.items.map((i) => i.title)])).toEqual([
    ["Login", ["Password"]],
    ["Portal", ["Login"]],
    ["", ["Loose"]],
  ]);
  expect(byProject[1]!.ref).toBe(p1);
  expect(groupItems([ix.get(p1)!], "area", ctx).map((g) => g.label)).toEqual(["Work"]);
  expect(groupItems(items, "statusGroup", ctx).map((g) => g.key)).toEqual(["todo", "active", "done"]);
});

test("update_type sets the views; the same name keeps its tab; hidden groups are kept as option ids", () => {
  ops.updateType("Projekt", { views: [{ name: "Aktiv", query: "status:aktiv gruppe:status spalten:Status,bereich,Fortschritt", hide_empty_groups: true }, { name: "Plan", view: "board", query: "gruppe:status", hidden_groups: ["Backlog", "Erledigt", "Abgebrochen"] }] }, A);
  let tabs = tabsOf(SYS.project);
  expect(tabs[0]).toMatchObject({ id: "v_active", name: "Aktiv", kind: "table", where: { status: "active" }, group: "status", columns: ["Status", "area", "progress"], hideEmpty: true });
  expect(tabs[1]!.hiddenGroups).toEqual(["st_backlog", "st_done", "st_canceled"]);
  ops.create({ title: "Running", type: "Projekt", properties: { Status: "In Bearbeitung" } }, A);
  ops.create({ title: "Later", type: "Projekt", properties: { Status: "Backlog" } }, A);
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


test("views live in the type: shipped types get theirs at setup, own types one table", () => {
  const r = new MemRepo();
  runSetup(r.writer, "de");
  expect(r.index().types.get(SYS.task)!.schema!.views!.map((v) => v.id)).toEqual(["v_byproject", "v_progress", "v_priority", "v_all"]);
  expect(r.index().types.get(SYS.project)!.schema!.views!.map((v) => v.id)).toEqual(["v_active", "v_timeline", "v_board", "v_all", "v_calendar"]);
  r.addType("t_module", { name: "Module" });
  expect(typeTabs(r.index().types.get("t_module")!, "de").map((v) => v.id)).toEqual(["v_all"]);
  // the stored format follows, so an older app turns read-only even offline
  r.change(SETTINGS_ID, (doc) => setSettings(doc, { format: 1 }));
  upgradeSetup(r.writer);
  expect(r.writer.get(SETTINGS_ID)!.settings!.format).toBe(FORMAT);
});
