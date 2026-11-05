import { test, expect } from "bun:test";
import { MemRepo, fork, sync } from "../support/helpers";
import { type SceneElement, drawingInfo, excalidrawFile, readElements, readScene, setDrawingFile, setDrawingState, writeElements } from "@obtion/core/drawing";
import { holdsItems, isContent } from "@obtion/core/model";
import { canPlaceIn, isInInbox } from "@obtion/core/placement";
import { parseQuery, printQuery, runQuery } from "@obtion/core/query";
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

test("a drawing is placed, nested and found like a note", () => {
  const m = new MemRepo();
  const project = m.add({ title: "Projekt" });
  const loose = m.add({ kind: "zeichnung", title: "Lose Skizze" });
  const placed = m.add({ kind: "zeichnung", title: "Ablauf", parents: [project] });
  m.change(placed, (d) => writeElements(d, [text("t", "Freigabe durch Kunde", "a0")]));
  const note = m.add({ title: "Detail", parents: [placed] });
  const ix = m.index();
  const drawing = ix.get(placed)!;
  expect(isContent(drawing) && holdsItems(drawing)).toBe(true);
  expect(ix.childrenOf(placed)).toEqual([note]);
  expect(ix.childrenOf(project)).toEqual([placed]);
  // a drawing can hold other entries, like a note
  expect(canPlaceIn(ix.get(loose)!, drawing, ix)).toBe(true);
  expect(canPlaceIn(ix.get(project)!, drawing, ix)).toBe(false); // a cycle
  // without a place it waits in the inbox, like a note
  expect(isInInbox(ix.get(loose)!, ix)).toBe(true);
  expect(isInInbox(drawing, ix)).toBe(false);
  // its text is searchable
  const search = createIndex();
  for (const i of ix.live) indexRecord(search, i);
  expect(searchIds(search, "freigabe", 5)).toEqual([placed]);
  // "zeichnung" / "drawing" in queries
  const de = parseQuery("zeichnung", ix);
  expect(de.def).toEqual(parseQuery("drawing", ix).def);
  expect(printQuery(de.def, "de", ix)).toBe("zeichnung");
  expect(runQuery(de.def, { ix }).items.map((i) => i.title).sort()).toEqual(["Ablauf", "Lose Skizze"]);
});
