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
  const find = search([{ title: "eMarketing France" }, { title: "E-Ticket required" }, { title: "Invoicing basics" }]);
  expect(find("e-marketing")[0]).toBe("eMarketing France"); // "Invoicing basics" follows as a fuzzy match
  expect(find("E-Ticket")).toEqual(["E-Ticket required"]);
  expect(find("eticket")).toEqual(["E-Ticket required"]);
  expect(find("Ticket")).toEqual(["E-Ticket required"]);
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
    { title: "Delivery_Sample_4711_2026-01-15.pdf" },
    { title: "Failed job", body: "Job DEMO_EXPORT_PDF_MAIL_DUPLICATES runs on SRV-TEST-01." },
    { title: "Other invoice", body: "Invoice 4712 to client" },
  ]);
  expect(find("4711")).toEqual(["Delivery_Sample_4711_2026-01-15.pdf"]);
  expect(find("Sample")).toEqual(["Delivery_Sample_4711_2026-01-15.pdf"]);
  expect(find("DEMO_EXPORT_PDF_MAIL_DUPLICATES")).toEqual(["Failed job"]);
  expect(find("EXPORT_PDF")).toEqual(["Failed job"]);
  expect(find("demo")).toEqual(["Failed job"]);
  expect(find("DUPLICATES")).toEqual(["Failed job"]);
  expect(find("SRV-TEST-01")).toEqual(["Failed job"]);
  // numbers are never fuzzy: the neighbouring invoice does not come up
  expect(find("4712")).toEqual(["Other invoice"]);
});

test("plain text keeps underscores inside words and drops emphasis", () => {
  expect(plainText("File STATUS_2026-10-30.md and _italic_ and __bold__")).toBe("File STATUS_2026-10-30.md and italic and bold");
  expect(plainText("**DEMO_EXPORT** runs")).toBe("DEMO_EXPORT runs");
});

test("the excerpt is centred on the hit, keeps underscores and names its heading", () => {
  const body = ["# Status", "", "All quiet. ".repeat(40), "", "## Open points", "", "Filler. ".repeat(30) + "The job DEMO_EXPORT_PDF_MAIL_DUPLICATES aborts. " + "More text. ".repeat(30), "", "## Done", "Nothing."].join("\n");
  const e = excerpt(body, "duplicates");
  expect(e.text).toContain("DEMO_EXPORT_PDF_MAIL_DUPLICATES");
  expect(e.text.startsWith("…")).toBe(true);
  expect(e.text.length).toBeLessThan(170);
  expect(e.heading).toBe("Status > Open points");
  // the whole identifier and a part of it land on the same spot
  expect(excerpt(body, "DEMO_EXPORT_PDF_MAIL_DUPLICATES").heading).toBe("Status > Open points");
  expect(excerpt(body, "4711").heading).toBeUndefined(); // not in it: the start, no heading
  expect(excerpt(body, "4711").text.startsWith("Status")).toBe(true);
  // several words: the occurrence near the others
  const two = "Mapping is done. " + "x ".repeat(200) + "Mapping review on Friday.";
  expect(excerpt(two, "mapping friday").text).toContain("review on Friday");
  // hyphenated query words are found as written
  expect(snippet("x ".repeat(100) + "Required: the E-Invoice from 2025", "e-invoice")).toContain("E-Invoice");
});

test("outline: headings with level, path, offset and size, none in code blocks", () => {
  const text = "Intro\n# Status\nA\n## Open points ##\nB\n```\n# no heading\n```\n### Details\nC\n## Done\nD\n# Appendix\nE";
  const h = outline(text);
  expect(h.map((x) => [x.level, x.path])).toEqual([
    [1, "Status"],
    [2, "Status > Open points"],
    [3, "Status > Open points > Details"],
    [2, "Status > Done"],
    [1, "Appendix"],
  ]);
  const open = h[1]!;
  expect(text.slice(open.offset, open.offset + open.size)).toBe("## Open points ##\nB\n```\n# no heading\n```\n### Details\nC\n");
  expect(text.slice(h[4]!.offset, h[4]!.offset + h[4]!.size)).toBe("# Appendix\nE");
  expect(headingAt(h, text.indexOf("C"))?.path).toBe("Status > Open points > Details");
  expect(headingAt(h, 2)).toBeUndefined();
  // \r\n line ends
  expect(outline("# A\r\ntext\r\n## B\r\n").map((x) => x.text)).toEqual(["A", "B"]);
});

test("sections by heading or path, case-insensitive; ambiguous ones give the candidates", () => {
  const h = outline("# Project A\n## Open points\nx\n# Project B\n## Open points\ny\n## **Risks** and costs\nz");
  expect("candidates" in findSection(h, "open points") && findSection(h, "open points")).toMatchObject({ candidates: [{ path: "Project A > Open points" }, { path: "Project B > Open points" }] });
  expect(findSection(h, "Project B > Open points")).toMatchObject({ heading: { path: "Project B > Open points" } });
  expect(findSection(h, "project b › open points")).toMatchObject({ heading: { path: "Project B > Open points" } });
  expect(findSection(h, "Risks and costs")).toMatchObject({ heading: { level: 2 } });
  expect(findSection(h, "risks")).toMatchObject({ heading: { level: 2 } }); // contained, unique
  expect(findSection(h, "Does not exist")).toEqual({ candidates: [] });
});

test("pages end at a line break near their end and say where the next starts", () => {
  const text = Array.from({ length: 100 }, (_, n) => `Line ${n}`).join("\n");
  const p = page(text, 0, 100);
  expect(p.text.endsWith("\n")).toBe(true);
  expect(p.next).toBe(p.to);
  const q = page(text, p.next!, 100);
  expect(q.text.startsWith("Line")).toBe(true);
  expect(page(text, text.length - 5, 100)).toMatchObject({ next: undefined, to: text.length });
});

test("excerpts look for words where they start, and for what a prefix or fuzzy search matched", () => {
  const body = "# Introduction\nA concatenation of values.\n# Animals\nThe cat sleeps.";
  expect(excerpt(body, "cat").heading).toBe("Animals");
  // two letters are no prefix: "an" is the word, not the start of "Answers"
  expect(excerpt("# Answers\n" + "Text. ".repeat(60) + "\n# Goal\nWe work on an idea.", "an").heading).toBe("Goal");
  // a whole word in the other spelling comes before a part of a word (German umlaut on purpose)
  expect(excerpt("# Oldtimer\nText.\n# Wartung\nDas Öl ist neu.", "ol").heading).toBe("Wartung");
  const m = new MemRepo();
  const idx = createIndex();
  const id = m.add({ title: "Note", body: "# Preamble\n" + "Text. ".repeat(60) + "\n# Work\nThe mapping is done." });
  indexRecord(idx, m.get(id)!);
  const [hit] = searchHits(idx, "maping");
  expect(hit!.id).toBe(id);
  const e = excerpt(m.get(id)!.body, "maping", 160, hit!.terms);
  expect(e.heading).toBe("Work");
  expect(e.text).toContain("mapping is done");
});
