import { expect, test } from "bun:test";
import {
	addDrawing,
	drawingFence,
	drawingMaps,
	excalidrawFile,
	findDrawings,
	readElements,
	readScene,
	replaceDrawings,
	type SceneElement,
	setDrawingFile,
	setDrawingState,
	writeElements,
} from "@obtion/core/drawing";
import { parseWikiLinks } from "@obtion/core/model";
import { createIndex, indexRecord, plainText, searchIds } from "@obtion/core/search";
import { fork, MemRepo, sync } from "../support/helpers";

/** The drawing's id in its note. */
const D = "d1";

const el = (id: string, more: Partial<SceneElement> = {}): SceneElement => ({
	id,
	type: "rectangle",
	version: 1,
	versionNonce: 10,
	index: "a0",
	x: 0,
	y: 0,
	...more,
});
const text = (id: string, t: string, index: string): SceneElement =>
	el(id, { type: "text", text: t, originalText: t, index });

test("a drawing stores its elements, files and canvas, and reads them back in drawing order", () => {
	const m = new MemRepo();
	const id = m.add({ title: "Architektur" });
	m.change(id, (d) => {
		writeElements(d, D, [
			text("t2", "Datenbank", "a2"),
			el("r1", { index: "a1" }),
			text("t1", "Server", "a0"),
		]);
		setDrawingFile(d, D, "img", { hash: "abc", mimeType: "image/png", created: 1 });
		setDrawingState(d, D, {
			viewBackgroundColor: "#fafafa",
			zoom: { value: 2 },
			gridModeEnabled: true,
		});
	});
	const scene = readScene(m.doc(id), D);
	expect(scene.elements.map((e) => e.id)).toEqual(["t1", "r1", "t2"]);
	expect(scene.files.img?.hash).toBe("abc");
	// only the canvas settings, not the device's view (zoom, scroll)
	expect(scene.state).toEqual({ viewBackgroundColor: "#fafafa", gridModeEnabled: true });
	const item = m.get(id)!;
	expect(item.kind).toBe("note");
	expect(item.drawings?.[D]).toMatchObject({
		text: "Server\nDatenbank",
		files: ["abc"],
		count: 3,
	});
	expect(JSON.parse(excalidrawFile(scene))).toMatchObject({
		type: "excalidraw",
		elements: [{ id: "t1" }, { id: "r1" }, { id: "t2" }],
		appState: { viewBackgroundColor: "#fafafa" },
	});
});

test("only newer versions of an element are written", () => {
	const m = new MemRepo();
	const id = m.add({ title: "Skizze" });
	m.change(id, (d) => writeElements(d, D, [el("a", { version: 3, versionNonce: 5, x: 30 })]));
	let n = 0;
	m.change(id, (d) => (n = writeElements(d, D, [el("a", { version: 2, x: 20 })])));
	expect(n).toBe(0);
	m.change(id, (d) => (n = writeElements(d, D, [el("a", { version: 3, versionNonce: 5, x: 30 })])));
	expect(n).toBe(0);
	// same version: the lower nonce wins, as in Excalidraw
	m.change(id, (d) => (n = writeElements(d, D, [el("a", { version: 3, versionNonce: 1, x: 31 })])));
	expect(n).toBe(1);
	expect(readElements(m.doc(id), D)[0]!.x).toBe(31);
});

test("edits from two devices merge per element", () => {
	const a = new MemRepo();
	const id = a.add({ title: "Board" });
	a.change(id, (d) => writeElements(d, D, [el("x"), el("y", { index: "a1" })]));
	const b = fork(a);
	a.change(id, (d) => writeElements(d, D, [el("x", { version: 2, x: 100 })]));
	b.change(id, (d) =>
		writeElements(d, D, [el("y", { index: "a1", version: 2, x: 200 }), el("z", { index: "a2" })]),
	);
	sync(a, b);
	for (const r of [a, b]) {
		const els = readElements(r.doc(id), D);
		expect(els.map((e) => [e.id, e.x])).toEqual([
			["x", 100],
			["y", 200],
			["z", 0],
		]);
	}
	// a deleted element stays as deleted, so a device that has not seen the deletion cannot bring it back
	a.change(id, (d) => writeElements(d, D, [el("z", { index: "a2", version: 2, isDeleted: true })]));
	b.change(id, (d) => writeElements(d, D, [el("z", { index: "a2" })]));
	sync(a, b);
	expect(b.get(id)!.drawings![D]!.count).toBe(2);
});

