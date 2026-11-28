import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addDrawing, drawingFence, writeElements } from "@orbis/core/drawing";
import {
	addDaysISO,
	addParent,
	replaceBody,
	SETTINGS_ID,
	setExtra,
	setSettings,
	todayISO,
} from "@orbis/core/model";
import { SYS } from "@orbis/core/setup";
import { deleteItem } from "@orbis/core/trash";
import { Mirror } from "@orbis/server/mirror";
import { OpError, type Ops } from "@orbis/server/ops";
import { capInput } from "@orbis/server/schemas";
import { storeWriter } from "@orbis/server/setup";
import type { Store } from "@orbis/server/store";
import * as Y from "yjs";
import { removeTempDirs } from "../support/helpers";
import { setupStore } from "../support/store";

afterAll(removeTempDirs);

let dir: string;
let s: Store;
let ops: Ops;
const A = "agent:test";
beforeEach(() => ({ dir, s, ops } = setupStore("orbis-ops-")));
const props = (ref: string) => ops.get(ref).properties as Record<string, unknown>;

test("progress report: status, update and follow-up task, all through names", () => {
	const p = ops.create(
		{ title: "Northern Lights · France", type: "Projekt", properties: { Status: "Planung" } },
		A,
	);
	const t = ops.create(
		{ title: "Mapping", type: "Task", parents: ["Northern Lights · France"] },
		A,
	);
	// "Northern Lights: mapping done, review on Friday"
	ops.update("Mapping", { properties: { Status: "erledigt" } }, A);
	ops.addUpdate("Northern Lights", "Mapping done, review on Friday", "In Bearbeitung", "test", A);
	ops.create(
		{ title: "Review", type: "Task", parents: [p.id], properties: { Fällig: "2026-10-30" } },
		A,
	);
	const got = ops.get(p.id);
	expect(got.status).toBe("In Bearbeitung (active)");
	expect((got.updates as { text: string }[])[0]!.text).toBe("Mapping done, review on Friday");
	expect(got.progress).toBe("1/2 done");
	expect(ops.get(t.id).status).toBe("Erledigt (done)");
	const q = ops.query("typ:Task status:offen unter:[[Northern Lights · France]]");
	expect(q.items.map((i) => i.title)).toEqual(["Review"]);
	expect(ops.line(q.items[0]!)).toContain("due 2026-10-30");
});

test("errors are helpful: unknown property, option, type, ambiguous title, cycles", () => {
	ops.create({ title: "P", type: "Projekt" }, A);
	expect(() =>
		ops.create({ title: "x", type: "Projekt", properties: { Color: "red" } }, A),
	).toThrow(/Unknown property "Color".*Status/);
	expect(() =>
		ops.create({ title: "x", type: "Projekt", properties: { Status: "Purple" } }, A),
	).toThrow(/Options: Backlog \(todo\)/);
	expect(() => ops.create({ title: "x", type: "Book" }, A)).toThrow(/Unknown type "Book"/);
	ops.create({ title: "Meeting" }, A);
	ops.create({ title: "Meeting" }, A);
	expect(() => ops.resolve("Meeting")).toThrow(/Several items/);
	const a = ops.create({ title: "A", type: "Karte" }, A);
	ops.create({ title: "B", type: "Karte", parents: [a.id] }, A);
	expect(() => ops.place(a.id, { add: ["B"] }, A)).toThrow(/cycle/);
});

test("free properties are only read and removed, never added", () => {
	const n = ops.create({ title: "Course", properties: {} }, A);
	s.change(n.id, A, (doc) => {
		setExtra(doc, "ECTS", { k: "number", v: 6 });
		setExtra(doc, "Grade", { k: "number", v: 1.7 });
	});
	s.flush();
	expect(ops.get(n.id).free_properties).toEqual({ ECTS: 6, Grade: 1.7 });
	ops.update(n.id, { free_properties_remove: ["ects"] }, A);
	expect(ops.get(n.id).free_properties).toEqual({ Grade: 1.7 });
	// without a type there is nowhere to put a new property
	expect(() => ops.update(n.id, { properties: { Color: "red" } }, A)).toThrow(
		/Properties belong to a type/,
	);
});

