// Behaviour hangs on what the types mark (capabilities, `blocks`, a status option's group), never on a
// type's or property's id or name: without the default types, with other names, everything works.
import { test, expect } from "bun:test";
import { MemRepo } from "../support/helpers";
import { runSetup, SYS } from "@obtion/core/setup";
import { type PropDef, removeProp, upsertProp } from "@obtion/core/model";
import { deleteType } from "@obtion/core/typeops";
import { matchOption } from "@obtion/core/input";
import { running } from "@obtion/core/today";
import { progressSpec } from "@obtion/core/traits";

/** A project and its steps under other names, without any default type. */
function ownTypes() {
  const m = new MemRepo();
  m.addType("t_step", {
    name: "Schritt",
    properties: [
      {
        id: "p_state",
        name: "Stand",
        kind: "status",
        default: "s_new",
        options: [
          { id: "s_new", name: "Neu", group: "todo" },
          { id: "s_on", name: "Läuft", group: "active" },
          { id: "s_rest", name: "Ruht", group: "active" },
          { id: "s_ok", name: "Fertig", group: "done" },
          { id: "s_no", name: "Eingestellt", group: "done" },
        ],
      },
      { id: "p_after", name: "Hängt an", kind: "relation", multiple: true, blocks: true },
      { id: "p_who", name: "Offen bei", kind: "text", blocks: true },
      { id: "p_see", name: "Siehe auch", kind: "relation", multiple: true },
    ],
  });
  m.addType("t_plan", {
    name: "Vorhaben",
    properties: [
      { id: "p_state", name: "Stand", kind: "status", default: "v_on", options: [{ id: "v_on", name: "Läuft", group: "active" }, { id: "v_rest", name: "Ruht", group: "active" }, { id: "v_ok", name: "Fertig", group: "done" }] },
      { id: "p_done", name: "Erledigt", kind: "computed", computed: { fn: "progress", of: "t_step" } },
    ],
  });
  return m;
}

test("blocked and done come from the marks and groups, under any name and without the default types", () => {
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
  expect(running(ix).map((x) => x.item.id)).toEqual([plan]);
  // an option called "Ruht" is just active: nothing below it rests
  m.change(plan, (doc) => doc.getMap("props").set("p_state", "v_rest"));
  ix = m.index();
  expect(ix.isDormant(ix.get(a)!)).toBe(false);
  expect(running(ix).map((x) => x.item.id)).toEqual([plan]);
  // done: the plan and everything below it rests
  m.change(plan, (doc) => doc.getMap("props").set("p_state", "v_ok"));
  ix = m.index();
  expect(ix.isDormant(ix.get(a)!)).toBe(true);
  expect(running(ix)).toEqual([]);
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
  expect(ix.isDormant(ix.get(c)!)).toBe(false); // "Pausiert" is an option in Aktiv, nothing more
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
  expect(running(ix).map((x) => x.item.id)).toEqual([plan]); // still counts progress of others
});

test("running lists active entries of any type, the topmost only", () => {
  const m = ownTypes();
  m.change("t_plan", (doc) => upsertProp(doc, "p_done", { computed: { fn: "progress" } }));
  const plan = m.add({ title: "Umzug", type: "t_plan", props: { p_state: "v_on" } });
  m.add({ title: "Kartons", type: "t_step", parents: [plan], props: { p_state: "s_on" } });
  const loose = m.add({ title: "Steuer", type: "t_step", props: { p_state: "s_on" } });
  m.add({ title: "Später", type: "t_step", props: { p_state: "s_new" } });
  expect(running(m.index()).map((x) => x.item.id).sort()).toEqual([plan, loose].sort());
});

test("a status word picks an option of its group, preferring a fitting name", () => {
  const p: PropDef = {
    id: "p",
    name: "Stand",
    kind: "status",
    sort: "V",
    options: [
      { id: "a", name: "Läuft", group: "active" },
      { id: "b", name: "Pausiert", group: "active" },
      { id: "c", name: "Fertig", group: "done" },
    ],
  };
  expect(matchOption(p, "on hold").id).toBe("b");
  expect(matchOption(p, "in Arbeit").id).toBe("a");
  expect(matchOption(p, "verworfen").id).toBe("c"); // no option called so: the first of done
});

test("progress counts every option of the done group as finished", () => {
  const m = ownTypes();
  const plan = m.add({ title: "Umzug", type: "t_plan", props: { p_state: "v_on" } });
  m.add({ title: "Kartons", type: "t_step", parents: [plan], props: { p_state: "s_ok" } });
  m.add({ title: "Klavier", type: "t_step", parents: [plan], props: { p_state: "s_no" } });
  m.add({ title: "Packen", type: "t_step", parents: [plan], props: { p_state: "s_rest" } });
  expect(m.index().progressOf(m.index().get(plan)!)).toEqual({ done: 2, total: 3 });
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
