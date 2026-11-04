import { test, expect, beforeEach, afterAll } from "bun:test";
import { removeTempDirs } from "../support/helpers";
import { setupStore } from "../support/store";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import type { Store } from "@obtion/server/store";
import { type Ops, OpError } from "@obtion/server/ops";
import { Mirror } from "@obtion/server/mirror";
import { SYS } from "@obtion/core/setup";
import { storeWriter } from "@obtion/server/setup";
import { replaceBody, addDaysISO, todayISO, addParent, setExtra } from "@obtion/core/model";
import { deleteItem } from "@obtion/core/trash";

afterAll(removeTempDirs);

let dir: string;
let s: Store;
let ops: Ops;
const A = "agent:test";
beforeEach(() => ({ dir, s, ops } = setupStore("obtion-ops-")));

test("progress report: status, update and follow-up task, all through names", () => {
  const p = ops.create({ title: "Nordlicht · Frankreich", type: "Projekt", properties: { Status: "Planung" } }, A);
  const t = ops.create({ title: "Mapping", type: "Task", parents: ["Nordlicht · Frankreich"] }, A);
  // "Nordlicht: Mapping fertig, Review am Freitag"
  ops.update("Mapping", { properties: { Status: "erledigt" } }, A);
  ops.addUpdate("Nordlicht", "Mapping fertig, Review am Freitag", "In Bearbeitung", "test", A);
  ops.create({ title: "Review", type: "Task", parents: [p.id], properties: { Fällig: "2026-10-30" } }, A);
  const got = ops.get(p.id) as any;
  expect(got.status).toBe("In Bearbeitung (active)");
  expect(got.updates[0].text).toBe("Mapping fertig, Review am Freitag");
  expect(got.progress).toBe("1/2 done");
  expect(ops.get(t.id).status).toBe("Erledigt (done)");
  const q = ops.query("typ:Task status:offen unter:[[Nordlicht · Frankreich]]");
  expect(q.items.map((i) => i.title)).toEqual(["Review"]);
  expect(ops.line(q.items[0]!)).toContain("due 2026-10-30");
});

test("errors are helpful: unknown property, option, type, ambiguous title, cycles", () => {
  ops.create({ title: "P", type: "Projekt" }, A);
  expect(() => ops.create({ title: "x", type: "Projekt", properties: { Farbe: "rot" } }, A)).toThrow(/Unknown property "Farbe".*Status/);
  expect(() => ops.create({ title: "x", type: "Projekt", properties: { Status: "Lila" } }, A)).toThrow(/Options: Backlog \(todo\)/);
  expect(() => ops.create({ title: "x", type: "Buch" }, A)).toThrow(/Unknown type "Buch"/);
  ops.create({ title: "Meeting" }, A);
  ops.create({ title: "Meeting" }, A);
  expect(() => ops.resolve("Meeting")).toThrow(/Several items/);
  const a = ops.create({ title: "A", type: "Karte" }, A);
  ops.create({ title: "B", type: "Karte", parents: [a.id] }, A);
  expect(() => ops.place(a.id, { add: ["B"] }, A)).toThrow(/cycle/);
});

test("free properties are only read and removed, never added", () => {
  const n = ops.create({ title: "Kurs", properties: {} }, A);
  s.change(n.id, A, (doc) => (setExtra(doc, "ECTS", { k: "number", v: 6 }), setExtra(doc, "Note", { k: "number", v: 1.7 })));
  s.flush();
  expect((ops.get(n.id) as any).free_properties).toEqual({ ECTS: 6, Note: 1.7 });
  ops.update(n.id, { free_properties_remove: ["ects"] }, A);
  expect((ops.get(n.id) as any).free_properties).toEqual({ Note: 1.7 });
  // without a type there is nowhere to put a new property
  expect(() => ops.update(n.id, { properties: { Farbe: "rot" } }, A)).toThrow(/Properties belong to a type/);
});

test("the agent suggests for inbox items instead of sorting them", () => {
  const i = ops.create({ title: "The Art of Doing Science – Hamming" }, A);
  const w = ops.create({ title: "Wissen", type: "Karte" }, A);
  expect(!!ops.place(w.id, { pin: true }, A).now.pinned).toBe(true);
  expect(() => ops.place(i.id, { add: ["Wissen"] }, A)).toThrow(/inbox.*suggest/);
  expect(() => ops.place(i.id, { pin: true }, A)).toThrow(/inbox/);
  expect(() => ops.update(i.id, { type: "Karte" }, A)).toThrow(/inbox/);
  ops.suggest(i.id, { type: "Karte", parents: ["Wissen"], note: "Buch" }, "test", A);
  const it = s.records.get(i.id)!;
  expect(it.suggestion?.type).toBe(SYS.card);
  expect(it.type).toBeNull();
});

