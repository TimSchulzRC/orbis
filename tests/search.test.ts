import { test, expect } from "bun:test";
import { createIndex, indexRecord, searchIds, snippet } from "@obtion/core/search";
import { MemRepo } from "./helpers";

function search(docs: { title: string; body?: string; tags?: string[] }[]) {
  const m = new MemRepo();
  const idx = createIndex();
  const ids = docs.map((d) => m.add(d));
  for (const id of ids) indexRecord(idx, m.get(id)!);
  const titles = new Map(ids.map((id, i) => [id, docs[i]!.title]));
  return (q: string) => searchIds(idx, q, 50).map((id) => titles.get(id));
}

test("finds German words across spellings", () => {
  const find = search([{ title: "Größenordnung", body: "Jürgen erklärt es" }, { title: "Tomato soup recipe" }]);
  for (const q of ["Grossenordnung", "Groessenordnung", "Größenordnung", "Juergen", "jürgen", "grö", "erklaert"]) expect(find(q), q).toEqual(["Größenordnung"]);
  expect(find("tomato soup")).toEqual(["Tomato soup recipe"]);
});

test("handles multi-word German queries with spelling variants", () => {
  const find = search([{ title: "Treffen mit Jürgen", body: "Die Straße und der Müll" }, { title: "Andere Notiz", body: "Muell an der Strasse" }]);
  expect(find("Treffen Juergen")).toEqual(["Treffen mit Jürgen"]);
  expect(find("Strasse Muell").sort()).toEqual(["Andere Notiz", "Treffen mit Jürgen"]);
  expect(find("Straße Müll").sort()).toEqual(["Andere Notiz", "Treffen mit Jürgen"]);
  for (const q of ["neue Idee", "Klasse Projekt", "foo OR OR bar", "\"unclosed", "((", "*", "~^"]) expect(() => find(q), q).not.toThrow();
});

test("matches hyphenated words and ignores punctuation-only queries", () => {
  const find = search([{ title: "eMarketing France" }, { title: "E-Rechnung Pflicht" }, { title: "Invoicing basics" }]);
  expect(find("e-marketing")[0]).toBe("eMarketing France"); // "Invoicing basics" follows as a fuzzy match
  expect(find("E-Rechnung")).toEqual(["E-Rechnung Pflicht"]);
  expect(find("erechnung")).toEqual(["E-Rechnung Pflicht"]);
  expect(find("Rechnung")).toEqual(["E-Rechnung Pflicht"]);
  expect(find("!!!")).toEqual([]);
});

test("does not treat single letters as prefixes", () => {
  const find = search([{ title: "C++ templates" }, { title: "Clustering" }, { title: "Cooking" }]);
  expect(find("C++")).toEqual(["C++ templates"]);
  expect(find("C")).toEqual(["C++ templates"]);
});

test("snippets find the spot across spellings", () => {
  const body = "x ".repeat(80) + "Treffen mit Jürgen an der Straße";
  expect(snippet(body, "Juergen")).toContain("Jürgen");
  expect(snippet(body, "strasse")).toContain("Straße");
});
