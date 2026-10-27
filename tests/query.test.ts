import { test, expect, describe } from "bun:test";
import { MemRepo } from "./helpers";
import { runSetup, SYS, addLaterDefaultProps, renameShippedLabels } from "../src/shared/setup";
import { parseQuery, printQuery, runQuery, groupItems, normalizeBlocks, findBlocks, readBlock, blocksAsText, shownByBlocks } from "../src/shared/query";
import { addDaysISO, todayISO, initItem, initSchema, META_TYPE, removeProp, setMember } from "../src/shared/model";

function world() {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  const person = "t_person";
  m.change(person, (d) => {
    initItem(d, { type: META_TYPE, title: "Person" });
    initSchema(d, { name: "Person", icon: "user", color: "pink", properties: [{ id: "p_rolle", name: "Rolle", kind: "text" }] });
  });
  const arbeit = m.add({ title: "Arbeit", pinned: "V" });
  const einv = m.add({ title: "Relaunch", type: SYS.project, parents: [arbeit], props: { p_status: "st_active" } });
  const fr = m.add({ title: "Relaunch Frankreich", type: SYS.project, parents: [einv], props: { p_status: "st_active" } });
  const nord = m.add({ title: "Nordlicht", pinned: "W", tags: ["kunde"] });
  const nordFr = m.add({ title: "Nordlicht · Frankreich", type: SYS.project, parents: [fr, nord], props: { p_status: "st_planning" } });
  const t1 = m.add({ title: "Mockups erstellen", type: SYS.task, parents: [fr], props: { p_status: "st_active", p_due: addDaysISO(3) } });
  const t2 = m.add({ title: "Farben wählen", type: SYS.task, parents: [nordFr], props: { p_status: "st_todo", p_due: addDaysISO(-2) } });
  const t3 = m.add({ title: "Kick-off", type: SYS.task, parents: [nordFr], props: { p_status: "st_done" } });
  const sub = m.add({ title: "Pflichtfelder prüfen", type: SYS.task, parents: [t1], props: { p_status: "st_todo" } });
  const modul = m.add({ title: "Datenbanken", pinned: "X", tags: ["modul"], extra: { ECTS: { k: "number", v: 6 }, Note: { k: "number", v: 1.7 } } });
  const julia = m.add({ title: "Julia Weber", tags: ["people"], parents: [arbeit] });
  const martin = m.add({ title: "Martin Kleppmann", type: person, tags: ["people", "autor"] });
  const inbox = m.add({ title: "Idee: Validierung", body: "[[Nordlicht · Frankreich]]" });
  return { m, ix: m.index(), arbeit, einv, fr, nord, nordFr, t1, t2, t3, sub, modul, julia, martin, inbox, person };
}

const titles = (items: { title: string }[]) => items.map((i) => i.title).sort();

