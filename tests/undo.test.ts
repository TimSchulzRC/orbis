import { test, expect, beforeEach, afterAll } from "bun:test";
import { tempDir, removeTempDirs } from "./helpers";
import * as Y from "yjs";
import { Store } from "@obtion/hub/store";
import { Ops } from "@obtion/hub/ops";
import { undoStep, redoStep, UndoError } from "@obtion/hub/undo";
import { runSetup, typeTabs, SYS } from "@obtion/core/setup";
import { storeWriter } from "@obtion/hub/importers";
import { initItem, setMeta, setTab, setTabs } from "@obtion/core/model";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
const AG = "agent:test";
beforeEach(() => {
  s = new Store(tempDir("obtion-undo-"));
  runSetup(storeWriter(s, "system:setup"), "de");
  s.flush();
  ops = new Ops(s);
});
const byTitle = (t: string) => s.records.get(s.index().resolveTitle(t) ?? [...s.records.values()].find((r) => r.title === t)?.id ?? "")!;
const stepOf = (out: string) => /\(step (s\w+)/.exec(out)![1]!;

test("one agent step with several changes is taken back as a whole, across items", () => {
  ops.call(AG, () => (ops.create({ title: "Nordlicht · Frankreich", type: "Projekt", properties: { Status: "Planung" } }, AG), "ok"));
  ops.call(AG, () => (ops.create({ title: "Mapping", type: "Task", parents: ["Nordlicht · Frankreich"] }, AG), "ok"));
  // "Nordlicht: Mapping fertig, Review am Freitag"
  const out = ops.call(AG, () => {
    ops.update("Mapping", { properties: { Status: "erledigt" } }, AG);
    ops.addUpdate("Nordlicht · Frankreich", "Mapping fertig, Review am Freitag", "In Bearbeitung", AG, AG);
    ops.create({ title: "Review", type: "Task", parents: ["Nordlicht · Frankreich"], properties: { Fällig: "Freitag" } }, AG);
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
  expect(byTitle("Nordlicht · Frankreich").props.p_status).toBe("st_planning");
  expect(byTitle("Nordlicht · Frankreich").updates).toEqual([]);
  expect(s.index().resolveTitle("Review")).toBeUndefined();
  expect(s.stepState(step).undone).toBe(true);
  expect(() => undoStep(s, step, "web:tim@laptop")).toThrow(UndoError);
  // Wiederholen: everything is back, and the activity calls it a redo ("hat wiederholt")
  const again = redoStep(s, step, "web:tim@laptop");
  expect(s.stepState(again.step)).toMatchObject({ undoes: r.step, redo: true });
  expect(byTitle("Mapping").props.p_status).toBe("st_done");
  expect(byTitle("Nordlicht · Frankreich").updates.length).toBe(1);
  expect(s.index().resolveTitle("Review")).toBeDefined();
  expect(s.stepState(step).undone).toBe(false);
});

test("fields changed again later keep their newer value", () => {
  ops.call(AG, () => (ops.create({ title: "Website", type: "Projekt" }, AG), "ok"));
  const step = stepOf(ops.call(AG, () => (ops.update("Website", { title: "Website neu", properties: { Status: "aktiv" }, tags_add: ["web"] }, AG), "ok")));
  ops.call("web:tim@phone", () => (ops.update("Website neu", { title: "Website 2027" }, "web:tim@phone"), "ok"));
  const r = undoStep(s, step, AG);
  const w = byTitle("Website 2027");
  expect(w.title).toBe("Website 2027");
  expect(w.props.p_status).toBe("st_backlog");
  expect(w.tags).toEqual([]);
  expect(r.kept).toEqual([{ doc: w.id, field: "meta:title" }]);
});

test("a step pushed by a device (delete with cascade over two documents) can be undone", () => {
  ops.call(AG, () => (ops.create({ title: "Projekt", type: "Projekt", pin: true }, AG), "ok"));
  ops.call(AG, () => (ops.create({ title: "Task", type: "Task", parents: ["Projekt"] }, AG), "ok"));
  const p = byTitle("Projekt").id;
  const t = byTitle("Task").id;
  // the device: its own copy, one user action marks both
  const device = new Map<string, Y.Doc>();
  for (const id of [p, t]) {
    const d = new Y.Doc({ guid: id });
    Y.applyUpdate(d, Y.encodeStateAsUpdate(s.getDoc(id)));
    device.set(id, d);
  }
  const step = "sDEVICE1";
  for (const [id, mark] of [[p, true], [t, "via:" + p]] as const) {
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
  expect(s.events({ limit: 10 }).find((e) => e.step === step)!.undone).toBe(true);
  expect(s.events({ limit: 1 })[0]!.undoes).toBe(step);
});

test("undoing a creation sends the new item to the trash; text typed later stays there", () => {
  const step = stepOf(ops.call(AG, () => (ops.create({ title: "Idee" }, AG), "ok")));
  ops.call("web:x", () => (ops.update("Idee", { body: "Mehr Text" }, "web:x"), "ok"));
  undoStep(s, step, "web:x");
  const it = [...s.records.values()].find((r) => r.title === "Idee")!;
  expect(it.deleted).toBe(true);
  expect(it.body).toBe("Mehr Text");
});

test("the undo tool takes back the agent's own last step", async () => {
  ops.call(AG, () => (ops.create({ title: "Eins" }, AG), "ok"));
  ops.call(AG, () => (ops.create({ title: "Zwei" }, AG), "ok"));
  expect(ops.lastStep(AG, false)).toBeDefined();
  undoStep(s, ops.lastStep(AG, false), AG);
  expect(s.index().resolveTitle("Zwei")).toBeUndefined();
  expect(s.index().resolveTitle("Eins")).toBeDefined();
  // the next "last step" skips the undone one
  undoStep(s, ops.lastStep(AG, false), AG);
  expect(s.index().resolveTitle("Eins")).toBeUndefined();
  redoStep(s, ops.lastStep(AG, true), AG);
  expect(s.index().resolveTitle("Eins")).toBeDefined();
});

test("a device's raw update without a step is logged as before", () => {
  const d = new Y.Doc({ guid: "x" });
  d.transact(() => initItem(d, { title: "Alt" }));
  s.applyRemote("x", Y.encodeStateAsUpdate(d), "web:old");
  s.flush();
  expect(s.events({ limit: 1 })[0]!.step).toBeUndefined();
});

test("a saved filter in a type's view shows in the activity, can be undone, and the default views come back", () => {
  const before = typeTabs(s.records.get(SYS.card)!, "de");
  // what "Speichern" writes after trying a filter in the view "Alle" of "Karten" (the defaults go along)
  const out = ops.call("web:tim@laptop", () => {
    s.change(SYS.card, "web:tim@laptop", (d) => (setTabs(d, before), setTab(d, before[0]!.id, { where: { under: { id: "demo-x" } } })));
    return "ok";
  });
  const step = stepOf(out);
  const ev = s.events({ limit: 5 }).find((e) => e.doc === SYS.card)!;
  expect(ev.changes.map((c) => c.field)).toEqual(["views"]);
  expect(ev.step).toBe(step);
  undoStep(s, step, "web:tim@laptop");
  expect(typeTabs(s.records.get(SYS.card)!, "de")).toEqual(before);
  // "Ansichten zurücksetzen": the stored views go, the defaults show again
  s.change(SYS.card, "web:tim@laptop", (d) => setTab(d, "v_x", { kind: "board", pos: "W" }));
  s.flush();
  expect(s.records.get(SYS.card)!.schema!.views!.map((t) => t.kind)).toEqual(["board"]);
  s.change(SYS.card, "web:tim@laptop", (d) => setTabs(d, []));
  s.flush();
  expect(s.records.get(SYS.card)!.schema!.views).toBeUndefined();
  expect(typeTabs(s.records.get(SYS.card)!, "de").map((t) => t.kind)).toEqual(["table"]);
});
