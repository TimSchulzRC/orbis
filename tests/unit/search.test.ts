import { test, expect } from "bun:test";
import { createIndex, excerpt, indexRecord, plainText, searchHits, searchIds, snippet } from "@obtion/core/search";
import { findSection, headingAt, outline, page } from "@obtion/core/outline";
import { MemRepo } from "../support/helpers";

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
  for (const q of ["neue Idee", "Klasse Projekt", "foo OR OR bar", "\"unclosed", "((", "*", "~^"]) expect(find(q), q).toBeArray();
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

test("identifiers with underscores are found whole, by their parts and by a prefix", () => {
  const find = search([
    { title: "Lieferschein_Muster_4711_2026-01-15.pdf" },
    { title: "Fehlerjob", body: "Job DEMO_EXPORT_PDF_MAIL_DUPLICATES läuft auf SRV-TEST-01." },
    { title: "Andere Rechnung", body: "Rechnung 4712 an Kunde" },
  ]);
  expect(find("4711")).toEqual(["Lieferschein_Muster_4711_2026-01-15.pdf"]);
  expect(find("Muster")).toEqual(["Lieferschein_Muster_4711_2026-01-15.pdf"]);
  expect(find("DEMO_EXPORT_PDF_MAIL_DUPLICATES")).toEqual(["Fehlerjob"]);
  expect(find("EXPORT_PDF")).toEqual(["Fehlerjob"]);
  expect(find("demo")).toEqual(["Fehlerjob"]);
  expect(find("DUPLICATES")).toEqual(["Fehlerjob"]);
  expect(find("SRV-TEST-01")).toEqual(["Fehlerjob"]);
  // numbers are never fuzzy: the neighbouring invoice does not come up
  expect(find("4712")).toEqual(["Andere Rechnung"]);
});

test("plain text keeps underscores inside words and drops emphasis", () => {
  expect(plainText("Datei STATUS_2026-10-30.md und _kursiv_ und __fett__")).toBe("Datei STATUS_2026-10-30.md und kursiv und fett");
  expect(plainText("**DEMO_EXPORT** läuft")).toBe("DEMO_EXPORT läuft");
});

test("the excerpt is centred on the hit, keeps underscores and names its heading", () => {
  const body = ["# Status", "", "Alles ruhig. ".repeat(40), "", "## Offene Punkte", "", "Filler. ".repeat(30) + "Der Job DEMO_EXPORT_PDF_MAIL_DUPLICATES bricht ab. " + "Mehr Text. ".repeat(30), "", "## Erledigt", "Nichts."].join("\n");
  const e = excerpt(body, "duplicates");
  expect(e.text).toContain("DEMO_EXPORT_PDF_MAIL_DUPLICATES");
  expect(e.text.startsWith("…")).toBe(true);
  expect(e.text.length).toBeLessThan(170);
  expect(e.heading).toBe("Status > Offene Punkte");
  // the whole identifier and a part of it land on the same spot
  expect(excerpt(body, "DEMO_EXPORT_PDF_MAIL_DUPLICATES").heading).toBe("Status > Offene Punkte");
  expect(excerpt(body, "4711").heading).toBeUndefined(); // not in it: the start, no heading
  expect(excerpt(body, "4711").text.startsWith("Status")).toBe(true);
  // several words: the occurrence near the others
  const two = "Mapping ist fertig. " + "x ".repeat(200) + "Mapping Review am Freitag.";
  expect(excerpt(two, "mapping freitag").text).toContain("Review am Freitag");
  // hyphenated query words are found as written
  expect(snippet("x ".repeat(100) + "Pflicht zur E-Rechnung ab 2025", "e-rechnung")).toContain("E-Rechnung");
});