test("files never get a type, neither directly nor as a suggestion", () => {
  const f = s.create({ kind: "datei", title: "rechnung.pdf" }, A);
  expect(() => ops.update(f, { type: "Karte" }, A)).toThrow(/file/);
  expect(() => ops.suggest(f, { type: "Karte" }, "test", A)).toThrow(/file/);
  expect(s.records.get(f)!.type).toBeNull();
});

test("a file has exactly one parent: a new place replaces it; MCP refuses a second one and explains", () => {
  const a = ops.create({ title: "Projekt A" }, A).id;
  const b = ops.create({ title: "Projekt B" }, A).id;
  const c = ops.create({ title: "Projekt C" }, A).id;
  const f = s.create({ kind: "datei", title: "skizze.png", parents: [a, b] }, A); // two at once: the last one stays
  expect(s.index().parentsOf(f)).toEqual([b]);
  // the app's "Ort hinzufügen" and Alt-drag go through addParent: the place is replaced, the home follows
  s.change(f, A, (doc) => addParent(doc, c));
  s.flush();
  expect(s.index().parentsOf(f)).toEqual([c]);
  expect(s.index().home(f)).toBe(c);
  // MCP: a second parent is refused with the way to move it
  expect(() => ops.place(f, { add: ["Projekt A"] }, A)).toThrow(/exactly one parent.*remove the current one \("Projekt C"\)/);
  expect(() => ops.place(f, { home: "Projekt A" }, A)).toThrow(/exactly one parent/);
  expect(() => ops.suggest(f, { parents: ["Projekt A", "Projekt B"] }, "test", A)).toThrow(/exactly one parent/);
  expect(s.index().parentsOf(f)).toEqual([c]);
  // moving in one call is fine
  ops.place(f, { add: ["Projekt A"], remove: ["Projekt C"] }, A);
  expect(s.index().parentsOf(f)).toEqual([a]);
  // information keeps any number of parents
  const n = ops.create({ title: "Notiz", parents: ["Projekt A", "Projekt B"] }, A).id;
  ops.place(n, { add: ["Projekt C"] }, A);
  expect(s.index().parentsOf(n).length).toBe(3);
});

test("an agent marks what holds up; the type shows the status groups", () => {
  ops.defineType(
    {
      name: "Schritt",
      properties: [
        { name: "Stand", kind: "status", options: ["Neu (todo)", "Ruht (active)", "Fertig (done)", "Eingestellt (done)"] },
        { name: "Hängt an", kind: "relation", multiple: true, blocks: true },
      ],
    },
    A,
  );
  const a = ops.create({ title: "Kartons", type: "Schritt" }, A);
  const b = ops.create({ title: "Packen", type: "Schritt", properties: { "Hängt an": ["Kartons"] } }, A);
  const ix = s.index();
  expect(ix.isBlocked(ix.get(b.id)!)).toBe(true);
  ops.update("Kartons", { properties: { Stand: "in Arbeit" } }, A); // a synonym finds the group
  expect(ops.get(a.id).status).toBe("Ruht (active)");
  const info = (ops.schema() as any).types.find((x: any) => x.name === "Schritt");
  expect(info.properties.map((p: any) => p.options ?? p.blocks)).toEqual([["Neu (todo)", "Ruht (active)", "Fertig (done)", "Eingestellt (done)"], true]);
  // a type has one status
  expect(() => ops.updateType("Schritt", { add_properties: [{ name: "Zweiter", kind: "status", options: ["A (todo)"] }] }, A)).toThrow(/has a status already/);
});

