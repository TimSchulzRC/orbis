// The inbox's own tabs are data: the settings' tabs, each a filter over the inbox. The app gives no
// type a role there: setup writes "To-dos" as an ordinary tab, and a new entry gets what a tab's
// filter asks for. Renaming the type keeps the tab; deleting it shows as a missing type.
import { describe, expect, test } from "bun:test";
import { SETTINGS_ID, setProp, setSchemaField, setTab, upsertProp } from "@orbis/core/model";
import { initFromWhere, runQuery, tabDef } from "@orbis/core/query";
import { runSetup, SYS } from "@orbis/core/setup";
import { deleteType } from "@orbis/core/typeops";
import { MemRepo } from "../support/helpers";

const setup = () => {
	const m = new MemRepo();
	runSetup(m.writer, "de");
	return m;
};
const tabs = (m: MemRepo) => m.index().all.get(SETTINGS_ID)!.settings!.inboxTabs;
const shown = (m: MemRepo, n = 0) =>
	runQuery(tabDef({ inbox: true }, tabs(m)[n]!), { ix: m.index() })
		.items.map((i) => i.title)
		.sort();

describe("setup", () => {
	test('brings "To-dos" as an ordinary tab: the tasks in the inbox, priority beside', () => {
		const m = setup();
		expect(tabs(m)).toMatchObject([
			{
				id: "v_todos",
				kind: "list",
				name: "To-dos",
				where: { type: SYS.task },
				columns: ["Priorität"],
			},
		]);
		runSetup(m.writer, "de");
		expect(tabs(m).length).toBe(1);
	});

	test("the tab lists what lies in the inbox and matches; done, it leaves", () => {
		const m = setup();
		const project = m.add({ title: "Relaunch", type: SYS.project });
		const call = m.add({ title: "Call Lena", type: SYS.task, parents: [project], inbox: 1 });
		m.add({ title: "Elsewhere", type: SYS.task, parents: [project] });
		m.add({ title: "A thought" });
		expect(shown(m)).toEqual(["Call Lena"]);
		m.change(call, (d) => setProp(d, "p_status", "st_done"));
		expect(shown(m)).toEqual([]);
	});
});

describe("the tab is data, not a role of a type", () => {
	test("a status for notes does not make them to-dos", () => {
		const m = setup();
		m.add({ title: "A thought", type: SYS.card, inbox: 1 });
		m.change(SYS.card, (d) =>
			upsertProp(d, "p_state", {
				name: "Stand",
				kind: "status",
				options: [
					{ id: "o1", name: "Offen", group: "todo" },
					{ id: "o2", name: "Fertig", group: "done" },
				],
			}),
		);
		m.add({ title: "Call Lena", type: SYS.task, inbox: 1 });
		expect(shown(m)).toEqual(["Call Lena"]);
	});

	test("the type renamed, the tab keeps its entries", () => {
		const m = setup();
		m.add({ title: "Call Lena", type: SYS.task, inbox: 1 });
		m.change(SYS.task, (d) => setSchemaField(d, "name", "Aufgabe"));
		expect(shown(m)).toEqual(["Call Lena"]);
	});

	test("the type deleted, the tab says so and makes nothing new", () => {
		const m = setup();
		m.add({ title: "Call Lena", type: SYS.task, inbox: 1 });
		deleteType(m.writer, m.index(), SYS.task, { mode: "tag", tag: "task" }, "Task gelöscht");
		const res = runQuery(tabDef({ inbox: true }, tabs(m)[0]!), { ix: m.index() });
		expect(res.missingTypes).toEqual([SYS.task]);
		expect(res.items).toEqual([]);
		expect(initFromWhere(tabs(m)[0]!.where, m.index())).toBeUndefined();
	});

	test("a tab of the user's own, by tag", () => {
		const m = setup();
		m.change(SETTINGS_ID, (d) =>
			setTab(d, "v_calls", { kind: "list", name: "Anrufe", pos: "b", where: { tag: "anruf" } }),
		);
		m.add({ title: "Call Lena", tags: ["anruf"], inbox: 1 });
		m.add({ title: "Call Lena", type: SYS.task, inbox: 1 });
		expect(tabs(m).map((x) => x.name)).toEqual(["To-dos", "Anrufe"]);
		expect(shown(m, 1)).toEqual(["Call Lena"]);
		expect(
			runQuery(tabDef({ inbox: true }, tabs(m)[1]!), { ix: m.index() }).items[0]!.type,
		).toBeNull();
	});
});

describe("a new entry gets what the filter asks for", () => {
	test("the type, with an open status", () => {
		const m = setup();
		expect(initFromWhere({ type: SYS.task }, m.index())).toEqual({
			type: SYS.task,
			tags: [],
			parents: [],
			props: {},
		});
		// a type that starts done: the new one starts open
		m.change(SYS.task, (d) => upsertProp(d, "p_status", { default: "st_done" }));
		expect(initFromWhere({ type: SYS.task }, m.index())?.props).toEqual({ p_status: "st_todo" });
	});

	test("tags, a place, an option and a status group; what it cannot know it leaves", () => {
		const m = setup();
		const project = m.add({ title: "Relaunch", type: SYS.project });
		const init = initFromWhere(
			{
				and: [
					{ type: SYS.task },
					{ tag: "anruf" },
					{ in: { id: project } },
					{ prop: "Priorität", op: ":", value: "hoch" },
					{ status: "active" },
					{ text: "Lena" },
				],
			},
			m.index(),
		);
		expect(init).toEqual({
			type: SYS.task,
			tags: ["anruf"],
			parents: [project],
			props: { p_priority: "pr_high", p_status: "st_active" },
		});
	});

	test("without a type, a note; an OR it leaves alone", () => {
		const m = setup();
		expect(initFromWhere({ or: [{ type: SYS.task }, { type: SYS.project }] }, m.index())).toEqual({
			type: null,
			tags: [],
			parents: [],
			props: {},
		});
	});
});