test("the agent suggests for inbox items instead of sorting them", () => {
	const i = ops.create({ title: "The Art of Doing Science – Hamming" }, A);
	const w = ops.create({ title: "Knowledge", type: "Karte" }, A);
	expect(!!ops.place(w.id, { pin: true }, A).now.pinned).toBe(true);
	expect(() => ops.place(i.id, { add: ["Knowledge"] }, A)).toThrow(/inbox.*suggest/);
	expect(() => ops.place(i.id, { pin: true }, A)).toThrow(/inbox/);
	expect(() => ops.update(i.id, { type: "Karte" }, A)).toThrow(/inbox/);
	ops.suggest(i.id, { type: "Karte", parents: ["Knowledge"], note: "Book" }, "test", A);
	const it = s.records.get(i.id)!;
	expect(it.suggestion?.type).toBe(SYS.card);
	expect(it.type).toBeNull();
});

test("a to-do made into the inbox stays there sorted; the agent may change it, the line says where it is", () => {
	const p = ops.create({ title: "Relaunch", type: "Projekt" }, A);
	const t = ops.create({ title: "Call Lena", type: "Task", parents: [p.id], inbox: true }, A);
	expect(ops.query("eingang").items.map((i) => i.title)).toEqual(["Call Lena"]);
	expect(ops.line(t)).toContain("in inbox");
	expect(ops.line(p)).not.toContain("in inbox");
	// sorted already: no longer the user's to sort, so the agent may move it on
	const other = ops.create({ title: "Website", type: "Projekt" }, A);
	const placed = ops.place(t.id, { add: [other.id], remove: [p.id] }, A);
	expect(placed.in_inbox).toBe(false);
	expect(ops.query("eingang").items.map((i) => i.title)).toEqual(["Call Lena"]);
	// done, it leaves the inbox
	ops.update(t.id, { properties: { Status: "erledigt" } }, A);
	expect(ops.query("eingang").items).toEqual([]);
});

test("a task the inbox rule took stays there when the agent sorts it", () => {
	// only tasks without a project land in this inbox by themselves
	storeWriter(s, A).change(SETTINGS_ID, (d) =>
		setSettings(d, { inbox: { and: [{ type: SYS.task }, { without: "parents" }] } }),
	);
	const p = ops.create({ title: "Relaunch", type: "Projekt" }, A);
	const t = ops.create({ title: "Call Lena", type: "Task" }, A);
	expect(ops.query("eingang").items.map((i) => i.title)).toEqual(["Call Lena"]);
	ops.place(t.id, { add: [p.id] }, A);
	expect(ops.query("eingang").items.map((i) => i.title)).toEqual(["Call Lena"]);
	expect(s.records.get(t.id)!.inbox).toBeGreaterThan(0);
});

test("files never get a type, neither directly nor as a suggestion", () => {
	const f = s.create({ kind: "file", title: "invoice.pdf" }, A);
	expect(() => ops.update(f, { type: "Karte" }, A)).toThrow(/file/);
	expect(() => ops.suggest(f, { type: "Karte" }, "test", A)).toThrow(/file/);
	expect(s.records.get(f)!.type).toBeNull();
});