test("define a type and its views without code, query by type name", () => {
  ops.defineType({ name: "Person", description: "Leute" }, A);
  ops.defineType(
    {
      name: "Buch",
      properties: [
        { name: "Autor", kind: "relation", target: "typ:Person", inverse: "Bücher", multiple: true },
        { name: "Status", kind: "status", options: ["Will lesen (todo)", "Lese (active)", "Gelesen (done)"] },
        { name: "Bewertung", kind: "number" },
      ],
    },
    A,
  );
  ops.create({ title: "Richard Hamming", type: "Person" }, A);
  ops.create({ title: "The Art", type: "Buch", properties: { Autor: ["Richard Hamming"], Bewertung: "5" } }, A);
  ops.create({ title: "Ohne Autor", type: "Buch" }, A);
  ops.updateType("Buch", { views: [{ name: "Ohne Autor", query: "autor:leer", view: "triage" }, { name: "Alle", view: "table" }] }, A);
  const r = ops.query("Bücher");
  expect(r.list).toBe("Bücher");
  expect(r.items.map((i) => i.title)).toEqual(["Ohne Autor"]);
  expect((ops.schema() as any).types.find((x: any) => x.name === "Buch").views.map((v: any) => v.name)).toEqual(["Ohne Autor", "Alle"]);
  const person = ops.get("Richard Hamming") as any;
  expect(person.related_by).toEqual(["Bücher: The Art"]);
  expect((ops.get("The Art") as any).properties).toMatchObject({ Autor: ["Richard Hamming"], Bewertung: 5, Status: "Will lesen" });
  // numbers in plain or German notation
  for (const [raw, n] of [["4.5", 4.5], ["4,5", 4.5], ["1.234,5", 1234.5]] as const) {
    ops.update("The Art", { properties: { Bewertung: raw } }, A);
    expect((ops.get("The Art") as any).properties.Bewertung).toBe(n);
  }
  expect(() => ops.update("The Art", { properties: { Bewertung: "viel" } }, A)).toThrow(/number/);
  ops.update("The Art", { properties: { Bewertung: 5 } }, A);
  expect(ops.convertPreview({ type: "Buch", direction: "type_to_tag" }).would_lose_type).toBe(2);
});

test("one kind of select: several values, a default that keeps it filled, a select turned into the status", () => {
  ops.defineType(
    {
      name: "Artikel",
      properties: [
        { name: "Phase", kind: "select", options: ["Idee", "Entwurf", "Fertig"], default: "Idee" },
        { name: "Kanäle", kind: "select", multiple: true, options: ["Blog", "Newsletter"] },
        { name: "Stand", kind: "select", multiple: true, options: ["A", "B"] },
      ],
    },
    A,
  );
  const info = (ops.schema() as any).types.find((x: any) => x.name === "Artikel");
  expect(info.properties.map((p: any) => [p.name, p.kind, p.multiple ?? false, p.default])).toEqual([
    ["Phase", "select", false, "Idee"],
    ["Kanäle", "select", true, undefined],
    ["Stand", "select", true, undefined],
  ]);
  // new entries get the default; several values take a list
  const a = ops.create({ title: "Erster Artikel", type: "Artikel", properties: { Kanäle: "Blog, Newsletter" } }, A);
  expect((ops.get(a.id) as any).properties).toMatchObject({ Phase: "Idee", Kanäle: "Blog, Newsletter" });
  // with a default it cannot be emptied
  expect(() => ops.update(a.id, { properties: { Phase: null } }, A)).toThrow(/cannot be empty/);
  // a select becomes the status: its options get groups, "done" works
  ops.updateType("Artikel", { change_properties: [{ property: "Phase", kind: "status", options: ["Idee (todo)", "Entwurf (active)", "Fertig (done)"] }] }, A);
  ops.update(a.id, { properties: { Phase: "erledigt" } }, A);
  expect((ops.get(a.id) as any).properties.Phase).toBe("Fertig");
  expect(() => ops.update(a.id, { properties: { Phase: null } }, A)).toThrow(/cannot be empty/);
  // a second status is refused
  expect(() => ops.updateType("Artikel", { change_properties: [{ property: "Kanäle", kind: "status" }] }, A)).toThrow(/has a status already/);
});

test("query blocks written by an agent in text form are stored as JSON and read back as text", () => {
  const o = ops.create({ title: "Arbeit", body: "Projekte:\n\n```abfrage typ:Projekt unter:diese```" }, A);
  expect(s.records.get(o.id)!.body).toContain('"type":"sys:project"');
  expect((ops.get(o.id) as any).body).toContain("typ:Projekt unter:diese");
});

