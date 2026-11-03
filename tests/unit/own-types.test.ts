// Behaviour hangs on what the types mark (capabilities, `blocks`, an option's `state`), never on a
// type's or property's id or name: without the default types, with other names, everything works.
import { test, expect } from "bun:test";
import { MemRepo } from "../support/helpers";
import { runSetup, SYS } from "@obtion/core/setup";
import { type PropDef, removeProp, upsertProp } from "@obtion/core/model";
import { deleteType } from "@obtion/core/typeops";
import { matchOption, statusShape } from "@obtion/core/input";
import { activeProjects } from "@obtion/core/today";
import { progressSpec } from "@obtion/core/traits";

/** A project and its steps under other names, without any default type. */
function ownTypes() {
  const m = new MemRepo();
  m.addType("t_step", {
    name: "Schritt",
    capabilities: { status: "p_state" },
    properties: [
      {
        id: "p_state",
        name: "Stand",
        kind: "select",
        default: "s_new",
        options: [
          { id: "s_new", name: "Neu", group: "todo" },
          { id: "s_on", name: "Läuft", group: "active" },
          { id: "s_rest", name: "Ruht", group: "active", state: "paused" },
          { id: "s_ok", name: "Fertig", group: "done" },
          { id: "s_no", name: "Eingestellt", group: "done", state: "dropped" },
        ],
      },
      { id: "p_after", name: "Hängt an", kind: "relation", multiple: true, blocks: true },
      { id: "p_who", name: "Offen bei", kind: "text", blocks: true },
      { id: "p_see", name: "Siehe auch", kind: "relation", multiple: true },
    ],
  });
  m.addType("t_plan", {
    name: "Vorhaben",
    capabilities: { status: "p_state" },
    properties: [
      { id: "p_state", name: "Stand", kind: "select", default: "v_on", options: [{ id: "v_on", name: "Läuft", group: "active" }, { id: "v_rest", name: "Ruht", group: "active", state: "paused" }] },
      { id: "p_done", name: "Erledigt", kind: "computed", computed: { fn: "progress", of: "t_step" } },
    ],
  });
  return m;
}

test("blocked, paused and dropped come from the marks, under any name and without the default types", () => {
  const m = ownTypes();
  const plan = m.add({ title: "Umzug", type: "t_plan", props: { p_state: "v_on" } });
  const a = m.add({ title: "Kartons", type: "t_step", parents: [plan], props: { p_state: "s_new" } });
  const b = m.add({ title: "Packen", type: "t_step", parents: [plan], props: { p_state: "s_new" }, rels: { p_after: [a] } });
  const c = m.add({ title: "Schlüssel", type: "t_step", parents: [plan], props: { p_state: "s_new", p_who: "Vermieter" } });
  const d = m.add({ title: "Notiz", type: "t_step", parents: [plan], props: { p_state: "s_new" }, rels: { p_see: [a] } });
  let ix = m.index();
  expect(ix.isBlocked(ix.get(b)!)).toBe(true);
  expect(ix.blockers(ix.get(c)!).waiting).toBe("Vermieter");
  expect(ix.isBlocked(ix.get(d)!)).toBe(false); // a relation without the mark holds nothing up
  expect(ix.nextTask(plan, "2026-10-31")?.id).toBe(a); // "Kartons" before "Notiz"; the blocked ones not
  expect(activeProjects(ix).map((x) => x.item.id)).toEqual([plan]);
  // paused: the plan and everything below it rests
  m.change(plan, (doc) => doc.getMap("props").set("p_state", "v_rest"));
  ix = m.index();
  expect(ix.isDormant(ix.get(a)!)).toBe(true);
  expect(activeProjects(ix)).toEqual([]);
  const options = ix.types.get("t_step")!.schema!.properties[0]!.options!;
  expect(options.map(statusShape)).toEqual(["open", "active", "paused", "done", "dropped"]);
});

test("renaming the shipped properties and options changes nothing; a look-alike name without the mark does nothing", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  m.change(SYS.task, (doc) => {
    upsertProp(doc, "p_blocked", { name: "Hängt an" });
    upsertProp(doc, "p_waiting", { name: "Offen bei" });
  });
  const a = m.add({ title: "A", type: SYS.task, props: { p_status: "st_todo" } });
  const b = m.add({ title: "B", type: SYS.task, props: { p_status: "st_todo" }, rels: { p_blocked: [a] } });
  const c = m.add({ title: "C", type: SYS.task, props: { p_status: "st_paused" } });
  let ix = m.index();
  expect(ix.isBlocked(ix.get(b)!)).toBe(true);
  expect(ix.isDormant(ix.get(c)!)).toBe(true);
  // an own type with a relation that only is called "Blockiert durch"
  m.addType("t_x", { name: "X", properties: [{ id: "p_x", name: "Blockiert durch", kind: "relation" }] });
  const x = m.add({ title: "X1", type: "t_x", rels: { p_x: [a] } });
  ix = m.index();
  expect(ix.isBlocked(ix.get(x)!)).toBe(false);
});

test("progress on a deleted type filters nothing", () => {
  const m = ownTypes();
  m.addType("t_gone", { name: "Weg" });
  m.change("t_plan", (doc) => upsertProp(doc, "p_done", { computed: { fn: "progress", of: "t_gone" } }));
  const plan = m.add({ title: "Umzug", type: "t_plan", props: { p_state: "v_on" } });
  const a = m.add({ title: "Kartons", type: "t_step", parents: [plan], props: { p_state: "s_new" } });
  deleteType(m.writer, m.index(), "t_gone", { mode: "remove" }, "test");
  const ix = m.index();
  expect(ix.nextTask(plan, "2026-10-31")?.id).toBe(a); // was: nothing, every step filtered out by the deleted type
  expect(activeProjects(ix).map((x) => x.item.id)).toEqual([plan]); // still counts progress of others
});

test("a word for paused finds the option marked paused, not one only called so", () => {
  const p: PropDef = {
    id: "p",
    name: "Stand",
    kind: "select",
    sort: "V",
    options: [
      { id: "a", name: "Paused", group: "active" },
      { id: "b", name: "Resting", group: "active", state: "paused" },
    ],
  };
  expect(matchOption(p, "on hold").id).toBe("b");
  expect(matchOption(p, "Paused").id).toBe("a"); // the exact name still wins
});

test("progress comes from the computed property; old types read the capability until they have one", () => {
  const m = new MemRepo();
  m.addType("t_old", { name: "Alt", capabilities: { progress: { of: "t_old" } } });
  let s = m.index().types.get("t_old")!.schema;
  expect(progressSpec(s)).toEqual({ of: "t_old" }); // from before the property
  m.change("t_old", (doc) => upsertProp(doc, "p_pr", { name: "Fortschritt", kind: "computed", computed: { fn: "progress" } }));
  s = m.index().types.get("t_old")!.schema;
  expect(progressSpec(s)).toEqual({ of: undefined }); // the property wins
  m.change("t_old", (doc) => removeProp(doc, "p_pr"));
  s = m.index().types.get("t_old")!.schema;
  expect(progressSpec(s)).toBeUndefined(); // removing it turns the bar off
});
