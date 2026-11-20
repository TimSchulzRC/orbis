// Behaviour hangs on what the types mark (capabilities, `blocks`, a status option's group), never on a
// type's or property's id or name: without the default types, with other names, everything works.
import { expect, test } from "bun:test";
import { matchOption } from "@orbis/core/input";
import { type PropDef, removeProp, upsertProp } from "@orbis/core/model";
import { runSetup, SYS } from "@orbis/core/setup";
import { running } from "@orbis/core/today";
import { progressSpec } from "@orbis/core/traits";
import { deleteType } from "@orbis/core/typeops";
import { MemRepo } from "../support/helpers";

/** A project and its steps under other names, without any default type. */
function ownTypes() {
	const m = new MemRepo();
	m.addType("t_step", {
		name: "Step",
		properties: [
			{
				id: "p_state",
				name: "Stage",
				kind: "status",
				default: "s_new",
				options: [
					{ id: "s_new", name: "Fresh", group: "todo" },
					{ id: "s_on", name: "Running", group: "active" },
					{ id: "s_rest", name: "Resting", group: "active" },
					{ id: "s_ok", name: "Finished", group: "done" },
					{ id: "s_no", name: "Stopped", group: "done" },
				],
			},
			{ id: "p_after", name: "Depends on", kind: "relation", multiple: true, blocks: true },
			{ id: "p_who", name: "Pending with", kind: "text", blocks: true },
			{ id: "p_see", name: "See also", kind: "relation", multiple: true },
		],
	});
	m.addType("t_plan", {
		name: "Plan",
		properties: [
			{
				id: "p_state",
				name: "Stage",
				kind: "status",
				default: "v_on",
				options: [
					{ id: "v_on", name: "Running", group: "active" },
					{ id: "v_rest", name: "Resting", group: "active" },
					{ id: "v_ok", name: "Finished", group: "done" },
				],
			},
			{
				id: "p_done",
				name: "Completed",
				kind: "computed",
				computed: { fn: "progress", of: "t_step" },
			},
		],
	});
	return m;
}

test("blocked and done come from the marks and groups, under any name and without the default types", () => {
	const m = ownTypes();
	const plan = m.add({ title: "Move", type: "t_plan", props: { p_state: "v_on" } });
	const a = m.add({ title: "Boxes", type: "t_step", parents: [plan], props: { p_state: "s_new" } });
	const b = m.add({
		title: "Packing",
		type: "t_step",
		parents: [plan],
		props: { p_state: "s_new" },
		rels: { p_after: [a] },
	});
	const c = m.add({
		title: "Keys",
		type: "t_step",
		parents: [plan],
		props: { p_state: "s_new", p_who: "Landlord" },
	});
	const d = m.add({
		title: "Note",
		type: "t_step",
		parents: [plan],
		props: { p_state: "s_new" },
		rels: { p_see: [a] },
	});
	let ix = m.index();
	expect(ix.isBlocked(ix.get(b)!)).toBe(true);
	expect(ix.blockers(ix.get(c)!).waiting).toBe("Landlord");
	expect(ix.isBlocked(ix.get(d)!)).toBe(false); // a relation without the mark holds nothing up
	expect(ix.nextTask(plan, "2026-10-31")?.id).toBe(a); // "Boxes" before "Note"; the blocked ones not
	expect(running(ix).map((x) => x.item.id)).toEqual([plan]);
	// an option called "Resting" is just active: nothing below it rests
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
	runSetup(m.writer, "en");
	m.change(SYS.task, (doc) => {
		upsertProp(doc, "p_blocked", { name: "Depends on" });
		upsertProp(doc, "p_waiting", { name: "Pending with" });
	});
	const a = m.add({ title: "A", type: SYS.task, props: { p_status: "st_todo" } });
	const b = m.add({
		title: "B",
		type: SYS.task,
		props: { p_status: "st_todo" },
		rels: { p_blocked: [a] },
	});
	const c = m.add({ title: "C", type: SYS.task, props: { p_status: "st_paused" } });
	let ix = m.index();
	expect(ix.isBlocked(ix.get(b)!)).toBe(true);
	expect(ix.isDormant(ix.get(c)!)).toBe(false); // "Paused" is an option in Active, nothing more
	// an own type with a relation that only is called "Blocked by"
	m.addType("t_x", {
		name: "X",
		properties: [{ id: "p_x", name: "Blocked by", kind: "relation" }],
	});
	const x = m.add({ title: "X1", type: "t_x", rels: { p_x: [a] } });
	ix = m.index();
	expect(ix.isBlocked(ix.get(x)!)).toBe(false);
});