describe("query language", () => {
  test("German and English parse to the same JSON with ids", () => {
    const w = world();
    const de = parseQuery("typ:Task status:offen unter:[[Relaunch]] fällig<=+7d sort:fällig gruppe:pfad", w.ix);
    const en = parseQuery("type:Task status:open under:[[Relaunch]] due<=+7d sort:due group:path", w.ix);
    expect(de.errors).toEqual([]);
    expect(de.def).toEqual(en.def);
    expect(JSON.stringify(de.def)).toContain(w.einv);
    expect(printQuery(de.def, "de", w.ix)).toBe("typ:Task status:offen unter:[[Relaunch]] fällig<=+7d sort:fällig gruppe:pfad");
    expect(printQuery(de.def, "en", w.ix)).toBe("type:Task status:open under:[[Relaunch]] due<=+7d sort:due group:path");
  });

  test("open = not done; under: aggregates over all levels and parents, each once", () => {
    const w = world();
    const r = runQuery(parseQuery("typ:Task status:offen unter:[[Relaunch]]", w.ix).def, { ix: w.ix });
    expect(titles(r.items)).toEqual(["Farben wählen", "Mockups erstellen", "Pflichtfelder prüfen"]);
    const viaClient = runQuery(parseQuery("typ:Task unter:[[Nordlicht]]", w.ix).def, { ix: w.ix });
    expect(titles(viaClient.items)).toEqual(["Farben wählen", "Kick-off"]);
    expect(titles(runQuery(parseQuery("typ:Task status:neu", w.ix).def, { ix: w.ix }).items)).toEqual(["Farben wählen", "Pflichtfelder prüfen"]);
    expect(titles(runQuery(parseQuery("typ:Projekt -status:erledigt in:[[Relaunch]]", w.ix).def, { ix: w.ix }).items)).toEqual(["Relaunch Frankreich"]);
  });

  test("type or tag, free properties, diese", () => {
    const w = world();
    expect(titles(runQuery(parseQuery("(typ:Person | #people) sort:titel", w.ix).def, { ix: w.ix }).items)).toEqual(["Julia Weber", "Martin Kleppmann"]);
    expect(titles(runQuery(parseQuery("(typ:Person | #people) #autor", w.ix).def, { ix: w.ix }).items)).toEqual(["Martin Kleppmann"]);
    expect(titles(runQuery(parseQuery("#modul note<2", w.ix).def, { ix: w.ix }).items)).toEqual(["Datenbanken"]);
    expect(titles(runQuery(parseQuery("#modul note<1,5", w.ix).def, { ix: w.ix }).items)).toEqual([]);
    expect(titles(runQuery(parseQuery("in:diese", w.ix).def, { ix: w.ix, thisId: w.arbeit }).items)).toEqual(["Julia Weber", "Relaunch"]);
  });

  test("due dates work through the type's due role", () => {
    const w = world();
    expect(titles(runQuery(parseQuery("status:offen fällig<heute", w.ix).def, { ix: w.ix }).items)).toEqual(["Farben wählen"]);
    expect(titles(runQuery(parseQuery("fällig>heute fällig<=+7d", w.ix).def, { ix: w.ix }).items)).toEqual(["Mockups erstellen"]);
    expect(titles(runQuery(parseQuery("fällig:leer typ:Task", w.ix).def, { ix: w.ix }).items)).toEqual(["Kick-off", "Pflichtfelder prüfen"]);
  });

  test("inbox, linked, status by option name", () => {
    const w = world();
    expect(titles(runQuery(parseQuery("eingang", w.ix).def, { ix: w.ix }).items)).toEqual(["Idee: Validierung"]);
    expect(titles(runQuery(parseQuery("verknüpft:[[Nordlicht · Frankreich]]", w.ix).def, { ix: w.ix }).items)).toContain("Idee: Validierung");
    expect(titles(runQuery(parseQuery('status:"In Bearbeitung"', w.ix).def, { ix: w.ix }).items)).toEqual(["Mockups erstellen", "Relaunch", "Relaunch Frankreich"]);
  });

  test("group by path relative to the page; sub-tasks stay with their parent task's group", () => {
    const w = world();
    const def = parseQuery("typ:Task unter:diese gruppe:pfad", w.ix).def;
    const ctx = { ix: w.ix, thisId: w.einv };
    const res = runQuery(def, ctx);
    const groups = groupItems(res.items, "path", ctx, w.einv);
    const label = (g: { path?: string[] }) => (g.path ?? []).map((id) => w.ix.get(id)!.title).join(" › ");
    expect(groups.map(label)).toEqual(["Relaunch Frankreich", "Relaunch Frankreich › Nordlicht · Frankreich"]);
    expect(titles(groups[0]!.items)).toEqual(["Mockups erstellen", "Pflichtfelder prüfen"]);
  });

  test("a query on a deleted type reports it", () => {
    const w = world();
    const def = parseQuery("typ:Person", w.ix).def;
    w.m.change(w.person, (d) => d.getMap("meta").set("deleted", true));
    const ix = w.m.index();
    const r = runQuery(def, { ix });
    expect(r.items).toEqual([]);
    expect(r.missingTypes).toEqual([w.person]);
    expect(printQuery(def, "de", ix)).toBe("typ:Person");
  });

  test("blocks in the text: text form is normalised to JSON and printed back", () => {
    const w = world();
    const body = "Intro\n\n```abfrage typ:Task status:offen unter:diese```\n\nEnde";
    const norm = normalizeBlocks(body, w.ix);
    expect(norm).toContain('"type":"sys:task"');
    const b = findBlocks(norm);
    expect(b.length).toBe(1);
    expect(readBlock(b[0]!.src, w.ix).wasText).toBe(false);
    expect(blocksAsText(norm, "en", w.ix)).toContain("type:Task status:open under:this");
    expect(todayISO().length).toBe(10);
  });

  test("view keywords", () => {
    const w = world();
    const { def } = parseQuery("in:diese #modul spalten:ects,note ansicht:tabelle max:5", w.ix);
    expect(def.columns).toEqual(["ects", "note"]);
    expect(def.view).toBe("table");
    expect(def.limit).toBe(5);
    expect(printQuery(def, "en", w.ix)).toBe("in:this #modul view:table columns:ects,note limit:5");
  });
});

