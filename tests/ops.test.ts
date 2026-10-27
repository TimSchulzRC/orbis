import { test, expect, beforeEach, afterAll } from "bun:test";
import { tempDir, removeTempDirs } from "./helpers";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { Store } from "../src/server/store";
import { Ops, OpError } from "../src/server/ops";
import { Mirror } from "../src/server/mirror";
import { runSetup, SYS } from "../src/shared/setup";
import { storeWriter } from "../src/server/importers";
import { initItem, replaceBody, addDaysISO, todayISO, addParent } from "../src/shared/model";
import { deleteItem } from "../src/shared/trash";

afterAll(removeTempDirs);

let dir: string;
let s: Store;
let ops: Ops;
const A = "agent:test";
beforeEach(() => {
  dir = tempDir("obtion-ops-");
  s = new Store(dir);
  runSetup(storeWriter(s, "system:setup"), "de");
  s.flush();
  ops = new Ops(s);
});

test("hub persists remote updates and reloads them; duplicates are idempotent", () => {
  const client = new Y.Doc({ guid: "a" });
  client.transact(() => initItem(client, { title: "Hello", body: "world" }));
  const u = Y.encodeStateAsUpdate(client);
  const first = s.applyRemote("a", u, "web:test");
  expect(s.applyRemote("a", u, "web:test")).toBe(first);
  s.flush();
  const s2 = new Store(dir);
  expect(s2.records.get("a")?.body).toBe("world");
});

test("progress report: status, update and follow-up task, all through names", () => {
  const [p] = [ops.create({ title: "Nordlicht · Frankreich", type: "Projekt", properties: { Status: "Planung" } }, A)];
  const [t] = [ops.create({ title: "Mapping", type: "Task", parents: ["Nordlicht · Frankreich"] }, A)];
  // "Nordlicht: Mapping fertig, Review am Freitag"
  ops.update("Mapping", { properties: { Status: "erledigt" } }, A);
  ops.addUpdate("Nordlicht", "Mapping fertig, Review am Freitag", "In Bearbeitung", "test", A);
  ops.create({ title: "Review", type: "Task", parents: [p!.id], properties: { Fällig: "2026-10-30" } }, A);
  const got = ops.get(p!.id) as any;
  expect(got.status).toBe("In Bearbeitung (active)");
  expect(got.updates[0].text).toBe("Mapping fertig, Review am Freitag");
  expect(got.progress).toBe("1/2 done");
  expect(ops.get(t!.id).status).toBe("Erledigt (done)");
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

test("the agent suggests for inbox items instead of sorting them", () => {
  const i = ops.create({ title: "The Art of Doing Science – Hamming" }, A);
  const w = ops.create({ title: "Wissen", type: "Karte" }, A);
  expect(!!ops.place(w.id, { pin: true }, A).now.pinned).toBe(true);
  expect(() => ops.place(i.id, { add: ["Wissen"] }, A)).toThrow(/inbox.*suggest/);
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
      capabilities: { status: "Status" },
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
  expect(ops.convertPreview({ type: "Buch", direction: "type_to_tag" }).would_lose_type).toBe(2);
});

test("query blocks written by an agent in text form are stored as JSON and read back as text", () => {
  const o = ops.create({ title: "Arbeit", body: "Projekte:\n\n```abfrage typ:Projekt unter:diese```" }, A);
  expect(s.records.get(o.id)!.body).toContain('"type":"sys:project"');
  expect((ops.get(o.id) as any).body).toContain("typ:Projekt unter:diese");
});

test("markdown mirror writes items below their home and removes stale files", () => {
  const m = new Mirror(s, join(dir, "vault"));
  const a = ops.create({ title: "Arbeit", pin: true }, A);
  expect(() => ops.place(ops.create({ title: "Lose" }, A).id, { pin: true }, A)).toThrow(/inbox/);
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
  const preview = ops.updateType("Projekt", { delete_preview: true }, A) as any;
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

test("tolerant input: status words and synonyms in both languages, dates DE/EN/US, plural type names", () => {
  const p = ops.create({ title: "Website", type: "Projekte", properties: { Status: "in Arbeit", Priorität: "high", Zeitraum: "1.11.2026/30.11.2026" } }, A);
  const it = () => s.records.get(p.id)!;
  expect(it().type).toBe(SYS.project);
  expect(it().props).toMatchObject({ p_status: "st_active", p_priority: "pr_high", p_period: "2026-11-01/2026-11-30" });
  for (const [word, opt] of [["fertig", "st_done"], ["Paused", "st_paused"], ["planning", "st_planning"], ["cancelled", "st_canceled"], ["offen", "st_backlog"], ["In Progress", "st_active"]] as const) {
    ops.update(p.id, { properties: { Status: word } }, A);
    expect([word, it().props.p_status]).toEqual([word, opt]);
  }
  const t = ops.create({ title: "Review", type: "tasks", parents: ["Website"], properties: { Fällig: "10/30/2026" } }, A);
  expect(s.records.get(t.id)!.props.p_due).toBe("2026-10-30");
  for (const [raw, want] of [["30.10.2026", "2026-10-30"], ["2026-10-30T09:00", "2026-10-30"], ["morgen", addDaysISO(1)], ["tomorrow", addDaysISO(1)], ["heute", todayISO()], ["+3d", addDaysISO(3)], ["in 2 Wochen", addDaysISO(14)]] as const) {
    ops.update(t.id, { properties: { Fällig: raw } }, A);
    expect([raw, s.records.get(t.id)!.props.p_due]).toEqual([raw, want]);
  }
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

test("the agent sees the inbox rule and a type's list name; no collections", () => {
  const sc = ops.schema() as any;
  expect(sc.collections).toBeUndefined();
  expect(sc.inbox.query).toContain("ohne:typ");
  ops.updateType("Karte", { plural: "Zettel" }, A);
  expect((ops.schema() as any).types.find((x: any) => x.name === "Karte").list).toBe("Zettel");
});
