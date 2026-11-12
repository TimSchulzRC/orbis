import { afterAll, beforeEach, expect, test } from "bun:test";
import { initItem, setMeta, setTab, setTabs } from "@obtion/core/model";
import { SYS, typeTabs } from "@obtion/core/setup";
import type { Ops } from "@obtion/server/ops";
import type { Store } from "@obtion/server/store";
import { redoStep, UndoError, undoStep } from "@obtion/server/undo";
import * as Y from "yjs";
import { removeTempDirs } from "../support/helpers";
import { ok, setupStore, stepOf } from "../support/store";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
const AG = "agent:test";
// set up in German: type names, status and date words below are German
beforeEach(() => ({ s, ops } = setupStore("obtion-undo-")));
const byTitle = (t: string) =>
	s.records.get(
		s.index().resolveTitle(t) ?? [...s.records.values()].find((r) => r.title === t)?.id ?? "",
	)!;

test("one agent step with several changes is taken back as a whole, across items", () => {
	ops.call(
		AG,
		ok(() =>
			ops.create(
				{ title: "Nordlicht · France", type: "Projekt", properties: { Status: "Planung" } },
				AG,
			),
		),
	);
	ops.call(
		AG,
		ok(() => ops.create({ title: "Mapping", type: "Task", parents: ["Nordlicht · France"] }, AG)),
	);
	// "Nordlicht: mapping done, review on Friday" (the German workspace takes "erledigt" and "Freitag")
	const out = ops.call(AG, () => {
		ops.update("Mapping", { properties: { Status: "erledigt" } }, AG);
		ops.addUpdate("Nordlicht · France", "Mapping done, review on Friday", "In Bearbeitung", AG, AG);
		ops.create(
			{
				title: "Review",
				type: "Task",
				parents: ["Nordlicht · France"],
				properties: { Fällig: "Freitag" },
			},
			AG,
		);
		return "done";
	});
	const step = stepOf(out);
	expect(byTitle("Mapping").props.p_status).toBe("st_done");
	const r = undoStep(s, step, "web:tim@laptop");
	expect(s.stepState(r.step)).toMatchObject({ undoes: step }); // an undo …
	expect(s.stepState(r.step).redo).toBeUndefined(); // … not a redo
	expect(r.changed.length).toBe(2);
	expect(r.trashed).toEqual([byTitle("Review").id]);
	expect(byTitle("Mapping").props.p_status).toBe("st_todo");
	expect(byTitle("Mapping").doneAt).toBeUndefined();
	expect(byTitle("Nordlicht · France").props.p_status).toBe("st_planning");
	expect(byTitle("Nordlicht · France").updates).toEqual([]);
	expect(s.index().resolveTitle("Review")).toBeUndefined();
	expect(s.activeUndo(step)).toBe(r.step);
	expect(() => undoStep(s, step, "web:tim@laptop")).toThrow(UndoError);
	// redo: everything is back, and the activity calls it a redo
	const again = redoStep(s, step, "web:tim@laptop");
	expect(s.stepState(again.step)).toMatchObject({ undoes: r.step, redo: true });
	expect(byTitle("Mapping").props.p_status).toBe("st_done");
	expect(byTitle("Nordlicht · France").updates.length).toBe(1);
	expect(s.index().resolveTitle("Review")).toBeDefined();
	expect(s.activeUndo(step)).toBeUndefined();
});

test("fields changed again later keep their newer value", () => {
	ops.call(
		AG,
		ok(() => ops.create({ title: "Website", type: "Projekt" }, AG)),
	);
	const step = stepOf(
		ops.call(
			AG,
			ok(() =>
				ops.update(
					"Website",
					{ title: "Website new", properties: { Status: "aktiv" }, tags_add: ["web"] },
					AG,
				),
			),
		),
	);
	ops.call(
		"web:tim@phone",
		ok(() => ops.update("Website new", { title: "Website 2027" }, "web:tim@phone")),
	);
	const r = undoStep(s, step, AG);
	const w = byTitle("Website 2027");
	expect(w.title).toBe("Website 2027");
	expect(w.props.p_status).toBe("st_backlog");
	expect(w.tags).toEqual([]);
	expect(r.kept).toEqual([{ doc: w.id, field: "meta:title" }]);
});