test("a block with in:this in the text hides those children from the automatic Darunter", () => {
  const w = world();
  w.m.change(w.arbeit, (d) => d.getText("body").insert(0, "```abfrage in:diese typ:Projekt```"));
  const ix = w.m.index();
  const hidden = shownByBlocks(ix.get(w.arbeit)!, ix);
  expect([...hidden].map((id) => ix.get(id)!.title)).toEqual(["Relaunch"]);
});

test("verknüpft:unter: finds items linked to X or to a descendant of X – e.g. a context inbox", () => {
  const w = world();
  // "Idee: Validierung" links [[Nordlicht · Frankreich]], which is below Arbeit (and below Nordlicht)
  const ix = w.m.index();
  const def = parseQuery("eingang verknüpft:unter:[[Arbeit]]", ix).def;
  expect(runQuery(def, { ix }).items.map((i) => i.title)).toEqual(["Idee: Validierung"]);
  expect(printQuery(def, "de", ix)).toBe("eingang verknüpft:unter:[[Arbeit]]");
  expect(printQuery(def, "en", ix)).toBe("inbox linked:under:[[Arbeit]]");
  expect(parseQuery("inbox linked:under:[[Arbeit]]", ix).def).toEqual(def);
  expect(runQuery(parseQuery("eingang verknüpft:unter:[[Datenbanken]]", ix).def, { ix }).items).toEqual([]);
  expect(runQuery(parseQuery("verknüpft:[[Arbeit]]", ix).def, { ix }).items).toEqual([]); // plain verknüpft: only X itself
});

test("blockiert: an open blocker or a waiting-for text; ohne:offene-kinder", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  const p = m.add({ title: "Projekt", type: SYS.project, props: { p_status: "st_active" } });
  const a = m.add({ title: "A", type: SYS.task, parents: [p], props: { p_status: "st_todo" } });
  m.add({ title: "B", type: SYS.task, parents: [p], props: { p_status: "st_todo" }, rels: { p_blocked: [a] } });
  const c = m.add({ title: "C", type: SYS.task, parents: [p], props: { p_status: "st_todo", p_waiting: "Zertifikat vom Kunden" } });
  m.add({ title: "C1", type: SYS.task, parents: [c], props: { p_status: "st_done" } });
  const d = m.add({ title: "D", type: SYS.task, parents: [p], props: { p_status: "st_todo" } });
  m.add({ title: "D1", type: SYS.task, parents: [d], props: { p_status: "st_todo" } });
  const run = (q: string) => {
    const ix = m.index();
    return runQuery(parseQuery(q, ix).def, { ix }).items.map((i) => i.title).sort();
  };
  expect(run("blockiert")).toEqual(["B", "C"]);
  expect(run("blocked")).toEqual(["B", "C"]);
  expect(run("typ:Task -blockiert ohne:offene-kinder status:offen")).toEqual(["A", "D1"]);
  expect(run("type:Task without:open-children")).toEqual(["A", "C", "C1", "D1"].concat(["B"]).sort());
  // the blocker is done: B is free again
  m.change(a, (doc) => doc.getMap("props").set("p_status", "st_done"));
  expect(run("blockiert")).toEqual(["C"]);
  // printed back in either language
  const ix = m.index();
  expect(printQuery(parseQuery("blockiert ohne:offene-kinder", ix).def, "en", ix)).toBe("blocked without:open-children");
});

