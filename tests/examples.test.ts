import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { MemRepo, tempDir, removeTempDirs } from "./helpers";
import { runSetup, SYS } from "../src/shared/setup";
import { EXAMPLE, EX_TYPES, exampleFiles, fileFacts, listExamples, removeExamples, restoreExamples, writeExamples } from "../src/shared/examples";
import { defaultStartBody } from "../src/shared/setup";
import { findBlocks, readBlock, runQuery } from "../src/shared/query";
import { inbox } from "../src/shared/placement";
import { setMeta, touch } from "../src/shared/model";
import { Store } from "../src/server/store";
import { Blobs, sha256 } from "../src/server/blobs";
import { setUp } from "../src/server/importers";
import type { Lang } from "../src/shared/i18n";

afterAll(removeTempDirs);

function world(lang: Lang = "de") {
  const m = new MemRepo();
  runSetup(m.writer, lang);
  const files = Object.fromEntries(exampleFiles(lang).map((f) => [f.key, fileFacts(f, sha256(f.bytes))]));
  writeExamples(m.writer, lang, files);
  return m;
}
const blockTitles = (m: MemRepo, body: string, i: number, thisId?: string) => {
  const ix = m.index();
  return runQuery(readBlock(findBlocks(body)[i]!.src, ix).def, { ix, thisId }).items.map((x) => x.title);
};

for (const lang of ["de", "en"] as Lang[])
  test(`the examples (${lang}): marked, linked, in the language of the setup`, () => {
    const m = world(lang);
    const ix = m.index();
    const ex = ix.live.filter((i) => i.source === EXAMPLE);
    expect(ex.length).toBeGreaterThanOrEqual(30);
    expect(ex.length).toBeLessThanOrEqual(45);
    // every [[link]] of the examples finds its target, also the embedded image and the PDF
    for (const i of ex) expect(ix.missingLinks(i)).toEqual([]);
    expect(ix.get("ex-welcome")!.title).toBe(lang === "de" ? "So funktioniert Obtion" : "How Obtion works");
    // a project in two places, progress across levels
    expect(ix.parentsOf("ex-relaunch")).toEqual(["ex-work", "ex-nordlicht"]);
    expect(ix.progress("ex-relaunch").done).toBe(2);
    // the books: own type with an author relation and a status; plural set
    expect(ix.typePlural(EX_TYPES.book)).toBe(lang === "de" ? "Bücher" : "Books");
    expect(ix.get("ex-b-moor")!.rels.p_ex_author).toEqual(["ex-p-lena"]);
    // the inbox: four entries, one bundle; the idea mentions the project
    expect(inbox(ix).map((i) => i.id).sort()).toEqual(["ex-i-bike", "ex-i-podcast", "ex-i-references", "ex-i-trip"]);
    expect(ix.textLinks(ix.get("ex-i-references")!).map((l) => l.to)).toEqual(["ex-relaunch"]);
    // the start page has something to show: overdue, today, active projects
    const start = defaultStartBody(lang);
    expect(blockTitles(m, start, 0)).toEqual([lang === "de" ? "CMS auswählen" : "Choose a CMS"]);
    expect(blockTitles(m, start, 1)).toEqual([lang === "de" ? "Mockups für die Startseite" : "Mockups for the home page"]);
    // the query page and the reading list
    expect(blockTitles(m, ix.get("ex-week")!.body, 0).length).toBe(3);
    expect(blockTitles(m, ix.get("ex-personal")!.body, 0, "ex-personal").length).toBe(3);
    expect(blockTitles(m, ix.get("ex-work")!.body, 0, "ex-work")).toContain(lang === "de" ? "Website-Relaunch" : "Website relaunch");
  });

test("running the examples twice adds nothing", () => {
  const m = world();
  const before = m.index().live.length;
  writeExamples(m.writer, "de", {});
  expect(m.index().live.length).toBe(before);
});

test("removing the examples: unchanged ones by default, types only when nothing is left of them", () => {
  const m = world();
  // edited by the user, and one with an own entry below it: both marked, not chosen by default
  m.change("ex-b-city", (d) => touch(d, Date.now() + 1000));
  const own = m.add({ title: "Meine Notiz", parents: ["ex-learn"] });
  const ownBook = m.add({ title: "Mein Buch", type: EX_TYPES.article, parents: [own] });
  const list = listExamples(m.index());
  const by = (id: string) => list.find((e) => e.id === id)!;
  expect(by("ex-b-city").changed).toBe(true);
  expect(by("ex-learn").changed).toBe(true);
  expect(by("ex-relaunch").changed).toBe(false);
  expect(by(EX_TYPES.article).inUse).toBe(true);
  expect(list.at(-1)!.isType).toBe(true);

  const chosen = list.filter((e) => !e.changed && !e.inUse).map((e) => e.id);
  const removed = removeExamples(m.writer, m.index(), [...chosen, EX_TYPES.article]);
  const ix = m.index();
  expect(ix.get("ex-relaunch")).toBeUndefined();
  expect(ix.get("ex-b-city")).toBeDefined();
  expect(ix.get("ex-learn")).toBeDefined();
  expect(ix.get(own)).toBeDefined();
  // Person goes (its people went), Buch stays (one book was kept), Artikel stays (an own entry)
  expect(ix.types.has(EX_TYPES.person)).toBe(false);
  expect(ix.types.has(EX_TYPES.book)).toBe(true);
  expect(ix.types.has(EX_TYPES.article)).toBe(true);
  expect(ix.get(ownBook)).toBeDefined();
  // nothing of the user's own: only examples
  expect(removed.every((id) => id.startsWith("ex-"))).toBe(true);

  restoreExamples(m.writer, removed);
  expect(m.index().get("ex-relaunch")).toBeDefined();
  expect(m.index().types.has(EX_TYPES.person)).toBe(true);
});

test("removeExamples ignores ids that are not examples", () => {
  const m = world();
  const own = m.add({ title: "Eigenes" });
  expect(removeExamples(m.writer, m.index(), [own, SYS.project])).toEqual([]);
  m.change(own, (d) => setMeta(d, { title: "Eigenes 2" }));
  expect(m.index().get(own)).toBeDefined();
});

test("on the hub: set up with the examples, the files' contents stored", async () => {
  const dir = tempDir("obtion-ex-");
  const store = new Store(dir);
  const blobs = new Blobs(join(dir, "blobs"), store);
  await setUp(store, blobs, "de", { examples: true });
  const files = store.live().filter((r) => r.source === EXAMPLE && r.file);
  expect(files.map((f) => f.file!.filetype).sort()).toEqual(["bild", "pdf"]);
  for (const f of files) expect(blobs.has(f.file!.hash)).toBe(true);
  expect(files.find((f) => f.file!.filetype === "pdf")!.file!.pages).toBe(1);
  expect(store.records.get(SYS.project)).toBeDefined();
});
