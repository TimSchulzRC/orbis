import { test, expect } from "bun:test";
import type { ViewTab } from "@obtion/core/model";
import { mapCond, mapQuery, mapTab, renameTypeIn } from "@obtion/core/typerefs";

const rename = { type: "t", prop: "p", from: "Priorität", to: "Wichtigkeit" };
const remove = { ...rename, to: null };

test("a renamed property follows in columns, sort, grouping, date, widths and filters", () => {
  const tab: ViewTab = { id: "v", pos: "V", kind: "board", columns: ["Status", "priorität"], sort: [{ key: "Priorität", desc: true }], group: "Priorität", subgroup: "project", date: "Priorität", widths: { "Priorität ": 90 }, where: { prop: "PRIORITÄT", op: ":" as const, value: "Hoch" } };
  expect<ViewTab>(mapTab(tab, rename)).toEqual({ ...tab, columns: ["Status", "Wichtigkeit"], sort: [{ key: "Wichtigkeit", desc: true }], group: "Wichtigkeit", date: "Wichtigkeit", widths: { Wichtigkeit: 90 }, where: { prop: "Wichtigkeit", op: ":", value: "Hoch" } });
});

test("a removed property leaves the view; its grouping goes with the hidden groups", () => {
  const tab = { id: "v", pos: "V", kind: "board" as const, columns: ["Priorität", "due"], sort: [{ key: "Priorität" }, { key: "updated" }], group: "Priorität", subgroup: "project", hiddenGroups: ["o_1"], hideEmpty: true };
  const out = mapTab(tab, remove);
  expect(out.columns).toEqual(["due"]);
  expect(out.sort).toEqual([{ key: "updated" }]);
  for (const k of ["group", "subgroup", "hiddenGroups", "hideEmpty"]) expect(k in out).toBe(false);
  // only the rows go when the subgroup was the property
  const rowsOnly = mapTab({ ...tab, group: "status", subgroup: "Priorität" }, remove);
  expect(rowsOnly).toMatchObject({ group: "status", hiddenGroups: ["o_1"] });
  expect("subgroup" in rowsOnly).toBe(false);
});

test("filters on a removed property drop out of AND, OR and NOT", () => {
  const p = { prop: "Priorität", op: ":" as const, value: "Hoch" };
  expect(mapCond({ and: [{ type: "t" }, p] }, remove)).toEqual({ type: "t" });
  expect(mapCond({ or: [p, { not: p }] }, remove)).toBeUndefined();
  expect(mapCond({ and: [{ type: "t" }, { or: [p, { tag: "x" }] }] }, remove)).toEqual({ and: [{ type: "t" }, { tag: "x" }] });
});

test("built-in keys stay: group \"status\" is not the property \"Status\"", () => {
  const def = { group: "status", sort: [{ key: "status" }], columns: ["Status", "due"], tabs: [{ id: "a", pos: "V", kind: "table" as const, columns: ["Status"] }] };
  const out = mapQuery(def, { type: "t", prop: "p", from: "Status", to: null });
  expect(out).toEqual({ group: "status", sort: [{ key: "status" }], columns: ["due"], tabs: [{ id: "a", pos: "V", kind: "table" }] });
});

test("a type rename reaches relation targets, in any language and quoted", () => {
  expect(renameTypeIn("typ:Task | typ:Projekt", "Task", "Aufgabe")).toBe("typ:Aufgabe | typ:Projekt");
  expect(renameTypeIn('type:"task"', "Task", "To do")).toBe('type:"To do"');
  expect(renameTypeIn("(typ:Task)", "Task", "Job")).toBe("(typ:Job)");
  expect(renameTypeIn("typ:Taskforce #task", "Task", "Job")).toBeNull();
  expect(renameTypeIn("status:Task", "Task", "Job")).toBeNull();
});