test("Wartet auf is added to existing default types once; nothing else changes", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  // an existing setup from before: the task type without "Wartet auf"
  m.change(SYS.task, (doc) => (doc.getMap<any>("schema").get("properties") as any).delete("p_waiting"));
  expect(m.get(SYS.task)!.schema!.properties.some((p) => p.id === "p_waiting")).toBe(false);
  expect(addLaterDefaultProps(m.writer, "de")).toEqual([SYS.task]);
  const props = m.get(SYS.task)!.schema!.properties;
  expect(props.at(-1)!).toMatchObject({ id: "p_waiting", name: "Wartet auf", kind: "text" });
  expect(addLaterDefaultProps(m.writer, "de")).toEqual([]);
  // removed by the user: stays removed
  m.change(SYS.task, (doc) => removeProp(doc, "p_waiting"));
  expect(addLaterDefaultProps(m.writer, "de")).toEqual([]);
});

test("the inverse of Blockiert durch is renamed only while it carries the old shipped name", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  const inv = () => m.get(SYS.task)!.schema!.properties.find((p) => p.id === "p_blocked")!.inverseName;
  expect(inv()).toBe("Blockiert diese");
  m.change(SYS.task, (d) => ((d.getMap<any>("schema").get("properties") as any).get("p_blocked") as any).set("inverseName", "Blockiert"));
  expect(renameShippedLabels(m.writer, "de")).toBe(1);
  expect(inv()).toBe("Blockiert diese");
  m.change(SYS.task, (d) => ((d.getMap<any>("schema").get("properties") as any).get("p_blocked") as any).set("inverseName", "Hält auf"));
  expect(renameShippedLabels(m.writer, "de")).toBe(0);
  expect(inv()).toBe("Hält auf");
});

test("files under a project: below it, or used in an entry below it (embedded, linked, ref)", () => {
  const m = new MemRepo();
  const proj = m.add({ title: "Projekt" });
  const note = m.add({ title: "Meeting", parents: [proj], body: "Siehe ![[spec.pdf]] und [[plan.pdf]]." });
  m.add({ kind: "datei", title: "spec.pdf" }); // no place of its own: embedded in the meeting
  m.add({ kind: "datei", title: "plan.pdf", parents: [m.add({ title: "Ablage" })] }); // placed elsewhere, linked in the meeting
  m.add({ kind: "datei", title: "direkt.pdf", parents: [proj] });
  m.add({ kind: "datei", title: "fremd.pdf" });
  const r = m.add({ kind: "datei", title: "ref.pdf" });
  m.change(note, (d) => setMember(d, "refs", r, true));
  const ix = m.index();
  const titles = runQuery(parseQuery("datei unter:[[Projekt]]", ix).def, { ix }).items.map((i) => i.title).sort();
  expect(titles).toEqual(["direkt.pdf", "plan.pdf", "ref.pdf", "spec.pdf"]);
  // in: (directly below) stays strict
  expect(runQuery(parseQuery("datei in:[[Projekt]]", ix).def, { ix }).items.map((i) => i.title)).toEqual(["direkt.pdf"]);
});
