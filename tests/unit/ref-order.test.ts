// Refs keep an order of their own: a link pinned from the text goes in front, one set by hand at
// the end, and either can be moved anywhere. Refs from before the order (stored as `true`) keep
// their place behind the ordered ones until one is moved.
import { test, expect } from "bun:test";
import * as Y from "yjs";
import { addRef, moveRef, refOrder, setMember } from "@obtion/core/model";

test("pinned in front, set by hand at the end, moved anywhere", () => {
  const doc = new Y.Doc();
  setMember(doc, "refs", "a", true);
  setMember(doc, "refs", "b", true);
  addRef(doc, "p", true);
  expect(refOrder(doc)).toEqual(["p", "a", "b"]);
  addRef(doc, "q", true);
  expect(refOrder(doc)).toEqual(["q", "p", "a", "b"]);
  moveRef(doc, "q", null);
  expect(refOrder(doc)).toEqual(["p", "a", "b", "q"]);
  moveRef(doc, "b", "p");
  expect(refOrder(doc)).toEqual(["b", "p", "a", "q"]);
  // already there: keeps its place
  addRef(doc, "a", true);
  expect(refOrder(doc)).toEqual(["b", "p", "a", "q"]);
});

test("older refs without a key get one in their order when one is moved", () => {
  const doc = new Y.Doc();
  const m = doc.getMap("refs");
  m.set("x", true);
  m.set("y", true);
  m.set("z", true);
  expect(refOrder(doc)).toEqual(["x", "y", "z"]);
  moveRef(doc, "z", "x");
  expect(refOrder(doc)).toEqual(["z", "x", "y"]);
  expect([...m.values()].every((v) => typeof v === "string")).toBe(true);
});

test("the order merges between two devices", () => {
  const one = new Y.Doc();
  for (const k of ["a", "b", "c"]) setMember(one, "refs", k, true);
  const two = new Y.Doc();
  Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
  moveRef(one, "c", "a");
  addRef(two, "p", true);
  Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
  Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
  expect(refOrder(one)).toEqual(refOrder(two));
  expect(refOrder(one).slice(-2)).toEqual(["a", "b"]);
});

test("a ref removed on one device stays removed while the other adds one", () => {
  const one = new Y.Doc();
  for (const k of ["x", "y"]) one.getMap("refs").set(k, true); // older refs, no keys
  const two = new Y.Doc();
  Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
  addRef(one, "z");
  addRef(one, "p", true);
  setMember(two, "refs", "x", false);
  Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
  Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
  expect(refOrder(one)).toEqual(["p", "y", "z"]);
  expect(refOrder(two)).toEqual(refOrder(one));
});

test("refs added at once on two devices can still be moved between", () => {
  const one = new Y.Doc();
  setMember(one, "refs", "a", true);
  const two = new Y.Doc();
  Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
  setMember(one, "refs", "b", true);
  setMember(two, "refs", "c", true); // same key as b
  Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
  Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
  setMember(one, "refs", "z", true);
  expect(refOrder(one)).toEqual(["a", "b", "c", "z"]);
  moveRef(one, "z", "c");
  expect(refOrder(one)).toEqual(["a", "b", "z", "c"]);
});