test("a file has exactly one parent: a new place replaces it; MCP refuses a second one and explains", () => {
	const a = ops.create({ title: "Project A" }, A).id;
	const b = ops.create({ title: "Project B" }, A).id;
	const c = ops.create({ title: "Project C" }, A).id;
	const f = s.create({ kind: "file", title: "sketch.png", parents: [a, b] }, A); // two at once: the last one stays
	expect(s.index().parentsOf(f)).toEqual([b]);
	// the app's "Add place" and Alt-drag go through addParent: the place is replaced, the home follows
	s.change(f, A, (doc) => addParent(doc, c));
	s.flush();
	expect(s.index().parentsOf(f)).toEqual([c]);
	expect(s.index().home(f)).toBe(c);
	// MCP: a second parent is refused with the way to move it
	expect(() => ops.place(f, { add: ["Project A"] }, A)).toThrow(
		/exactly one parent.*remove the current one \("Project C"\)/,
	);
	expect(() => ops.place(f, { home: "Project A" }, A)).toThrow(/exactly one parent/);
	expect(() => ops.suggest(f, { parents: ["Project A", "Project B"] }, "test", A)).toThrow(
		/exactly one parent/,
	);
	expect(s.index().parentsOf(f)).toEqual([c]);
	// moving in one call is fine
	ops.place(f, { add: ["Project A"], remove: ["Project C"] }, A);
	expect(s.index().parentsOf(f)).toEqual([a]);
	// a note keeps any number of parents
	const n = ops.create({ title: "Note", parents: ["Project A", "Project B"] }, A).id;
	ops.place(n, { add: ["Project C"] }, A);
	expect(s.index().parentsOf(n).length).toBe(3);
});

test("an agent marks what holds up; the type shows the status groups", () => {
	ops.defineType(
		{
			name: "Step",
			properties: [
				{
					name: "Stage",
					kind: "status",
					options: ["New (todo)", "Resting (active)", "Finished (done)", "Stopped (done)"],
				},
				{ name: "Waits on", kind: "relation", multiple: true, blocks: true },
			],
		},
		A,
	);
	const a = ops.create({ title: "Boxes", type: "Step" }, A);
	const b = ops.create(
		{ title: "Packing", type: "Step", properties: { "Waits on": ["Boxes"] } },
		A,
	);
	const ix = s.index();
	expect(ix.isBlocked(ix.get(b.id)!)).toBe(true);
	ops.update("Boxes", { properties: { Stage: "in Arbeit" } }, A); // a German synonym finds the group
	expect(ops.get(a.id).status).toBe("Resting (active)");
	const info = ops.schema().types.find((x) => x.name === "Step")!;
	expect(info.properties.map((p) => p.options ?? p.blocks)).toEqual([
		["New (todo)", "Resting (active)", "Finished (done)", "Stopped (done)"],
		true,
	]);
	// a type has one status
	expect(() =>
		ops.updateType(
			"Step",
			{ add_properties: [{ name: "Second", kind: "status", options: ["A (todo)"] }] },
			A,
		),
	).toThrow(/has a status already/);
});

test("define a type and its views without code, query by type name", () => {
	ops.defineType({ name: "Person", description: "People" }, A);
	ops.defineType(
		{
			name: "Buch",
			properties: [
				{
					name: "Author",
					kind: "relation",
					target: "typ:Person",
					inverse: "Bücher",
					multiple: true,
				},
				{
					name: "Status",
					kind: "status",
					options: ["Want to read (todo)", "Reading (active)", "Read (done)"],
				},
				{ name: "Rating", kind: "number" },
			],
		},
		A,
	);
	ops.create({ title: "Richard Hamming", type: "Person" }, A);
	ops.create(
		{ title: "The Art", type: "Buch", properties: { Author: ["Richard Hamming"], Rating: "5" } },
		A,
	);
	ops.create({ title: "No author", type: "Buch" }, A);
	ops.updateType(
		"Buch",
		{
			views: [
				{ name: "No author", query: "author:leer", view: "triage" },
				{ name: "All", view: "table" },
			],
		},
		A,
	);
	// set up in German: "Buch" lists as "Bücher"
	const r = ops.query("Bücher");
	expect(r.list).toBe("Bücher");
	expect(r.items.map((i) => i.title)).toEqual(["No author"]);
	expect(
		ops
			.schema()
			.types.find((x) => x.name === "Buch")!
			.views.map((v) => v.name),
	).toEqual(["No author", "All"]);
	const person = ops.get("Richard Hamming");
	expect(person.related_by).toEqual(["Bücher: The Art"]);
	expect(props("The Art")).toMatchObject({
		Author: ["Richard Hamming"],
		Rating: 5,
		Status: "Want to read",
	});
	// numbers in plain or German notation
	for (const [raw, n] of [
		["4.5", 4.5],
		["4,5", 4.5],
		["1.234,5", 1234.5],
	] as const) {
		ops.update("The Art", { properties: { Rating: raw } }, A);
		expect(props("The Art").Rating).toBe(n);
	}
	expect(() => ops.update("The Art", { properties: { Rating: "lots" } }, A)).toThrow(/number/);
	ops.update("The Art", { properties: { Rating: 5 } }, A);
	expect(ops.convertPreview({ type: "Buch", direction: "type_to_tag" }).would_lose_type).toBe(2);
});

