import { describe, expect, test } from "bun:test";
import { addDaysISO, setMember } from "@orbis/core/model";
import {
	blocksAsText,
	findBlocks,
	groupItems,
	normalizeBlocks,
	parseQuery,
	printQuery,
	readBlock,
	runQuery,
	shownByBlocks,
	tabDef,
} from "@orbis/core/query";
import { runSetup, SYS } from "@orbis/core/setup";
import { MemRepo } from "../support/helpers";

function world() {
	const m = new MemRepo();
	runSetup(m.writer, "de");
	const person = "t_person";
	m.addType(person, {
		name: "Person",
		icon: "user",
		color: "pink",
		properties: [{ id: "p_role", name: "Role", kind: "text" }],
	});
	const work = m.add({ title: "Work", pinned: "V" });
	const relaunch = m.add({
		title: "Relaunch",
		type: SYS.project,
		parents: [work],
		props: { p_status: "st_active" },
	});
	const fr = m.add({
		title: "Relaunch France",
		type: SYS.project,
		parents: [relaunch],
		props: { p_status: "st_active" },
	});
	const nord = m.add({ title: "Nordlicht", pinned: "W", tags: ["client"] });
	const nordFr = m.add({
		title: "Nordlicht · France",
		type: SYS.project,
		parents: [fr, nord],
		props: { p_status: "st_planning" },
	});
	const t1 = m.add({
		title: "Create mockups",
		type: SYS.task,
		parents: [fr],
		props: { p_status: "st_active", p_due: addDaysISO(3) },
	});
	const t2 = m.add({
		title: "Pick colours",
		type: SYS.task,
		parents: [nordFr],
		props: { p_status: "st_todo", p_due: addDaysISO(-2) },
	});
	const t3 = m.add({
		title: "Kick-off",
		type: SYS.task,
		parents: [nordFr],
		props: { p_status: "st_done" },
	});
	const sub = m.add({
		title: "Check required fields",
		type: SYS.task,
		parents: [t1],
		props: { p_status: "st_todo" },
	});
	const module = m.add({
		title: "Databases",
		pinned: "X",
		tags: ["module"],
		extra: { ECTS: { k: "number", v: 6 }, Grade: { k: "number", v: 1.7 } },
	});
	const julia = m.add({ title: "Julia Weber", tags: ["people"], parents: [work] });
	const martin = m.add({ title: "Martin Kleppmann", type: person, tags: ["people", "author"] });
	const inbox = m.add({ title: "Idea: validation", body: "[[Nordlicht · France]]" });
	return {
		m,
		ix: m.index(),
		work,
		relaunch,
		fr,
		nord,
		nordFr,
		t1,
		t2,
		t3,
		sub,
		module,
		julia,
		martin,
		inbox,
		person,
	};
}

const titles = (items: { title: string }[]) => items.map((i) => i.title).sort();

