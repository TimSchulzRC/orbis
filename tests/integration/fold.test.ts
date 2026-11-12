// A person's edits of one document fold into one activity entry until they pause: renaming a note
// key by key is one entry, not one per letter. Entries stored before that fold when the server starts.
import { afterAll, afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { replaceBody, setMeta, touch } from "@obtion/core/model";
import { agentOrigin, personOrigin } from "@obtion/core/origin";
import { changeSize, FOLD_MAX_TEXT, FOLD_PAUSE_MS } from "@obtion/server/fold";
import type { Ops } from "@obtion/server/ops";
import { Store } from "@obtion/server/store";
import { undoStep } from "@obtion/server/undo";
import { removeTempDirs } from "../support/helpers";
import { setupStore, tool as storeTool } from "../support/store";

afterAll(removeTempDirs);
afterEach(() => void setSystemTime());

let s: Store;
let ops: Ops;
let dir: string;
let now: number;
beforeEach(() => {
	({ s, ops, dir } = setupStore("obtion-fold-"));
	now = Date.now();
});

const AG = agentOrigin("claude-code", { id: "u1", name: "Tim" });
const TIM = personOrigin({ id: "u1", name: "Tim" }, "Mac");
const ANNA = personOrigin({ id: "u2", name: "Anna" }, "Phone");
const tool = (name: string, args: unknown) => storeTool(s, name, args);
const MIN = 60_000;

/** Time passes. */
function wait(ms: number) {
	now += ms;
	setSystemTime(new Date(now));
}
/** One keystroke in the title field: a step of its own, as the app sends it. Returns the step. */
function rename(origin: string, id: string, title: string): string {
	const step = s.step(
		origin,
		(step) => (s.change(id, origin, (d) => (setMeta(d, { title }), touch(d))), step),
	);
	s.flush();
	return step;
}
function write(origin: string, id: string, body: string): string {
	const step = s.step(
		origin,
		(step) => (s.change(id, origin, (d) => (replaceBody(d, body), touch(d))), step),
	);
	s.flush();
	return step;
}
const note = (title = "", body = "") => s.create({ title, body }, TIM);
const entries = (id: string) => s.events({ doc: id, limit: 100 }).reverse();
const titles = (id: string) =>
	entries(id).map((e) =>
		e.changes
			.filter((c) => c.field === "title")
			.map((c) => `${c.from}→${c.to}`)
			.join(),
	);

test("renaming a note key by key is one entry, from the first title to the last", () => {
	const id = note();
	for (const title of ["F", "Fr", "Fri", "Fritz", "Fritzme", "Fritzmeier"]) {
		rename(TIM, id, title);
		wait(400);
	}
	const all = entries(id);
	expect(all.length).toBe(1);
	expect(all[0]!.changes).toEqual([{ field: "title", from: "", to: "Fritzmeier" }]);
	expect(all[0]!.title).toBe("Fritzmeier");
	// it covers six steps: it names none, so nobody undoes a sixth of it
	expect(all[0]!.step).toBeUndefined();
});

test("a pause ends the entry, however long the sitting", () => {
	const id = note("Start");
	rename(TIM, id, "A");
	wait(FOLD_PAUSE_MS - 1000);
	rename(TIM, id, "B");
	expect(titles(id)).toEqual(["", "Start→B"]);
	wait(FOLD_PAUSE_MS);
	rename(TIM, id, "C");
	expect(titles(id)).toEqual(["", "Start→B", "B→C"]);
	// three hours of small edits, never pausing: still that entry
	for (let n = 0; n < 18; n++) {
		wait(10 * MIN);
		rename(TIM, id, `D${n}`);
	}
	expect(titles(id)).toEqual(["", "Start→B", "B→D17"]);
	// the entry's time is its last change
	expect(entries(id).at(-1)!.ts).toBe(now);
});

test("how much of a text an edit changed", () => {
	expect(changeSize("abc", "abc")).toBe(0);
	expect(changeSize("Hello world", "Hello big world")).toBe(4); // typed
	expect(changeSize("Hello big world", "Hello world")).toBe(4); // deleted
	expect(changeSize("Hello world", "Hello there")).toBe(5); // replaced
	expect(changeSize("", "abc")).toBe(3);
	expect(changeSize("aaa", "aa")).toBe(1);
});

test("an entry that changed about a page of text is full: writing a lot leaves several, with a version each", () => {
	const id = note("Essay", "Intro\n");
	wait(FOLD_PAUSE_MS);
	const para = "A sentence of the essay that goes on for a while. ".repeat(10); // 500 characters
	let text = "Intro\n";
	// twelve paragraphs, one every half minute: 6000 characters without a pause
	for (let n = 0; n < 12; n++) {
		wait(MIN / 2);
		write(TIM, id, (text += para));
	}
	const mine = entries(id).slice(1);
	expect(mine.map((e) => e.changes.map((c) => `${c.from}→${c.to}`).join())).toEqual([
		"6→2006",
		"2006→4006",
		"4006→6006",
	]);
	expect(s.versions(id).map((v) => v.len)).toEqual([6, 2006, 4006, 6006]);
	expect(s.eventText(mine[1]!.id)).toMatchObject({ from: 2, to: 3 });
	// polishing: many small edits add up slowly and stay in the entry
	wait(MIN);
	write(TIM, id, (text += "The end.\n"));
	for (let n = 0; n < 30; n++) {
		wait(MIN);
		write(TIM, id, text.replace("Intro", `Intro ${n}`));
	}
	expect(entries(id).length).toBe(5);
	// a big block pasted or deleted at once fills an entry: what comes next is a new one
	wait(MIN);
	const id2 = note("Paste", "x\n");
	wait(FOLD_PAUSE_MS);
	write(TIM, id2, `x\n${"y".repeat(FOLD_MAX_TEXT)}`);
	wait(MIN);
	write(TIM, id2, "x\n");
	wait(MIN);
	write(TIM, id2, "x\nz\n");
	expect(
		entries(id2)
			.slice(1)
			.map((e) => e.changes.map((c) => `${c.from}→${c.to}`).join()),
	).toEqual([`2→${FOLD_MAX_TEXT + 2}`, `${FOLD_MAX_TEXT + 2}→2`, "2→4"]);
});

test("different kinds of edits in one sitting are one entry", async () => {
	await tool("create", {
		items: [{ title: "Website", type: "Projekt", properties: { Status: "Planung" } }],
	});
	const id = s.index().resolveTitle("Website")!;
	wait(FOLD_PAUSE_MS);
	rename(TIM, id, "Website 2");
	wait(MIN);
	write(TIM, id, "Plan\n");
	wait(MIN);
	s.step(TIM, () => s.change(id, TIM, (d) => setMeta(d, { pinned: "a" })));
	s.flush();
	const mine = entries(id).filter((e) => e.origin === TIM);
	expect(mine.length).toBe(1);
	expect(mine[0]!.changes.map((c) => c.field).sort()).toEqual(["body", "pinned", "title"]);
});

test("agents, other people and undos keep entries of their own", () => {
	const id = note("Plan", "one\n");
	rename(TIM, id, "Plan A");
	ops.call(AG, () => (ops.update("Plan A", { title: "Plan B" }, AG), "ok"));
	ops.call(AG, () => (ops.update("Plan B", { title: "Plan C" }, AG), "ok"));
	rename(ANNA, id, "Plan D");
	rename(TIM, id, "Plan E");
	const last = rename(TIM, id, "Plan F");
	expect(titles(id)).toEqual([
		"",
		"Plan→Plan A",
		"Plan A→Plan B",
		"Plan B→Plan C",
		"Plan C→Plan D",
		"Plan D→Plan F",
	]);
	// every agent call keeps its step, so each can be undone
	expect(
		entries(id)
			.filter((e) => e.origin === AG)
			.every((e) => e.step),
	).toBe(true);
	// an undo is an entry of its own, and the edit after it does not join it
	undoStep(s, last, TIM);
	rename(TIM, id, "Plan G");
	expect(titles(id).slice(5)).toEqual(["Plan D→Plan F", "Plan F→Plan E", "Plan E→Plan G"]);
	expect(entries(id).at(-2)!.undoes).toBe(last);
});

test("typed and taken back: an entry with nothing left is not shown, and shows again when it grows", () => {
	const id = note("Fritz");
	wait(FOLD_PAUSE_MS);
	rename(TIM, id, "Fritzm");
	expect(titles(id)).toEqual(["", "Fritz→Fritzm"]);
	const seen: number[] = [];
	s.on({ event: (e) => seen.push(e.changes.length) });
	rename(TIM, id, "Fritz");
	expect(titles(id)).toEqual([""]);
	// devices showing the entry hear that it is empty now
	expect(seen).toEqual([0]);
	rename(TIM, id, "Fritzmeier");
	expect(titles(id)).toEqual(["", "Fritz→Fritzmeier"]);
});

test("writing a text in several steps keeps one version, and the entry shows all of it", () => {
	const id = note("Letter", "Dear Anna\n");
	wait(FOLD_PAUSE_MS);
	write(TIM, id, "Dear Anna\nI ");
	wait(3 * MIN);
	write(TIM, id, "Dear Anna\nI am late.\n");
	wait(3 * MIN);
	write(TIM, id, "Dear Anna\nI am late.\nTim\n");
	expect(s.versions(id).map((v) => s.versionText(v.id))).toEqual([
		"Dear Anna\n",
		"Dear Anna\nI am late.\nTim\n",
	]);
	expect(s.versions(id)[1]!.step).toBeUndefined();
	const [ev] = entries(id).slice(-1);
	expect(s.eventText(ev!.id)).toMatchObject({
		before: "Dear Anna\n",
		after: "Dear Anna\nI am late.\nTim\n",
	});
	// after a pause: the next version
	wait(FOLD_PAUSE_MS);
	write(TIM, id, "Dear Anna\nI am late.\nYours, Tim\n");
	expect(s.versions(id).length).toBe(3);
	expect(s.eventText(entries(id).at(-1)!.id)).toMatchObject({
		before: "Dear Anna\nI am late.\nTim\n",
		from: 2,
		to: 3,
	});
});

test("entries stored one per keystroke fold when the server starts; no text version is lost", () => {
	const id = note();
	const other = note("Other");
	s.db.close();
	// the database as the version before wrote it: an entry per step, no start
	const old = new Store(dir).db;
	old.exec(
		"DELETE FROM events; DELETE FROM versions; ALTER TABLE events DROP COLUMN grown; PRAGMA user_version = 1;",
	);
	const t0 = Date.UTC(2026, 10, 12, 15, 0);
	const add = old.query(
		"INSERT INTO events (ts, doc, title, type, kind, origin, changes, step, area) VALUES (?, ?, ?, '', 'updated', ?, ?, ?, 'personal') RETURNING id",
	);
	const row = (at: number, doc: string, origin: string, changes: unknown[], step: string) =>
		(add.get(t0 + at, doc, "x", origin, JSON.stringify(changes), step) as { id: number }).id;
	const title = (from: string, to: string) => ({ field: "title", from, to });
	const first = row(0, id, TIM, [title("", "F")], "s1");
	row(1000, id, TIM, [title("F", "Fr")], "s2");
	row(1500, other, TIM, [title("Other", "Others")], "s2b"); // another document in between
	row(2000, id, TIM, [title("Fr", "Fritz")], "s3");
	const body1 = row(3000, id, TIM, [{ field: "body", from: 0, to: 2 }], "s4");
	const body2 = row(9000, id, TIM, [{ field: "body", from: 2, to: 5 }], "s5");
	const agent = row(10_000, id, AG, [title("Fritz", "Fritzi")], "s6");
	const agent2 = row(11_000, id, AG, [title("Fritzi", "Fritzchen")], "s7");
	const undone = row(12_000, id, TIM, [title("Fritzchen", "Franz")], "s8");
	old.exec("INSERT INTO steps (id, actor, ts, undoes) VALUES ('s9', 'x', 0, 's8')");
	const undo = row(13_000, id, TIM, [title("Franz", "Fritzchen")], "s9");
	const later = row(13_000 + FOLD_PAUSE_MS, id, TIM, [title("Fritzchen", "Fritzmeier")], "s10");
	row(14_000 + FOLD_PAUSE_MS, id, TIM, [title("Fritzmeier", "Fritzmeier!")], "s11");
	const pack = (text: string) => Bun.deflateSync(new TextEncoder().encode(text));
	const version = old.query(
		"INSERT INTO versions (doc, ts, origin, step, event, len, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	version.run(id, t0 + 3000, TIM, "s4", body1, 2, pack("Hi"));
	version.run(id, t0 + 9000, TIM, "s5", body2, 5, pack("Hi yo"));
	// the other note: three paragraphs typed without a pause, each its own entry and version
	const page = "p".repeat(FOLD_MAX_TEXT);
	const typed = [1, 2, 3].map((n) => {
		const ev = row(
			20_000 + n * 1000,
			other,
			TIM,
			[{ field: "body", from: (n - 1) * FOLD_MAX_TEXT, to: n * FOLD_MAX_TEXT }],
			`t${n}`,
		);
		version.run(
			other,
			t0 + 20_000 + n * 1000,
			TIM,
			`t${n}`,
			ev,
			n * FOLD_MAX_TEXT,
			pack(page.repeat(n)),
		);
		return ev;
	});
	old.close();

	s = new Store(dir);
	const all = entries(id);
	expect(
		all.map((e) => [
			e.id,
			e.origin === TIM ? "Tim" : "agent",
			e.step,
			e.changes.map((c) => `${c.field}:${c.from}→${c.to}`).join(),
		]),
	).toEqual([
		[first, "Tim", undefined, "title:→Fritz,body:0→5"],
		[agent, "agent", "s6", "title:Fritz→Fritzi"],
		[agent2, "agent", "s7", "title:Fritzi→Fritzchen"],
		[undone, "Tim", "s8", "title:Fritzchen→Franz"],
		[undo, "Tim", "s9", "title:Franz→Fritzchen"],
		[later, "Tim", undefined, "title:Fritzchen→Fritzmeier!"],
	]);
	expect(all[0]!.ts).toBe(t0 + 9000);
	// a page of text fills an entry here too: the rename joins the first page, the other pages stay
	expect(entries(other).map((e) => [e.id, e.changes.map((c) => c.field).join()])).toEqual([
		[entries(other)[0]!.id, "title,body"],
		[typed[1]!, "body"],
		[typed[2]!, "body"],
	]);
	expect(s.versions(other).length).toBe(3);
	// both versions are still there, and the entry shows the text from before it to its last
	expect(s.versions(id).map((v) => s.versionText(v.id))).toEqual(["Hi", "Hi yo"]);
	expect(s.eventText(first)).toEqual({
		doc: id,
		before: "",
		after: "Hi yo",
		from: undefined,
		to: 2,
	});
	// the next edit joins the last entry as if the server had always folded
	setSystemTime(new Date(t0 + 15_000 + FOLD_PAUSE_MS));
	rename(TIM, id, "Fritzmeier?");
	expect(entries(id).at(-1)).toMatchObject({
		id: later,
		changes: [title("Fritzchen", "Fritzmeier?")],
	});
	// started again: nothing more to do
	s.db.close();
	s = new Store(dir);
	expect(entries(id).length).toBe(6);
});