test("one kind of select: several values, a default that keeps it filled, a select turned into the status", () => {
	ops.defineType(
		{
			name: "Article",
			properties: [
				{ name: "Phase", kind: "select", options: ["Idea", "Draft", "Done"], default: "Idea" },
				{ name: "Channels", kind: "select", multiple: true, options: ["Blog", "Newsletter"] },
				{ name: "Stage", kind: "select", multiple: true, options: ["A", "B"] },
			],
		},
		A,
	);
	const info = ops.schema().types.find((x) => x.name === "Article")!;
	expect(info.properties.map((p) => [p.name, p.kind, p.multiple ?? false, p.default])).toEqual([
		["Phase", "select", false, "Idea"],
		["Channels", "select", true, undefined],
		["Stage", "select", true, undefined],
	]);
	// new entries get the default; several values take a list
	const a = ops.create(
		{ title: "First article", type: "Article", properties: { Channels: "Blog, Newsletter" } },
		A,
	);
	expect(props(a.id)).toMatchObject({
		Phase: "Idea",
		Channels: "Blog, Newsletter",
	});
	// with a default it cannot be emptied
	expect(() => ops.update(a.id, { properties: { Phase: null } }, A)).toThrow(/cannot be empty/);
	// a select becomes the status: its options get groups, the German "erledigt" works
	ops.updateType(
		"Article",
		{
			change_properties: [
				{
					property: "Phase",
					kind: "status",
					options: ["Idea (todo)", "Draft (active)", "Done (done)"],
				},
			],
		},
		A,
	);
	ops.update(a.id, { properties: { Phase: "erledigt" } }, A);
	expect(props(a.id).Phase).toBe("Done");
	expect(() => ops.update(a.id, { properties: { Phase: null } }, A)).toThrow(/cannot be empty/);
	// a second status is refused
	expect(() =>
		ops.updateType("Article", { change_properties: [{ property: "Channels", kind: "status" }] }, A),
	).toThrow(/has a status already/);
});

test("a status added later: default options, existing entries show the default, a multi select keeps its first match", () => {
	ops.defineType(
		{
			name: "Memo",
			properties: [{ name: "Phase", kind: "select", multiple: true, options: ["New", "Done"] }],
		},
		A,
	);
	const old = ops.create(
		{ title: "Old memo", type: "Memo", properties: { Phase: "Done, New" } },
		A,
	);
	ops.defineType({ name: "Slip" }, A);
	const z = ops.create({ title: "Already there", type: "Slip" }, A);
	// no options given: the three default ones of the German setup
	ops.updateType("Slip", { add_properties: [{ name: "Stage", kind: "status" }] }, A);
	const info = ops.schema().types.find((x) => x.name === "Slip")!;
	expect(info.properties[0]!.options).toEqual([
		"Offen (todo)",
		"Aktiv (active)",
		"Erledigt (done)",
	]);
	expect(ops.get(z.id).status).toBe("Offen (todo)");
	expect(ops.query("typ:Slip status:offen").items.map((i) => i.title)).toEqual(["Already there"]);
	expect(ops.query("typ:Slip stage:offen").items.map((i) => i.title)).toEqual(["Already there"]);
	expect(ops.query("typ:Slip stage:leer").items).toEqual([]);
	// several values into the one status: the first that matches an option
	ops.updateType(
		"Memo",
		{
			change_properties: [
				{ property: "Phase", kind: "status", options: ["New (todo)", "Done (done)"] },
			],
		},
		A,
	);
	expect(ops.get(old.id).status).toBe("Done (done)");
	// a status never runs out of options
	expect(() =>
		ops.updateType("Slip", { change_properties: [{ property: "Stage", options: [] }] }, A),
	).toThrow(/at least one option/);
	// removed capabilities are refused, not silently dropped
	expect(capInput.safeParse({ status: "Stage" }).success).toBe(false);
	expect(capInput.safeParse({ updates: true }).success).toBe(true);
});