describe("query language", () => {
	test("German and English parse to the same JSON with ids", () => {
		const w = world();
		const de = parseQuery(
			"typ:Task status:offen unter:[[Relaunch]] fällig<=+7d sort:fällig gruppe:pfad",
			w.ix,
		);
		const en = parseQuery(
			"type:Task status:open under:[[Relaunch]] due<=+7d sort:due group:path",
			w.ix,
		);
		expect(de.errors).toEqual([]);
		expect(de.def).toEqual(en.def);
		expect(JSON.stringify(de.def)).toContain(w.relaunch);
		expect(printQuery(de.def, "de", w.ix)).toBe(
			"typ:Task status:offen unter:[[Relaunch]] fällig<=+7d sort:fällig gruppe:pfad",
		);
		expect(printQuery(de.def, "en", w.ix)).toBe(
			"type:Task status:open under:[[Relaunch]] due<=+7d sort:due group:path",
		);
	});

	test("open = not done; under: aggregates over all levels and parents, each once", () => {
		const w = world();
		const r = runQuery(parseQuery("typ:Task status:offen unter:[[Relaunch]]", w.ix).def, {
			ix: w.ix,
		});
		expect(titles(r.items)).toEqual(["Check required fields", "Create mockups", "Pick colours"]);
		const viaClient = runQuery(parseQuery("typ:Task unter:[[Nordlicht]]", w.ix).def, { ix: w.ix });
		expect(titles(viaClient.items)).toEqual(["Kick-off", "Pick colours"]);
		expect(
			titles(runQuery(parseQuery("typ:Task status:neu", w.ix).def, { ix: w.ix }).items),
		).toEqual(["Check required fields", "Pick colours"]);
		expect(
			titles(
				runQuery(parseQuery("typ:Projekt -status:erledigt in:[[Relaunch]]", w.ix).def, { ix: w.ix })
					.items,
			),
		).toEqual(["Relaunch France"]);
	});

	test("type or tag, free properties, diese", () => {
		const w = world();
		expect(
			titles(
				runQuery(parseQuery("(typ:Person | #people) sort:titel", w.ix).def, { ix: w.ix }).items,
			),
		).toEqual(["Julia Weber", "Martin Kleppmann"]);
		expect(
			titles(runQuery(parseQuery("(typ:Person | #people) #author", w.ix).def, { ix: w.ix }).items),
		).toEqual(["Martin Kleppmann"]);
		expect(titles(runQuery(parseQuery("#module grade<2", w.ix).def, { ix: w.ix }).items)).toEqual([
			"Databases",
		]);
		// German decimal comma
		expect(titles(runQuery(parseQuery("#module grade<1,5", w.ix).def, { ix: w.ix }).items)).toEqual(
			[],
		);
		expect(
			titles(runQuery(parseQuery("in:diese", w.ix).def, { ix: w.ix, thisId: w.work }).items),
		).toEqual(["Julia Weber", "Relaunch"]);
	});

	test("due dates work through the type's due role", () => {
		const w = world();
		expect(
			titles(runQuery(parseQuery("status:offen fällig<heute", w.ix).def, { ix: w.ix }).items),
		).toEqual(["Pick colours"]);
		expect(
			titles(runQuery(parseQuery("fällig>heute fällig<=+7d", w.ix).def, { ix: w.ix }).items),
		).toEqual(["Create mockups"]);
		expect(
			titles(runQuery(parseQuery("fällig:leer typ:Task", w.ix).def, { ix: w.ix }).items),
		).toEqual(["Check required fields", "Kick-off"]);
	});

	test("inbox, linked, status by option name", () => {
		const w = world();
		expect(titles(runQuery(parseQuery("eingang", w.ix).def, { ix: w.ix }).items)).toEqual([
			"Idea: validation",
		]);
		expect(
			titles(
				runQuery(parseQuery("verknüpft:[[Nordlicht · France]]", w.ix).def, { ix: w.ix }).items,
			),
		).toContain("Idea: validation");
		expect(
			titles(runQuery(parseQuery('status:"In Bearbeitung"', w.ix).def, { ix: w.ix }).items),
		).toEqual(["Create mockups", "Relaunch", "Relaunch France"]);
	});

	test("group by path relative to the page; sub-tasks stay with their parent task's group", () => {
		const w = world();
		const def = parseQuery("typ:Task unter:diese gruppe:pfad", w.ix).def;
		const ctx = { ix: w.ix, thisId: w.relaunch };
		const res = runQuery(def, ctx);
		const groups = groupItems(res.items, "path", ctx, w.relaunch);
		const label = (g: { path?: string[] }) =>
			(g.path ?? []).map((id) => w.ix.get(id)!.title).join(" › ");
		expect(groups.map(label)).toEqual(["Relaunch France", "Relaunch France › Nordlicht · France"]);
		expect(titles(groups[0]!.items)).toEqual(["Check required fields", "Create mockups"]);
	});

	test("a query on a deleted type reports it", () => {
		const w = world();
		const def = parseQuery("typ:Person", w.ix).def;
		w.m.change(w.person, (d) => d.getMap("meta").set("deleted", true));
		const ix = w.m.index();
		const r = runQuery(def, { ix });
		expect(r.items).toEqual([]);
		expect(r.missingTypes).toEqual([w.person]);
		expect(printQuery(def, "de", ix)).toBe("typ:Person");
	});

	test("blocks in the text: text form is normalised to JSON and printed back", () => {
		const w = world();
		const body = "Intro\n\n```query typ:Task status:offen unter:diese```\n\nEnd";
		const norm = normalizeBlocks(body, w.ix);
		expect(norm).toContain('"type":"sys:task"');
		const b = findBlocks(norm);
		expect(b.length).toBe(1);
		expect(readBlock(b[0]!.src, w.ix).wasText).toBe(false);
		expect(blocksAsText(norm, "en", w.ix)).toContain("type:Task status:open under:this");
	});

	test("view keywords", () => {
		const w = world();
		const { def } = parseQuery("in:diese #module spalten:ects,grade ansicht:tabelle max:5", w.ix);
		expect(def.columns).toEqual(["ects", "grade"]);
		expect(def.view).toBe("table");
		expect(def.limit).toBe(5);
		expect(printQuery(def, "en", w.ix)).toBe(
			"in:this #module view:table columns:ects,grade limit:5",
		);
	});
});

