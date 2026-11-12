// Refs keep an order of their own: a link pinned from the text goes in front, one set by hand at
// the end, and either can be moved anywhere.
import { expect, test } from "bun:test";
import { addRef, moveRef, refOrder, setMember } from "@obtion/core/model";
import * as Y from "yjs";

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
	for (const k of ["x", "y"]) setMember(one, "refs", k, true);
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