test("query blocks written by an agent in text form are stored as JSON and read back as text", () => {
	const o = ops.create(
		{ title: "Work", body: "Projects:\n\n```query typ:Projekt unter:diese```" },
		A,
	);
	expect(s.records.get(o.id)!.body).toContain('"type":"sys:project"');
	expect(ops.get(o.id).body).toContain("typ:Projekt unter:diese");
});

test("markdown mirror writes items below their home and removes stale files", () => {
	const m = new Mirror(s, join(dir, "vault"));
	const a = ops.create({ title: "Work", pin: true }, A);
	const p = ops.create(
		{
			title: "Relaunch",
			type: "Projekt",
			parents: [a.id],
			properties: { Status: "In Bearbeitung" },
		},
		A,
	);
	ops.create({ title: "Idea" }, A);
	m.sync();
	const f = join(dir, "vault", "Work", "Relaunch.md");
	expect(readFileSync(f, "utf8")).toContain("Status:\n  - In Bearbeitung");
	expect(existsSync(join(dir, "vault", "Eingang", "Idea.md"))).toBe(true);
	ops.update(p.id, { title: "Relaunch 2026" }, A);
	m.sync();
	expect(existsSync(f)).toBe(false);
	expect(existsSync(join(dir, "vault", "Work", "Relaunch 2026.md"))).toBe(true);
});

test("a note's drawing: agents read its text, the mirror writes it as .excalidraw next to the note", () => {
	const m = new Mirror(s, join(dir, "vault"));
	const work = ops.create({ title: "Work", pin: true }, A);
	const n = ops.create(
		{ title: "Sketch", parents: [work.id], body: `Overview\n${drawingFence("d1")}\nEnd` },
		A,
	);
	// drawn on a device
	const client = new Y.Doc();
	Y.applyUpdate(client, Y.encodeStateAsUpdate(s.getDoc(n.id)));
	const sv = Y.encodeStateVector(client);
	client.transact(() => {
		addDrawing(client, "d1");
		writeElements(client, "d1", [
			{ id: "t", type: "text", text: "Login flow", version: 1, versionNonce: 1, index: "a0" },
		]);
	});
	s.applyRemote(n.id, Y.encodeStateAsUpdate(client, sv), "web:test");
	expect(ops.get(n.id).drawings).toEqual([{ id: "d1", elements: 1, text: "Login flow" }]);
	expect(ops.search("login flow").map((h) => h.item.id)).toContain(n.id);
	m.sync();
	const md = readFileSync(join(dir, "vault", "Work", "Sketch.md"), "utf8");
	expect(md).toContain("Overview\n![[Sketch.excalidraw]]\nEnd");
	const file = JSON.parse(readFileSync(join(dir, "vault", "Work", "Sketch.excalidraw"), "utf8"));
	expect(file.elements.map((e: { text: string }) => e.text)).toEqual(["Login flow"]);
});

test("agent edits see text typed moments ago", () => {
	const n = ops.create({ title: "Typing", body: "hello world" }, A);
	const client = new Y.Doc();
	Y.applyUpdate(client, Y.encodeStateAsUpdate(s.getDoc(n.id)));
	const sv = Y.encodeStateVector(client);
	client.transact(() => replaceBody(client, "hello world and more typing"));
	s.applyRemote(n.id, Y.encodeStateAsUpdate(client, sv), "web:test");
	ops.update(n.id, { old_text: "hello", new_text: "HELLO" }, A);
	expect(s.records.get(n.id)!.body).toBe("HELLO world and more typing");
	expect(() => ops.update(n.id, { old_text: "nope", new_text: "x" }, A)).toThrow(OpError);
});