test("outline: headings with level, path, offset and size, none in code blocks", () => {
  const text = "Intro\n# Status\nA\n## Offene Punkte ##\nB\n```\n# kein Heading\n```\n### Details\nC\n## Erledigt\nD\n# Anhang\nE";
  const h = outline(text);
  expect(h.map((x) => [x.level, x.path])).toEqual([
    [1, "Status"],
    [2, "Status > Offene Punkte"],
    [3, "Status > Offene Punkte > Details"],
    [2, "Status > Erledigt"],
    [1, "Anhang"],
  ]);
  const open = h[1]!;
  expect(text.slice(open.offset, open.offset + open.size)).toBe("## Offene Punkte ##\nB\n```\n# kein Heading\n```\n### Details\nC\n");
  expect(text.slice(h[4]!.offset, h[4]!.offset + h[4]!.size)).toBe("# Anhang\nE");
  expect(headingAt(h, text.indexOf("C"))?.path).toBe("Status > Offene Punkte > Details");
  expect(headingAt(h, 2)).toBeUndefined();
  // \r\n line ends
  expect(outline("# A\r\ntext\r\n## B\r\n").map((x) => x.text)).toEqual(["A", "B"]);
});

test("sections by heading or path, case-insensitive; ambiguous ones give the candidates", () => {
  const h = outline("# Projekt A\n## Offene Punkte\nx\n# Projekt B\n## Offene Punkte\ny\n## **Risiken** und Kosten\nz");
  expect("candidates" in findSection(h, "offene punkte") && findSection(h, "offene punkte")).toMatchObject({ candidates: [{ path: "Projekt A > Offene Punkte" }, { path: "Projekt B > Offene Punkte" }] });
  expect(findSection(h, "Projekt B > Offene Punkte")).toMatchObject({ heading: { path: "Projekt B > Offene Punkte" } });
  expect(findSection(h, "projekt b › offene punkte")).toMatchObject({ heading: { path: "Projekt B > Offene Punkte" } });
  expect(findSection(h, "Risiken und Kosten")).toMatchObject({ heading: { level: 2 } });
  expect(findSection(h, "risiken")).toMatchObject({ heading: { level: 2 } }); // contained, unique
  expect(findSection(h, "Gibt es nicht")).toEqual({ candidates: [] });
});

test("pages end at a line break near their end and say where the next starts", () => {
  const text = Array.from({ length: 100 }, (_, n) => `Zeile ${n}`).join("\n");
  const p = page(text, 0, 100);
  expect(p.text.endsWith("\n")).toBe(true);
  expect(p.next).toBe(p.to);
  const q = page(text, p.next!, 100);
  expect(q.text.startsWith("Zeile")).toBe(true);
  expect(page(text, text.length - 5, 100)).toMatchObject({ next: undefined, to: text.length });
});

test("excerpts look for words where they start, and for what a prefix or fuzzy search matched", () => {
  const body = "# Einleitung\nEine concatenation von Werten.\n# Tiere\nDie cat schläft.";
  expect(excerpt(body, "cat").heading).toBe("Tiere");
  // two letters are no prefix: "an" is the word, not the start of "Anleitung"
  expect(excerpt("# Anleitung\n" + "Text. ".repeat(60) + "\n# Ziel\nWir arbeiten an Obtion.", "an").heading).toBe("Ziel");
  // a whole word in the other spelling comes before a part of a word
  expect(excerpt("# Oldtimer\nText.\n# Wartung\nDas Öl ist neu.", "ol").heading).toBe("Wartung");
  const m = new MemRepo();
  const idx = createIndex();
  const id = m.add({ title: "Notiz", body: "# Vorspann\n" + "Text. ".repeat(60) + "\n# Arbeit\nDas mapping ist fertig." });
  indexRecord(idx, m.get(id)!);
  const [hit] = searchHits(idx, "maping");
  expect(hit!.id).toBe(id);
  const e = excerpt(m.get(id)!.body, "maping", 160, hit!.terms);
  expect(e.heading).toBe("Arbeit");
  expect(e.text).toContain("mapping ist fertig");
});