test("two devices changing one element at once: the newer version wins on both, whatever Yjs picks", () => {
	for (let run = 0; run < 12; run++) {
		const a = new MemRepo();
		const id = a.add({ title: "Board" });
		a.change(id, (d) => writeElements(d, D, [el("x", { version: 1 })]));
		const b = fork(a);
		a.change(id, (d) => writeElements(d, D, [el("x", { version: 5, x: 50 })]));
		b.change(id, (d) => writeElements(d, D, [el("x", { version: 2, x: 20 })]));
		sync(a, b);
		for (const r of [a, b])
			expect(readElements(r.doc(id), D).map((e) => [e.version, e.x])).toEqual([[5, 50]]);
		// a deletion is a newer version too: an older edit from elsewhere does not bring the element back
		a.change(id, (d) => writeElements(d, D, [el("x", { version: 6, isDeleted: true })]));
		b.change(id, (d) => writeElements(d, D, [el("x", { version: 3, x: 30 })]));
		sync(a, b);
		for (const r of [a, b]) expect(r.get(id)!.drawings![D]!.count).toBe(0);
		// a write drops the copies it outdates
		b.change(id, (d) => writeElements(d, D, [el("x", { version: 7 })]));
		expect(drawingMaps(b.doc(id), D)!.elements.size).toBe(1);
	}
});

test("a drawing is a block of its note: no entry of its own, no link, found by its text", () => {
	const m = new MemRepo();
	const note = m.add({ title: "Architektur", pinned: "V" });
	const other = m.add({ title: "Server" });
	m.change(note, (d) => {
		addDrawing(d, D);
		writeElements(d, D, [text("t", "Approval by client", "a0")]);
		d.getText("body").insert(0, `Overview of [[Server]]\n${drawingFence(D)}\nMore\n`);
	});
	const ix = m.index();
	// one entry, the note; the drawing lives in its document
	expect(ix.live.map((i) => i.id).sort()).toEqual([note, other].sort());
	expect(findDrawings(ix.get(note)!.body).map((b) => b.id)).toEqual([D]);
	// the drawing is no link: the note links only to what its text names
	expect(parseWikiLinks(ix.get(note)!.body).map((l) => l.target)).toEqual(["Server"]);
	expect(ix.backlinks(other).map((b) => b.from)).toEqual([note]);
	// the note is found by what its drawing says, not by the drawing's id
	const search = createIndex();
	for (const i of ix.live) indexRecord(search, i);
	expect(searchIds(search, "approval", 5)).toEqual([note]);
	expect(searchIds(search, D, 5)).toEqual([]);
	expect(plainText(ix.get(note)!.body)).not.toContain(D);
});

test("a drawing whose block left the text stays in the note, so undo brings it back whole", () => {
	const m = new MemRepo();
	const note = m.add({ title: "Skizze" });
	m.change(note, (d) => {
		addDrawing(d, D);
		writeElements(d, D, [text("t", "Approval", "a0")]);
		d.getText("body").insert(0, drawingFence(D));
	});
	const before = createIndex();
	indexRecord(before, m.get(note)!);
	expect(searchIds(before, "approval", 5)).toEqual([note]);
	m.change(note, (d) => d.getText("body").delete(0, d.getText("body").length));
	expect(readElements(m.doc(note), D).map((e) => e.id)).toEqual(["t"]);
	// not searched while it is not in the text
	const search = createIndex();
	indexRecord(search, m.get(note)!);
	expect(searchIds(search, "approval", 5)).toEqual([]);
});

test("the drawing fence: only ```excalidraw with an id on the next line", () => {
	expect(drawingFence("abc")).toBe("```excalidraw\nabc\n```");
	const body = `a\n${drawingFence("x1")}\nb\n\`\`\`js\nx2\n\`\`\`\n${drawingFence("x3")}`;
	expect(findDrawings(body).map((b) => b.id)).toEqual(["x1", "x3"]);
	expect(replaceDrawings(body, (b) => `[${b.id}]`)).toBe("a\n[x1]\nb\n```js\nx2\n```\n[x3]");
});