test("delete asks what happens to children that hang only below; restore brings them back", () => {
	const p = ops.create({ title: "Website", type: "Projekt" }, A);
	ops.create({ title: "Navbar", type: "Task", parents: ["Website"] }, A);
	expect(() => ops.remove(p.id, undefined, A)).toThrow(/children/);
	expect(s.records.get(p.id)!.deleted).toBe(false);
	expect(ops.remove(p.id, "trash", A).only).toBe(1);
	expect(s.index().get(p.id)).toBeUndefined();
	expect(s.index().resolveTitle("Navbar")).toBeUndefined();
	expect(ops.restore("Website", A).back).toBe(1);
	expect(s.index().resolveTitle("Navbar")).toBeDefined();
});

test("types are never deleted or changed through the item tools; only update_type previews", () => {
	ops.create({ title: "Website", type: "Projekt", properties: { Status: "aktiv" } }, A);
	const seq = s.seq;
	for (const ref of [SYS.project, SYS.task, SYS.card]) {
		expect(() => ops.remove(ref, undefined, A)).toThrow(/update_type with delete_preview/);
		expect(() => ops.remove(ref, "trash", A)).toThrow(/is a type/);
		expect(() => ops.update(ref, { title: "Gone", type: null }, A)).toThrow(/update_type/);
		expect(() => ops.place(ref, { pin: true }, A)).toThrow(/update_type/);
		expect(() => ops.suggest(ref, { note: "x" }, A, A)).toThrow(/update_type/);
	}
	expect(s.seq).toBe(seq); // nothing written
	expect(s.index().types.size).toBe(3);
	expect(s.index().get(s.index().resolveTitle("Website")!)!.type).toBe(SYS.project);
	const preview = ops.deletePreview("Projekt");
	expect(preview.entries).toBe(1);
	expect(s.index().types.has(SYS.project)).toBe(true);
	// the shared trash refuses a type as well; the app deletes types through deleteType
	expect(() => deleteItem(storeWriter(s, A), s.index(), SYS.task)).toThrow(/type page/);
});

test("done date: set when the status enters done, kept between done options, cleared on reopen", () => {
	ops.create({ title: "Mapping", type: "Task" }, A);
	const get = () => s.records.get(s.index().resolveTitle("Mapping")!)!;
	expect(get().doneAt).toBeUndefined();
	ops.update("Mapping", { properties: { Status: "Erledigt" } }, A);
	const first = get().doneAt!;
	expect(first).toBeGreaterThan(Date.now() - 5000);
	ops.update("Mapping", { properties: { Status: "Verworfen" } }, A);
	expect(get().doneAt).toBe(first);
	ops.update("Mapping", { properties: { Status: "In Bearbeitung" } }, A);
	expect(get().doneAt).toBeUndefined();
	ops.setStatusGroup(["Mapping"], "done", A);
	expect(get().doneAt).toBeDefined();
	const q = (text: string) => ops.query(text).items.map((i) => i.title);
	expect(q("erledigt>-7d")).toEqual(["Mapping"]);
	expect(q("done>-7d")).toEqual(["Mapping"]);
	expect(q("erledigt<-7d")).toEqual([]);
});

test("an update with a status change dates the done date with the update", () => {
	const p = ops.create({ title: "Website", type: "Projekt" }, A);
	ops.addUpdate("Website", "Finished", "Erledigt", "test", A);
	const it = s.records.get(p.id)!;
	expect(it.doneAt).toBe(it.updates.at(-1)!.at);
});

test("tolerant input: plural type names, option synonyms and periods on create", () => {
	const p = ops.create(
		{
			title: "Website",
			type: "Projekte",
			properties: { Status: "in Arbeit", Priorität: "high", Zeitraum: "1.11.2026/30.11.2026" },
		},
		A,
	);
	const it = s.records.get(p.id)!;
	expect(it.type).toBe(SYS.project);
	expect(it.props).toMatchObject({
		p_status: "st_active",
		p_priority: "pr_high",
		p_period: "2026-11-01/2026-11-30",
	});
});