test("a step pushed by a device (delete with cascade over two documents) can be undone", () => {
	ops.call(
		AG,
		ok(() => ops.create({ title: "Project", type: "Projekt", pin: true }, AG)),
	);
	ops.call(
		AG,
		ok(() => ops.create({ title: "Task", type: "Task", parents: ["Project"] }, AG)),
	);
	const p = byTitle("Project").id;
	const t = byTitle("Task").id;
	// the device: its own copy, one user action marks both
	const device = new Map<string, Y.Doc>();
	for (const id of [p, t]) {
		const d = new Y.Doc({ guid: id });
		Y.applyUpdate(d, Y.encodeStateAsUpdate(s.getDoc(id)));
		device.set(id, d);
	}
	const step = "sDEVICE1";
	for (const [id, mark] of [
		[p, true],
		[t, `via:${p}`],
	] as const) {
		const d = device.get(id)!;
		const sv = Y.encodeStateVector(d);
		d.transact(() => setMeta(d, { deleted: mark }));
		s.applyRemote(id, Y.encodeStateAsUpdate(d, sv), "web:tim@laptop", undefined, step);
	}
	s.flush();
	expect(s.index().get(p)).toBeUndefined();
	expect(s.index().get(t)).toBeUndefined();
	const ev = s.events({ limit: 5 }).filter((e) => e.step === step);
	expect(ev.length).toBe(2);
	undoStep(s, step, "web:tim@laptop");
	expect(s.index().get(p)).toBeDefined();
	expect(s.index().get(t)).toBeDefined();
	expect(s.events({ limit: 1 })[0]!.undoes).toBe(step);
});

test("undoing a creation sends the new item to the trash; text typed later stays there", () => {
	const step = stepOf(
		ops.call(
			AG,
			ok(() => ops.create({ title: "Idea" }, AG)),
		),
	);
	ops.call(
		"web:x",
		ok(() => ops.update("Idea", { body: "More text", body_mode: "append" }, "web:x")),
	);
	undoStep(s, step, "web:x");
	const it = [...s.records.values()].find((r) => r.title === "Idea")!;
	expect(it.deleted).toBe(true);
	expect(it.body).toBe("More text");
});

test("the undo tool takes back the agent's own last step", () => {
	ops.call(
		AG,
		ok(() => ops.create({ title: "One" }, AG)),
	);
	ops.call(
		AG,
		ok(() => ops.create({ title: "Two" }, AG)),
	);
	expect(ops.lastStep(AG, false)).toBeDefined();
	undoStep(s, ops.lastStep(AG, false), AG);
	expect(s.index().resolveTitle("Two")).toBeUndefined();
	expect(s.index().resolveTitle("One")).toBeDefined();
	// the next "last step" skips the undone one
	undoStep(s, ops.lastStep(AG, false), AG);
	expect(s.index().resolveTitle("One")).toBeUndefined();
	redoStep(s, ops.lastStep(AG, true), AG);
	expect(s.index().resolveTitle("One")).toBeDefined();
});

test("a device's raw update without a step is logged as before", () => {
	const d = new Y.Doc({ guid: "x" });
	d.transact(() => initItem(d, { title: "Old" }));
	s.applyRemote("x", Y.encodeStateAsUpdate(d), "web:old");
	s.flush();
	expect(s.events({ limit: 1 })[0]!.step).toBeUndefined();
});

test("a saved filter in a type's view shows in the activity and can be undone", () => {
	const before = typeTabs(s.records.get(SYS.card)!, "de");
	// what "Save" writes after trying a filter in the cards' view "Alle" (the defaults go along)
	const out = ops.call("web:tim@laptop", () => {
		s.change(SYS.card, "web:tim@laptop", (d) => {
			setTabs(d, before);
			setTab(d, before[0]!.id, { where: { under: { id: "demo-x" } } });
		});
		return "ok";
	});
	const step = stepOf(out);
	const ev = s.events({ limit: 5 }).find((e) => e.doc === SYS.card)!;
	expect(ev.changes.map((c) => c.field)).toEqual(["views"]);
	expect(ev.step).toBe(step);
	undoStep(s, step, "web:tim@laptop");
	expect(typeTabs(s.records.get(SYS.card)!, "de")).toEqual(before);
});

test("after old rows fold, recent steps still undo and older ones are too old", () => {
	ops.call(AG, () => {
		ops.create({ title: "Website", type: "Projekt" }, AG);
		return "ok";
	});
	const old = stepOf(
		ops.call(AG, () => {
			ops.update("Website", { properties: { Status: "aktiv" } }, AG);
			return "ok";
		}),
	);
	ops.call(AG, () => {
		ops.create({ title: "Shop", type: "Projekt" }, AG);
		return "ok";
	});
	const recent = stepOf(
		ops.call(AG, () => {
			ops.update("Website", { title: "Website 2027" }, AG);
			ops.update("Shop", { title: "Shop 2027" }, AG);
			return "ok";
		}),
	);
	const first = (
		s.db.query("SELECT MIN(seq) AS seq FROM updates WHERE step = ?").get(recent) as { seq: number }
	).seq;
	// the recent step's first row looks old too: the step must not be split
	s.db.query("UPDATE updates SET ts = 0 WHERE seq <= ?").run(first);
	s.compact();
	expect(() => undoStep(s, old, AG)).toThrow(UndoError);
	expect(s.db.query("SELECT 1 FROM steps WHERE id = ?").get(old)).toBeNull();
	expect(s.db.query("SELECT COUNT(*) AS n FROM updates WHERE step = ?").get(recent)).toEqual({
		n: 2,
	});
	undoStep(s, recent, AG);
	expect(byTitle("Website").props.p_status).toBe("st_active");
	expect(byTitle("Shop").title).toBe("Shop");
});