test("markdown mirror writes items below their home and removes stale files", () => {
  const m = new Mirror(s, join(dir, "vault"));
  const a = ops.create({ title: "Arbeit", pin: true }, A);
  const p = ops.create({ title: "Relaunch", type: "Projekt", parents: [a.id], properties: { Status: "In Bearbeitung" } }, A);
  ops.create({ title: "Idee" }, A);
  m.sync();
  const f = join(dir, "vault", "Arbeit", "Relaunch.md");
  expect(readFileSync(f, "utf8")).toContain("Status:\n  - In Bearbeitung");
  expect(existsSync(join(dir, "vault", "Eingang", "Idee.md"))).toBe(true);
  ops.update(p.id, { title: "Relaunch 2026" }, A);
  m.sync();
  expect(existsSync(f)).toBe(false);
  expect(existsSync(join(dir, "vault", "Arbeit", "Relaunch 2026.md"))).toBe(true);
});

test("agent edits see text typed moments ago", () => {
  const n = ops.create({ title: "Typing", body: "hello world" }, A);
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(s.getDoc(n.id)));
  const sv = Y.encodeStateVector(client);
  client.transact(() => replaceBody(client, "hello world and more typing"));
  s.applyRemote(n.id, Y.encodeStateAsUpdate(client, sv), "web:test");
  ops.update(n.id, { old_text: "hello", new_text: "HELLO" }, A);
  expect(s.records.get(n.id)!.body).toBe("HELLO world and more typing");
  expect(() => ops.update(n.id, { old_text: "nope", new_text: "x" }, A)).toThrow(OpError);
});

test("delete asks what happens to children that hang only below; restore brings them back", () => {
  const p = ops.create({ title: "Website", type: "Projekt" }, A);
  ops.create({ title: "Navbar", type: "Task", parents: ["Website"] }, A);
  expect(() => ops.remove(p.id, undefined, A)).toThrow(/children/);
  expect(s.records.get(p.id)!.deleted).toBe(false);
  expect(ops.remove(p.id, "trash", A).only).toBe(1);
  expect(s.index().get(p.id)).toBeUndefined();
  expect(s.index().resolveTitle("Navbar")).toBeUndefined();
  expect(ops.restore("Website", A).back).toBe(1);
  expect(s.index().resolveTitle("Navbar")).toBeDefined();
});

test("types are never deleted or changed through the item tools; only update_type previews", () => {
  ops.create({ title: "Website", type: "Projekt", properties: { Status: "aktiv" } }, A);
  const seq = s.seq;
  for (const ref of [SYS.project, SYS.task, SYS.card]) {
    expect(() => ops.remove(ref, undefined, A)).toThrow(/update_type with delete_preview/);
    expect(() => ops.remove(ref, "trash", A)).toThrow(/is a type/);
    expect(() => ops.update(ref, { title: "Weg", type: null }, A)).toThrow(/update_type/);
    expect(() => ops.place(ref, { pin: true }, A)).toThrow(/update_type/);
    expect(() => ops.suggest(ref, { note: "x" }, A, A)).toThrow(/update_type/);
  }
  expect(s.seq).toBe(seq); // nothing written
  expect(s.index().types.size).toBe(3);
  expect(s.index().get(s.index().resolveTitle("Website")!)!.type).toBe(SYS.project);
  const preview = ops.deletePreview("Projekt");
  expect(preview.entries).toBe(1);
  expect(s.index().types.has(SYS.project)).toBe(true);
  // the shared trash refuses a type as well; the app deletes types through deleteType
  expect(() => deleteItem(storeWriter(s, A), s.index(), SYS.task)).toThrow(/type page/);
});

test("erledigt am: set when the status enters done, kept between done options, cleared on reopen", () => {
  ops.create({ title: "Mapping", type: "Task" }, A);
  const get = () => s.records.get(s.index().resolveTitle("Mapping")!)!;
  expect(get().doneAt).toBeUndefined();
  ops.update("Mapping", { properties: { Status: "Erledigt" } }, A);
  const first = get().doneAt!;
  expect(first).toBeGreaterThan(Date.now() - 5000);
  ops.update("Mapping", { properties: { Status: "Verworfen" } }, A);
  expect(get().doneAt).toBe(first);
  ops.update("Mapping", { properties: { Status: "In Bearbeitung" } }, A);
  expect(get().doneAt).toBeUndefined();
  ops.setStatusGroup(["Mapping"], "done", A);
  expect(get().doneAt).toBeDefined();
  const q = (text: string) => ops.query(text).items.map((i) => i.title);
  expect(q("erledigt>-7d")).toEqual(["Mapping"]);
  expect(q("done>-7d")).toEqual(["Mapping"]);
  expect(q("erledigt<-7d")).toEqual([]);
});