test("progress on a deleted type filters nothing", () => {
	const m = ownTypes();
	m.addType("t_gone", { name: "Gone" });
	m.change("t_plan", (doc) =>
		upsertProp(doc, "p_done", { computed: { fn: "progress", of: "t_gone" } }),
	);
	const plan = m.add({ title: "Move", type: "t_plan", props: { p_state: "v_on" } });
	const a = m.add({ title: "Boxes", type: "t_step", parents: [plan], props: { p_state: "s_new" } });
	deleteType(m.writer, m.index(), "t_gone", { mode: "remove" }, "test");
	const ix = m.index();
	expect(ix.nextTask(plan, "2026-10-31")?.id).toBe(a); // was: nothing, every step filtered out by the deleted type
	expect(running(ix).map((x) => x.item.id)).toEqual([plan]); // still counts progress of others
});

test("running lists active entries of any type, the topmost only", () => {
	const m = ownTypes();
	m.change("t_plan", (doc) => upsertProp(doc, "p_done", { computed: { fn: "progress" } }));
	const plan = m.add({ title: "Move", type: "t_plan", props: { p_state: "v_on" } });
	m.add({ title: "Boxes", type: "t_step", parents: [plan], props: { p_state: "s_on" } });
	const loose = m.add({ title: "Taxes", type: "t_step", props: { p_state: "s_on" } });
	m.add({ title: "Later", type: "t_step", props: { p_state: "s_new" } });
	expect(
		running(m.index())
			.map((x) => x.item.id)
			.sort(),
	).toEqual([plan, loose].sort());
});

test("a status word picks an option of its group, preferring a fitting name", () => {
	const p: PropDef = {
		id: "p",
		name: "Stage",
		kind: "status",
		sort: "V",
		options: [
			{ id: "a", name: "Running", group: "active" },
			{ id: "b", name: "Paused", group: "active" },
			{ id: "c", name: "Finished", group: "done" },
		],
	};
	expect(matchOption(p, "on hold").id).toBe("b");
	// German status words work too
	expect(matchOption(p, "in Arbeit").id).toBe("a");
	expect(matchOption(p, "verworfen").id).toBe("c"); // no option called so: the first of done
});

test("progress counts every option of the done group as finished", () => {
	const m = ownTypes();
	const plan = m.add({ title: "Move", type: "t_plan", props: { p_state: "v_on" } });
	m.add({ title: "Boxes", type: "t_step", parents: [plan], props: { p_state: "s_ok" } });
	m.add({ title: "Piano", type: "t_step", parents: [plan], props: { p_state: "s_no" } });
	m.add({ title: "Packing", type: "t_step", parents: [plan], props: { p_state: "s_rest" } });
	expect(m.index().progressOf(m.index().get(plan)!)).toEqual({ done: 2, total: 3 });
});

test("progress comes from the computed property", () => {
	const m = new MemRepo();
	m.addType("t_old", { name: "Old" });
	let s = m.index().types.get("t_old")!.schema;
	expect(progressSpec(s)).toBeUndefined();
	m.change("t_old", (doc) =>
		upsertProp(doc, "p_pr", { name: "Progress", kind: "computed", computed: { fn: "progress" } }),
	);
	s = m.index().types.get("t_old")!.schema;
	expect(progressSpec(s)).toEqual({ of: undefined });
	m.change("t_old", (doc) => removeProp(doc, "p_pr"));
	s = m.index().types.get("t_old")!.schema;
	expect(progressSpec(s)).toBeUndefined(); // removing it turns the bar off
});
