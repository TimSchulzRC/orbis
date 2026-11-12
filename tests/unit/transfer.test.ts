import { expect, test } from "bun:test";
import { initItem, newId } from "@obtion/core/model";
import { runSetup, SYS } from "@obtion/core/setup";
import { copyToWorkspace, movedItems, planMove } from "@obtion/core/transfer";
import { MemRepo } from "../support/helpers";

function workspace(lang: "de" | "en" = "de") {
	const m = new MemRepo();
	runSetup(m.writer, lang);
	return m;
}

test("a move takes what hangs only below; parents, refs and relations outside stay behind", () => {
	const a = workspace();
	const b = workspace();
	const work = a.add({ title: "Work", pinned: "a" });
	const other = a.add({ title: "Elsewhere", pinned: "b" });
	const relaunch = a.add({
		title: "Relaunch",
		type: SYS.project,
		parents: [work],
		props: { p_status: "st_active", p_priority: "pr_high" },
		refs: [other],
		body: "See [[Elsewhere]] and [[" + other + "|there]].",
	});
	const t1 = a.add({
		title: "Build pages",
		type: SYS.task,
		parents: [relaunch],
		props: { p_status: "st_todo" },
	});
	const shared = a.add({ title: "Also elsewhere", parents: [relaunch, other] });
	const blocker = a.add({
		title: "Blocker",
		type: SYS.task,
		parents: [relaunch],
		rels: { p_blocked: [t1] },
	});
	expect(
		movedItems(a.index(), relaunch)
			.map((r) => r.title)
			.sort(),
	).toEqual(["Blocker", "Build pages", "Relaunch"]);

	// the shipped types match: nothing changes on the way but the three links to "Elsewhere"
	expect(planMove(a.index(), relaunch, b.index())).toEqual({
		items: 3,
		files: 0,
		copiedTypes: [],
		freeProps: [],
		droppedLinks: 3,
	});

	const target = b.add({ title: "Company", pinned: "a" });
	const moved = copyToWorkspace(
		a.index(),
		relaunch,
		{ w: b.writer, ix: b.index() },
		{ parent: target },
		"web:test",
	);
	expect(moved.types).toEqual([]); // the shipped types exist there
	const bix = b.index();
	const r = bix.get(moved.ids.get(relaunch)!)!;
	expect(r).toMatchObject({
		title: "Relaunch",
		type: SYS.project,
		props: { p_status: "st_active", p_priority: "pr_high" },
		refs: [],
	});
	expect(Object.keys(r.parents)).toEqual([target]);
	expect(r.body).toBe("See [[Elsewhere]] and [[there]].");
	const nt1 = moved.ids.get(t1)!;
	expect(Object.keys(bix.get(nt1)!.parents)).toEqual([r.id]);
	const nb = bix.get(moved.ids.get(blocker)!)!;
	expect(Object.values(nb.rels).flat()).toEqual([nt1]);
	expect(moved.ids.has(shared)).toBe(false);
});

test("types: same name maps property by property and option by name; a missing type is copied; leftovers become free properties", () => {
	const a = workspace();
	const b = workspace("en"); // other ids for nothing, other names for everything
	const book = a.addType(newId(), {
		name: "Book",
		icon: "book",
		color: "blue",
		properties: [
			{ id: "p_author", name: "Author", kind: "text" },
			{ id: "p_state", name: "State", kind: "select", options: [{ id: "o1", name: "Read" }] },
		],
	});
	const item = a.add({ title: "Moor", type: book, props: { p_author: "Ann", p_state: "o1" } });
	// b has a type of the same name with other ids and only one of the properties
	const bBook = b.addType(newId(), {
		name: "Book",
		icon: "book",
		color: "blue",
		properties: [
			{ id: "x_state", name: "state", kind: "select", options: [{ id: "x1", name: "read" }] },
		],
	});
	expect(planMove(a.index(), item, b.index())).toMatchObject({
		items: 1,
		copiedTypes: [],
		freeProps: ["Author"],
	});
	const m1 = copyToWorkspace(a.index(), item, { w: b.writer, ix: b.index() }, {}, "web:test");
	const got = b.index().get(m1.ids.get(item)!)!;
	expect(got.type).toBe(bBook);
	expect(got.props).toEqual({ x_state: "x1" });
	expect(got.extra).toEqual({ Author: { k: "text", v: "Ann" } });
	expect(got.parents).toEqual({}); // no place: the inbox there

	// a third workspace without the type: it is copied with its properties
	const c = new MemRepo();
	expect(planMove(a.index(), item, c.index())).toMatchObject({
		copiedTypes: ["Book"],
		freeProps: [],
	});
	const m2 = copyToWorkspace(
		a.index(),
		item,
		{ w: c.writer, ix: c.index() },
		{ pinned: "a" },
		"web:test",
	);
	expect(m2.types.length).toBe(1);
	const cix = c.index();
	const copy = cix.get(m2.ids.get(item)!)!;
	expect([copy.type]).toEqual(m2.types);
	expect(cix.get(m2.types[0]!)!.schema!.properties.map((p) => p.name)).toEqual(["Author", "State"]);
	expect(copy.props).toEqual({ p_author: "Ann", p_state: "o1" });
	expect(copy.pinned).toBe("a");
});

test("files bring their contents' hashes; status updates keep their status where it maps", () => {
	const a = workspace();
	const b = workspace();
	const p = a.add({ title: "P", type: SYS.project });
	a.change(p, (d) =>
		d
			.getArray("updates")
			.push([{ id: "u1", at: 5, text: "running", by: "you", status: "st_active" }]),
	);
	const f = newId();
	a.change(f, (d) => {
		initItem(d, { kind: "file", title: "sketch.png", parents: [p] });
		const m = d.getMap("file");
		for (const [k, v] of Object.entries({
			hash: "a".repeat(64),
			name: "sketch.png",
			mime: "image/png",
			filetype: "image",
			size: 3,
			thumb: "b".repeat(64),
		}))
			m.set(k, v);
	});
	const moved = copyToWorkspace(a.index(), p, { w: b.writer, ix: b.index() }, {}, "web:test");
	expect(moved.hashes.sort()).toEqual(["a".repeat(64), "b".repeat(64)]);
	const nf = b.index().get(moved.ids.get(f)!)!;
	expect(nf.file).toMatchObject({ hash: "a".repeat(64), name: "sketch.png" });
	expect(b.index().get(moved.ids.get(p)!)!.updates).toMatchObject([
		{ at: 5, text: "running", status: "st_active" },
	]);
});

test("a move keeps the rules for agents", () => {
	const a = workspace();
	const b = workspace();
	const room = a.add({ title: "Project room", pinned: "a", rules: "Ask first." });
	a.add({ title: "Below", parents: [room], rules: "Read only." });
	const moved = copyToWorkspace(a.index(), room, { w: b.writer, ix: b.index() }, {}, "web:test");
	const bix = b.index();
	expect(bix.get(moved.ids.get(room)!)!.rules).toBe("Ask first.");
	expect([...moved.ids.values()].map((id) => bix.get(id)!.rules).sort()).toEqual([
		"Ask first.",
		"Read only.",
	]);
});