test("an update with a status change dates the done date with the update", () => {
  const p = ops.create({ title: "Website", type: "Projekt" }, A);
  ops.addUpdate("Website", "Fertig", "Erledigt", "test", A);
  const it = s.records.get(p.id)!;
  expect(it.doneAt).toBe(it.updates.at(-1)!.at);
});

test("tolerant input: plural type names, option synonyms and periods on create", () => {
  const p = ops.create({ title: "Website", type: "Projekte", properties: { Status: "in Arbeit", Priorität: "high", Zeitraum: "1.11.2026/30.11.2026" } }, A);
  const it = s.records.get(p.id)!;
  expect(it.type).toBe(SYS.project);
  expect(it.props).toMatchObject({ p_status: "st_active", p_priority: "pr_high", p_period: "2026-11-01/2026-11-30" });
});

test.each([["fertig", "st_done"], ["Paused", "st_paused"], ["planning", "st_planning"], ["cancelled", "st_canceled"], ["offen", "st_backlog"], ["In Progress", "st_active"]])("tolerant input: status word %p is %p", (word, opt) => {
  const p = ops.create({ title: "Website", type: "Projekt" }, A);
  ops.update(p.id, { properties: { Status: word } }, A);
  expect(s.records.get(p.id)!.props.p_status).toBe(opt);
});

test.each([["10/30/2026", "2026-10-30"], ["30.10.2026", "2026-10-30"], ["2026-10-30T09:00", "2026-10-30"], ["morgen", addDaysISO(1)], ["tomorrow", addDaysISO(1)], ["heute", todayISO()], ["+3d", addDaysISO(3)], ["in 2 Wochen", addDaysISO(14)]])("tolerant input: due date %p is %p", (raw, want) => {
  const t = ops.create({ title: "Review", type: "tasks" }, A);
  ops.update(t.id, { properties: { Fällig: raw } }, A);
  expect(s.records.get(t.id)!.props.p_due).toBe(want);
});

test("tolerant input: weekdays; unclear input is rejected; status groups by word, all or nothing", () => {
  const t = ops.create({ title: "Review", type: "Task" }, A);
  ops.update(t.id, { properties: { Fällig: "Freitag" } }, A);
  const fri = new Date(String(s.records.get(t.id)!.props.p_due) + "T12:00:00");
  expect(fri.getDay()).toBe(5);
  // unclear input is rejected with an explanation, nothing guessed
  expect(() => ops.update(t.id, { properties: { Status: "blockiert" } }, A)).toThrow(/not a status.*Wartet auf/);
  expect(() => ops.update(t.id, { properties: { Fällig: "31.02.2026" } }, A)).toThrow(/needs a date like/);
  expect(() => ops.update(t.id, { properties: { Fällig: "bald" } }, A)).toThrow(/needs a date like/);
  expect(ops.setStatusGroup(["Review"], "erledigt", A)[0]!.props.p_status).toBe("st_done");
  expect(ops.setStatusGroup(["Review"], "Verworfen", A)[0]!.props.p_status).toBe("st_dropped");
  // all or nothing: one unknown item, nothing changes
  expect(() => ops.setStatusGroup(["Review", "Gibt es nicht"], "offen", A)).toThrow(/Gibt es nicht/);
  expect(s.records.get(t.id)!.props.p_status).toBe("st_dropped");
});

test("queries understand status synonyms and dates in other notations", () => {
  ops.create({ title: "Läuft", type: "Task", properties: { Status: "In Bearbeitung", Fällig: "heute" } }, A);
  ops.create({ title: "Neu", type: "Task" }, A);
  const q = (text: string) => ops.query(text).items.map((i) => i.title).sort();
  expect(q("typ:Tasks status:\"in Arbeit\"")).toEqual(["Läuft"]);
  expect(q("type:tasks status:in_progress")).toEqual(["Läuft"]);
  expect(q("typ:Task status:\"nicht begonnen\"")).toEqual(["Neu"]);
  expect(q(`fällig:${todayISO().split("-").reverse().join(".")}`)).toEqual(["Läuft"]);
  expect(q("fällig:heute")).toEqual(["Läuft"]);
  expect(q("status:\"In Progress\"")).toEqual(["Läuft"]);
});

test("the agent sees the inbox rule and a type's list name", () => {
  const sc = ops.schema() as any;
  expect(sc.inbox.query).toContain("ohne:typ");
  ops.updateType("Karte", { plural: "Zettel" }, A);
  expect((ops.schema() as any).types.find((x: any) => x.name === "Karte").list).toBe("Zettel");
});