test("a block with in:this in the text hides those children from the automatic Below list", () => {
	const w = world();
	w.m.change(w.work, (d) => d.getText("body").insert(0, "```query in:diese typ:Projekt```"));
	const ix = w.m.index();
	const hidden = shownByBlocks(ix.get(w.work)!, ix);
	expect([...hidden].map((id) => ix.get(id)!.title)).toEqual(["Relaunch"]);
});

test("verknüpft:unter: finds items linked to X or to a descendant of X – e.g. a context inbox", () => {
	const w = world();
	// "Idea: validation" links [[Nordlicht · France]], which is below Work (and below Nordlicht)
	const ix = w.m.index();
	const def = parseQuery("eingang verknüpft:unter:[[Work]]", ix).def;
	expect(runQuery(def, { ix }).items.map((i) => i.title)).toEqual(["Idea: validation"]);
	expect(printQuery(def, "de", ix)).toBe("eingang verknüpft:unter:[[Work]]");
	expect(printQuery(def, "en", ix)).toBe("inbox linked:under:[[Work]]");
	expect(parseQuery("inbox linked:under:[[Work]]", ix).def).toEqual(def);
	expect(
		runQuery(parseQuery("eingang verknüpft:unter:[[Databases]]", ix).def, { ix }).items,
	).toEqual([]);
	expect(runQuery(parseQuery("verknüpft:[[Work]]", ix).def, { ix }).items).toEqual([]); // plain verknüpft: only X itself
});

test("blockiert: an open blocker or a waiting-for text; ohne:offene-kinder", () => {
	const m = new MemRepo();
	runSetup(m.writer, "de");
	const p = m.add({ title: "Project", type: SYS.project, props: { p_status: "st_active" } });
	const a = m.add({ title: "A", type: SYS.task, parents: [p], props: { p_status: "st_todo" } });
	m.add({
		title: "B",
		type: SYS.task,
		parents: [p],
		props: { p_status: "st_todo" },
		rels: { p_blocked: [a] },
	});
	const c = m.add({
		title: "C",
		type: SYS.task,
		parents: [p],
		props: { p_status: "st_todo", p_waiting: "Certificate from the client" },
	});
	m.add({ title: "C1", type: SYS.task, parents: [c], props: { p_status: "st_done" } });
	const d = m.add({ title: "D", type: SYS.task, parents: [p], props: { p_status: "st_todo" } });
	m.add({ title: "D1", type: SYS.task, parents: [d], props: { p_status: "st_todo" } });
	const run = (q: string) => {
		const ix = m.index();
		return runQuery(parseQuery(q, ix).def, { ix })
			.items.map((i) => i.title)
			.sort();
	};
	expect(run("blockiert")).toEqual(["B", "C"]);
	expect(run("blocked")).toEqual(["B", "C"]);
	expect(run("typ:Task -blockiert ohne:offene-kinder status:offen")).toEqual(["A", "D1"]);
	expect(run("type:Task without:open-children")).toEqual(["A", "B", "C", "C1", "D1"]);
	// the blocker is done: B is free again
	m.change(a, (doc) => doc.getMap("props").set("p_status", "st_done"));
	expect(run("blockiert")).toEqual(["C"]);
	// printed back in either language
	const ix = m.index();
	expect(printQuery(parseQuery("blockiert ohne:offene-kinder", ix).def, "en", ix)).toBe(
		"blocked without:open-children",
	);
});

