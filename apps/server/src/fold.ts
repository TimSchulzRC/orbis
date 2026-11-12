// When a change joins the activity entry before it instead of making a new one.
//
// A person editing in the app sends a step per keystroke in the title and per burst of typing in
// the text. Logged one by one, a renamed note fills the history with "F → Fr", "Fr → Fri". So a
// person's edits of one document fold into one entry until they pause (FOLD_PAUSE_MS), or until
// the entry changed about a page of text (FOLD_MAX_TEXT): an entry keeps one version of the text,
// so writing a lot leaves versions to go back to, however fast it went, and polishing three
// sentences for an hour leaves one. An agent's tool call stays an entry of its own, so each can
// be undone by its step. An entry that covers several steps names none.
import type { Database } from "bun:sqlite";
import { parseOrigin } from "@obtion/core/origin";
import type { FieldChange } from "@obtion/core/protocol";

/** A pause this long ends an entry: the next change starts a new one. */
export const FOLD_PAUSE_MS = 15 * 60_000;
/** An entry that changed this many characters of the text is full: the next change starts a new one. */
export const FOLD_MAX_TEXT = 2000;

/**
 * How much of a text one edit changed, in characters: what lies between the start and the end the
 * two texts share, the longer side of it (typed, deleted or replaced).
 */
export function changeSize(a: string, b: string): number {
	if (a === b) return 0;
	const max = Math.min(a.length, b.length);
	let head = 0;
	while (head < max && a.charCodeAt(head) === b.charCodeAt(head)) head++;
	let tail = 0;
	while (
		tail < max - head &&
		a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)
	)
		tail++;
	return Math.max(a.length, b.length) - head - tail;
}

/** An activity entry as far as folding needs it. `grown`: the characters of text its edits changed, added up. */
export interface Foldable {
	kind: string;
	origin: string;
	step: string | null;
	grown: number;
	ts: number;
}

/** Whether a change (`next`, at `next.ts`) joins the entry `last` of the same document. */
export function folds(
	last: Foldable,
	next: { kind: string; origin: string; step: string | null; ts: number },
	isUndo: (step: string) => boolean,
): boolean {
	if (last.kind !== "updated" || next.kind !== "updated" || last.origin !== next.origin)
		return false;
	if (next.ts - last.ts >= FOLD_PAUSE_MS || last.grown >= FOLD_MAX_TEXT) return false;
	if (last.step === next.step) return true;
	// an undo shows as one ("undid a step"), and what it took back stays readable in the entry before
	if ((last.step && isUndo(last.step)) || (next.step && isUndo(next.step))) return false;
	// several origins: a flush that mixed authors
	return parseOrigin(last.origin).kind === "web" && !last.origin.includes(",");
}

/** Combine two change lists: keep the first "from" and the last "to" per field. */
export function mergeChanges(a: FieldChange[], b: FieldChange[]): FieldChange[] {
	const out = a.map((c) => ({ ...c }));
	for (const c of b) {
		if (c.field === "update") {
			out.push(c);
			continue;
		}
		const prev = out.find((x) => x.field === c.field);
		if (!prev) out.push({ ...c });
		else if (Array.isArray(c.to) || Array.isArray(c.from)) {
			const added = new Set([...((prev.to as string[]) ?? []), ...((c.to as string[]) ?? [])]);
			const removed = new Set([
				...((prev.from as string[]) ?? []),
				...((c.from as string[]) ?? []),
			]);
			for (const x of [...added]) {
				if (!removed.has(x)) continue;
				added.delete(x);
				removed.delete(x);
			}
			prev.to = [...added];
			prev.from = [...removed];
		} else prev.to = c.to;
	}
	// Drop fields that ended where they started. The body only has lengths here, and equal lengths can be another text.
	return out.filter(
		(c) => c.field === "update" || c.field === "schema" || c.field === "body" || moved(c),
	);
}

function moved(c: FieldChange): boolean {
	if (!Array.isArray(c.to)) return c.from !== c.to;
	return c.to.length > 0 || ((c.from as unknown[]) ?? []).length > 0;
}

/**
 * Folds the entries already stored the way new ones fold (a database from before entries folded
 * across steps). The first entry of a run stays and takes the changes and the time of the ones
 * after it; their text versions move to it, none is dropped. How much text an entry changed
 * comes from its versions. Returns the entries removed.
 */
export function foldStoredEvents(db: Database): number {
	type Row = Foldable & { id: number; doc: string; title: string | null; changes: string | null };
	const undos = new Set(
		(db.query("SELECT id FROM steps WHERE undoes IS NOT NULL").all() as { id: string }[]).map(
			(r) => r.id,
		),
	);
	const isUndo = (step: string) => undos.has(step);
	// each version against the one before it
	const grown = new Map<number, number>();
	const text = new TextDecoder();
	let before = { doc: "", body: "" };
	for (const v of db
		.query("SELECT doc, event, data FROM versions ORDER BY doc, id")
		.iterate() as Iterable<{ doc: string; event: number | null; data: Uint8Array }>) {
		const body = text.decode(Bun.inflateSync(v.data as Uint8Array<ArrayBuffer>));
		if (v.event !== null)
			grown.set(
				v.event,
				(grown.get(v.event) ?? 0) + changeSize(v.doc === before.doc ? before.body : "", body),
			);
		before = { doc: v.doc, body };
	}
	const rows = db
		.query("SELECT id, doc, title, kind, origin, step, ts, changes FROM events ORDER BY doc, id")
		.all() as Row[];
	for (const e of rows) e.grown = grown.get(e.id) ?? 0;
	const save = db.query(
		"UPDATE events SET ts = ?, title = ?, changes = ?, step = ?, grown = ? WHERE id = ?",
	);
	const moveVersions = db.query("UPDATE versions SET event = ? WHERE event = ?");
	const drop = db.query("DELETE FROM events WHERE id = ?");
	let removed = 0;
	let cur: Row | undefined;
	let folded = false;
	const done = () => {
		if (cur && (folded || cur.grown))
			save.run(cur.ts, cur.title, cur.changes, cur.step, cur.grown, cur.id);
	};
	for (const e of rows) {
		if (cur && cur.doc === e.doc && folds(cur, e, isUndo)) {
			cur.changes = JSON.stringify(
				mergeChanges(JSON.parse(cur.changes || "[]"), JSON.parse(e.changes || "[]")),
			);
			cur.ts = Math.max(cur.ts, e.ts);
			cur.title = e.title;
			if (cur.step !== e.step) cur.step = null;
			cur.grown += e.grown;
			folded = true;
			moveVersions.run(cur.id, e.id);
			drop.run(e.id);
			removed++;
			continue;
		}
		done();
		cur = e;
		folded = false;
	}
	done();
	return removed;
}