test.each([
	["fertig", "st_done"],
	["Paused", "st_paused"],
	["planning", "st_planning"],
	["cancelled", "st_canceled"],
	["offen", "st_backlog"],
	["In Progress", "st_active"],
])("tolerant input: status word %p is %p", (word, opt) => {
	const p = ops.create({ title: "Website", type: "Projekt" }, A);
	ops.update(p.id, { properties: { Status: word } }, A);
	expect(s.records.get(p.id)!.props.p_status).toBe(opt);
});

test.each([
	["10/30/2026", "2026-10-30"],
	["30.10.2026", "2026-10-30"],
	["2026-10-30T09:00", "2026-10-30T09:00"],
	["30.10.2026 9:30", "2026-10-30T09:30"],
	["morgen", addDaysISO(1)],
	["tomorrow", addDaysISO(1)],
	["heute", todayISO()],
	["+3d", addDaysISO(3)],
	["in 2 Wochen", addDaysISO(14)],
])("tolerant input: due date %p is %p", (raw, want) => {
	const t = ops.create({ title: "Review", type: "tasks" }, A);
	ops.update(t.id, { properties: { Fällig: raw } }, A);
	expect(s.records.get(t.id)!.props.p_due).toBe(want);
});

test("tolerant input: weekdays; unclear input is rejected; status groups by word, all or nothing", () => {
	const t = ops.create({ title: "Review", type: "Task" }, A);
	ops.update(t.id, { properties: { Fällig: "Freitag" } }, A);
	const fri = new Date(`${String(s.records.get(t.id)!.props.p_due)}T12:00:00`);
	expect(fri.getDay()).toBe(5);
	// unclear input is rejected with an explanation, nothing guessed
	expect(() => ops.update(t.id, { properties: { Status: "blockiert" } }, A)).toThrow(
		/not a status.*Waiting for/,
	);
	expect(() => ops.update(t.id, { properties: { Fällig: "31.02.2026" } }, A)).toThrow(
		/needs a date like/,
	);
	expect(() => ops.update(t.id, { properties: { Fällig: "soon" } }, A)).toThrow(
		/needs a date like/,
	);
	expect(ops.setStatusGroup(["Review"], "erledigt", A)[0]!.props.p_status).toBe("st_done");
	expect(ops.setStatusGroup(["Review"], "Verworfen", A)[0]!.props.p_status).toBe("st_dropped");
	// all or nothing: one unknown item, nothing changes
	expect(() => ops.setStatusGroup(["Review", "Does not exist"], "offen", A)).toThrow(
		/Does not exist/,
	);
	expect(s.records.get(t.id)!.props.p_status).toBe("st_dropped");
});

test("queries understand status synonyms and dates in other notations", () => {
	ops.create(
		{ title: "Running", type: "Task", properties: { Status: "In Bearbeitung", Fällig: "heute" } },
		A,
	);
	ops.create({ title: "New", type: "Task" }, A);
	const q = (text: string) =>
		ops
			.query(text)
			.items.map((i) => i.title)
			.sort();
	expect(q('typ:Tasks status:"in Arbeit"')).toEqual(["Running"]);
	expect(q("type:tasks status:in_progress")).toEqual(["Running"]);
	expect(q('typ:Task status:"nicht begonnen"')).toEqual(["New"]);
	expect(q(`fällig:${todayISO().split("-").reverse().join(".")}`)).toEqual(["Running"]);
	expect(q("fällig:heute")).toEqual(["Running"]);
	expect(q('status:"In Progress"')).toEqual(["Running"]);
});

test("the agent sees the inbox rule and a type's list name", () => {
	const sc = ops.schema();
	expect(sc.inbox.query).toContain("ohne:typ");
	ops.updateType("Karte", { plural: "Slips" }, A);
	expect(ops.schema().types.find((x) => x.name === "Karte")!.list).toBe("Slips");
});