test("files under a project: below it, or used in an entry below it (embedded, linked, ref)", () => {
	const m = new MemRepo();
	const proj = m.add({ title: "Project" });
	const note = m.add({
		title: "Meeting",
		parents: [proj],
		body: "See ![[spec.pdf]] and [[plan.pdf]].",
	});
	m.add({ kind: "file", title: "spec.pdf" }); // no place of its own: embedded in the meeting
	m.add({ kind: "file", title: "plan.pdf", parents: [m.add({ title: "Archive" })] }); // placed elsewhere, linked in the meeting
	m.add({ kind: "file", title: "direct.pdf", parents: [proj] });
	m.add({ kind: "file", title: "other.pdf" });
	const r = m.add({ kind: "file", title: "ref.pdf" });
	m.change(note, (d) => setMember(d, "refs", r, true));
	const ix = m.index();
	const titles = runQuery(parseQuery("datei unter:[[Project]]", ix).def, { ix })
		.items.map((i) => i.title)
		.sort();
	expect(titles).toEqual(["direct.pdf", "plan.pdf", "ref.pdf", "spec.pdf"]);
	// in: (directly below) stays strict
	expect(
		runQuery(parseQuery("datei in:[[Project]]", ix).def, { ix }).items.map((i) => i.title),
	).toEqual(["direct.pdf"]);
});

test("a view's filter applies without a base query too", () => {
	const where = { tag: "x" };
	expect(tabDef(undefined, { id: "t", pos: "a", kind: "list", where }).where).toEqual(where);
	expect(tabDef({ type: "t_a" }, { id: "t", pos: "a", kind: "list" }).where).toEqual({
		type: "t_a",
	});
	expect(tabDef({ type: "t_a" }, { id: "t", pos: "a", kind: "list", where }).where).toEqual({
		and: [{ type: "t_a" }, where],
	});
});

test("a view's order by hand comes first, the rest follows as usual; a sort wins over it", () => {
	const { ix, relaunch, fr, nordFr } = world();
	const tab = { id: "t", pos: "a", kind: "table" as const };
	const ids = (extra: object) =>
		runQuery(tabDef({ type: SYS.project }, { ...tab, ...extra }), { ix }).items.map((i) => i.id);
	expect(ids({})).toEqual([nordFr, relaunch, fr]);
	expect(ids({ order: [fr] })).toEqual([fr, nordFr, relaunch]);
	expect(ids({ order: [fr, "gone", relaunch, nordFr] })).toEqual([fr, relaunch, nordFr]);
	expect(ids({ order: [fr], sort: [{ key: "title" }] })).toEqual([nordFr, relaunch, fr]);
});

test("a comparison without a value (a filter just added) lets everything through", () => {
	const { ix } = world();
	const count = (where: object) =>
		runQuery({ where: { and: [{ type: SYS.project }, where] } as never }, { ix }).items.length;
	expect(count({ prop: "Status", op: ":" })).toBe(3);
	expect(count({ prop: "Status", op: "!=", value: "" })).toBe(3);
	expect(count({ prop: "Status", op: ":", value: "Planung" })).toBe(1);
});
