import { test, expect } from "bun:test";
import { type PropDef, displayTitle, mapWikiLinks, optionNames, renameLinksIn } from "@obtion/core/model";
import { addDays, addDaysISO, dateOf, diffDays } from "@obtion/core/date";
import { escapeRe, foldUmlauts, plainVowels } from "@obtion/core/text";
import { sameValue } from "@obtion/core/equal";
import { cmpKey, keyBetween, nextPinKey } from "@obtion/core/sortkey";
import { mapValue } from "@obtion/core/typeops";

test("umlauts fold to two letters or to plain vowels, in lower case", () => {
  expect(foldUmlauts("Größe Übermaß")).toBe("groesse uebermass");
  expect(plainVowels("Größe Übermaß")).toBe("grosse ubermass");
  expect(foldUmlauts("ÄÖÜ")).toBe("aeoeue");
});

test("escapeRe makes any text a literal pattern", () => {
  expect(new RegExp(escapeRe("C++ (draft) [1].")).test("C++ (draft) [1].")).toBe(true);
});

test("mapWikiLinks hands over embed, target, section and label", () => {
  const seen: unknown[] = [];
  const out = mapWikiLinks("a [[Page#Part|text]] b ![[x.png|320]] [[Plain]]", (l) => (seen.push({ ...l }), `<${l.target}>`));
  expect(out).toBe("a <Page> b <x.png> <Plain>");
  expect(seen).toEqual([
    { raw: "[[Page#Part|text]]", embed: false, target: "Page", section: "#Part", label: "text" },
    { raw: "![[x.png|320]]", embed: true, target: "x.png", section: "", label: "320" },
    { raw: "[[Plain]]", embed: false, target: "Plain", section: "", label: undefined },
  ]);
});

test("renameLinksIn follows a rename in any case, keeps sections and labels, null when nothing changes", () => {
  expect(renameLinksIn("see [[old]], [[Old#x]], [[OLD|label]] and ![[Old]]", "Old", "New")).toBe("see [[New]], [[New#x]], [[New|label]] and ![[New]]");
  expect(renameLinksIn("[[Older]] stays", "Old", "New")).toBeNull();
  expect(renameLinksIn("[[Old]]", "Old", "  ")).toBeNull();
  expect(renameLinksIn("[[a.b]] [[axb]]", "a.b", "c")).toBe("[[c]] [[axb]]");
});

test("sameValue ignores the order of keys, not of arrays", () => {
  expect(sameValue({ and: [{ type: "t" }, { tag: "x" }] }, { and: [{ type: "t" }, { tag: "x" }] })).toBe(true);
  expect(sameValue({ prop: "a", op: ":" }, { op: ":", prop: "a" })).toBe(true);
  expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  expect(sameValue(["a", "b"], ["b", "a"])).toBe(false);
  expect(sameValue({ a: [1] }, { a: 1 })).toBe(false);
  expect(sameValue(undefined, null)).toBe(false);
});

test("date helpers count calendar days, also across the change to summer time", () => {
  expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
  expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
  expect(addDays("2026-10-24", 7)).toBe("2026-10-31");
  expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  expect(diffDays("2026-03-28", "2026-03-31")).toBe(3);
  expect(diffDays("2026-10-31", "2026-10-24")).toBe(-7);
  // late in the evening before the clocks go back, "tomorrow" is still the next day
  expect(addDaysISO(1, new Date(2026, 9, 24, 23, 30))).toBe("2026-10-25");
  expect(addDaysISO(1, new Date(2026, 2, 28, 23, 30))).toBe("2026-03-29");
  expect(dateOf(new Date(2026, 9, 30, 0, 5).getTime())).toBe("2026-10-30");
});

test("nextPinKey sorts after everything pinned; cmpKey orders keys", () => {
  const a = keyBetween(null, null);
  const b = keyBetween(a, null);
  const next = nextPinKey([{ pinned: b }, {}, { pinned: a }]);
  expect(cmpKey(next, b)).toBe(1);
  expect(nextPinKey([])).toBe(keyBetween(null, null));
  expect(["b", "a", "c"].sort(cmpKey)).toEqual(["a", "b", "c"]);
});

test("optionNames and displayTitle", () => {
  const p: PropDef = { id: "p", name: "Tags", kind: "select", multiple: true, sort: "V", options: [{ id: "o1", name: "Eins" }, { id: "o2", name: "Zwei" }] };
  expect(optionNames(p, ["o2", "gone"])).toEqual(["Zwei", "gone"]);
  expect(optionNames(p, "o1")).toEqual(["Eins"]);
  expect(displayTitle({ title: "Notiz" })).toBe("Notiz");
  expect(displayTitle({ title: "", file: { name: "scan.pdf" } as never })).toBe("scan.pdf");
  expect(displayTitle({ title: "" })).toBe("");
});

test("mapValue: by name with a status group fallback, or (moving) by id and only whole", () => {
  const from: PropDef = { id: "s", name: "Status", kind: "select", sort: "V", options: [{ id: "a", name: "Review", group: "active" }, { id: "d", name: "Done", group: "done" }] };
  const to: PropDef = { id: "s", name: "Status", kind: "select", sort: "V", options: [{ id: "x", name: "Läuft", group: "active" }, { id: "d", name: "Fertig", group: "done" }, { id: "y", name: "review", group: "todo" }] };
  expect(mapValue(from, to, "a")).toBe("y"); // by name
  expect(mapValue(from, to, "d")).toBe("d"); // no name: the group
  expect(mapValue(from, to, "d", { byId: true })).toBe("d"); // the same id
  const multi = (options: PropDef["options"]): PropDef => ({ id: "m", name: "M", kind: "select", multiple: true, sort: "V", options });
  const mf = multi([{ id: "1", name: "One" }, { id: "2", name: "Two" }]);
  const mt = multi([{ id: "9", name: "one" }]);
  expect(mapValue(mf, mt, ["1", "2"])).toEqual(["9"]);
  expect(mapValue(mf, mt, ["1", "2"], { byId: true })).toBeUndefined();
});
