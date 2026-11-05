import { test, expect } from "bun:test";
import { MemRepo, fork, sync } from "../support/helpers";
import { type SceneElement, drawingInfo, excalidrawFile, readElements, readScene, setDrawingFile, setDrawingState, writeElements } from "@obtion/core/drawing";
import { isContent } from "@obtion/core/model";
import { belowOf, canPlaceIn, isInInbox, sidebarChildren, sidebarRoots } from "@obtion/core/placement";
import { parseQuery, runQuery } from "@obtion/core/query";
import { createIndex, indexRecord, searchIds } from "@obtion/core/search";

const el = (id: string, more: Partial<SceneElement> = {}): SceneElement => ({ id, type: "rectangle", version: 1, versionNonce: 10, index: "a0", x: 0, y: 0, ...more });
const text = (id: string, t: string, index: string): SceneElement => el(id, { type: "text", text: t, originalText: t, index });

test("a drawing stores its elements, files and canvas, and reads them back in drawing order", () => {
  const m = new MemRepo();
  const id = m.add({ kind: "zeichnung", title: "Architektur" });
  m.change(id, (d) => {
    writeElements(d, [text("t2", "Datenbank", "a2"), el("r1", { index: "a1" }), text("t1", "Server", "a0")]);
    setDrawingFile(d, "img", { hash: "abc", mimeType: "image/png", created: 1 });
    setDrawingState(d, { viewBackgroundColor: "#fafafa", zoom: { value: 2 }, gridModeEnabled: true });
  });
  const scene = readScene(m.doc(id));
  expect(scene.elements.map((e) => e.id)).toEqual(["t1", "r1", "t2"]);
  expect(scene.files.img?.hash).toBe("abc");
  // only the canvas settings, not the device's view (zoom, scroll)
  expect(scene.state).toEqual({ viewBackgroundColor: "#fafafa", gridModeEnabled: true });
  const item = m.get(id)!;
  expect(item.kind).toBe("zeichnung");
  expect(item.drawing).toEqual({ text: "Server\nDatenbank", files: ["abc"], count: 3 });
  expect(JSON.parse(excalidrawFile(scene))).toMatchObject({ type: "excalidraw", elements: [{ id: "t1" }, { id: "r1" }, { id: "t2" }], appState: { viewBackgroundColor: "#fafafa" } });
});

test("only newer versions of an element are written", () => {
  const m = new MemRepo();
  const id = m.add({ kind: "zeichnung", title: "Skizze" });
  m.change(id, (d) => writeElements(d, [el("a", { version: 3, versionNonce: 5, x: 30 })]));
  let n = 0;
  m.change(id, (d) => (n = writeElements(d, [el("a", { version: 2, x: 20 })])));
  expect(n).toBe(0);
  m.change(id, (d) => (n = writeElements(d, [el("a", { version: 3, versionNonce: 5, x: 30 })])));
  expect(n).toBe(0);
  // same version: the lower nonce wins, as in Excalidraw
  m.change(id, (d) => (n = writeElements(d, [el("a", { version: 3, versionNonce: 1, x: 31 })])));
  expect(n).toBe(1);
  expect(readElements(m.doc(id))[0]!.x).toBe(31);
});

test("edits from two devices merge per element", () => {
  const a = new MemRepo();
  const id = a.add({ kind: "zeichnung", title: "Board" });
  a.change(id, (d) => writeElements(d, [el("x"), el("y", { index: "a1" })]));
  const b = fork(a);
  a.change(id, (d) => writeElements(d, [el("x", { version: 2, x: 100 })]));
  b.change(id, (d) => writeElements(d, [el("y", { index: "a1", version: 2, x: 200 }), el("z", { index: "a2" })]));
  sync(a, b);
  for (const r of [a, b]) {
    const els = readElements(r.doc(id));
    expect(els.map((e) => [e.id, e.x])).toEqual([["x", 100], ["y", 200], ["z", 0]]);
  }
  // a deleted element stays as deleted, so a device that has not seen the deletion cannot bring it back
  a.change(id, (d) => writeElements(d, [el("z", { index: "a2", version: 2, isDeleted: true })]));
  b.change(id, (d) => writeElements(d, [el("z", { index: "a2" })]));
  sync(a, b);
  expect(b.get(id)!.drawing!.count).toBe(2);
});

test("two devices changing one element at once: the newer version wins on both, whatever Yjs picks", () => {
  for (let run = 0; run < 12; run++) {
    const a = new MemRepo();
    const id = a.add({ kind: "zeichnung", title: "Board" });
    a.change(id, (d) => writeElements(d, [el("x", { version: 1 })]));
    const b = fork(a);
    a.change(id, (d) => writeElements(d, [el("x", { version: 5, x: 50 })]));
    b.change(id, (d) => writeElements(d, [el("x", { version: 2, x: 20 })]));
    sync(a, b);
    for (const r of [a, b]) expect(readElements(r.doc(id)).map((e) => [e.version, e.x])).toEqual([[5, 50]]);
    // a deletion is a newer version too: an older edit from elsewhere does not bring the element back
    a.change(id, (d) => writeElements(d, [el("x", { version: 6, isDeleted: true })]));
    b.change(id, (d) => writeElements(d, [el("x", { version: 3, x: 30 })]));
    sync(a, b);
    for (const r of [a, b]) expect(r.get(id)!.drawing!.count).toBe(0);
    // a write drops the copies it outdates
    b.change(id, (d) => writeElements(d, [el("x", { version: 7 })]));
    expect(b.doc(id).getMap("drawing").size).toBe(1);
  }
});

test("a drawing is a block of its note: kept below it, never sorted or listed on its own, found by its text", () => {
  const m = new MemRepo();
  const note = m.add({ title: "Architektur", pinned: "V" });
  const drawing = m.add({ kind: "zeichnung", title: "", parents: [note] });
  m.change(note, (d) => d.getText("body").insert(0, `Überblick\n![[${drawing}]]\n`));
  m.change(drawing, (d) => writeElements(d, [text("t", "Freigabe durch Kunde", "a0")]));
  const loose = m.add({ kind: "zeichnung", title: "", pinned: "W" }); // pinned while drawings were entries
  const other = m.add({ title: "Notiz" });
  const ix = m.index();
  expect(isContent(ix.get(drawing)!)).toBe(true);
  // kept below the note, so it goes to the trash with it
  expect(ix.parentsOf(drawing)).toEqual([note]);
  // not in the inbox, not in the sidebar, not in lists, nothing goes below it
  for (const d of [drawing, loose]) expect(isInInbox(ix.get(d)!, ix)).toBe(false);
  expect(sidebarChildren(note, ix)).toEqual([]);
  // nor in "Darunter" (the note page, the inbox, the review)
  expect(belowOf(note, ix)).toEqual([]);
  expect(sidebarRoots(ix).map((i) => i.id)).toEqual([note]);
  expect(runQuery(parseQuery("", ix).def, { ix }).items.map((i) => i.id)).not.toContain(drawing);
  expect(canPlaceIn(ix.get(other)!, ix.get(drawing)!, ix)).toBe(false);
  // its text is searchable
  const search = createIndex();
  for (const i of ix.live) indexRecord(search, i);
  expect(searchIds(search, "freigabe", 5)).toEqual([drawing]);
});
