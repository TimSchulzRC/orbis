import { test, expect, describe, jest } from "bun:test";
import * as Y from "yjs";
import { MemRepo } from "../support/helpers";
import { type PropDef, type TypeSchema, initSchema, migrateStatus, readSchema } from "@obtion/core/model";
import { initialProps, kindPatch, optionIds, statusProp } from "@obtion/core/traits";
import { addParent, readItem, removeParent, setMeta, setProp, setSettings, initItem, META_TYPE, SETTINGS_ID, touchOnTextEdit } from "@obtion/core/model";
import { keyBetween, keysFor } from "@obtion/core/sortkey";
import { isInInbox, inbox, laterItems, sidebarRoots, sidebarChildren } from "@obtion/core/placement";
import { runSetup, restoreDefaultTypes, resetInbox, SYS } from "@obtion/core/setup";
import { parseQuery, printQuery, runQuery } from "@obtion/core/query";
import { CATALOGS } from "@obtion/core/i18n";
import { setAside, tomorrow } from "@obtion/core/inbox";
import { running, dueBy, recentlyChanged } from "@obtion/core/today";

describe("sort keys", () => {
  test("between always sorts between", () => {
    const ks = keysFor(50);
    for (let i = 1; i < ks.length; i++) expect(ks[i - 1]! < ks[i]!).toBe(true);
    let a = "V";
    let b = "W";
    for (let i = 0; i < 30; i++) {
      const m = keyBetween(a, b);
      expect(a < m && m < b).toBe(true);
      b = m;
    }
    expect(keyBetween(null, "V") < "V").toBe(true);
  });
});

describe("Teil von", () => {
  test("first parent is home; removing it promotes the oldest remaining one", () => {
    const m = new MemRepo();
    const a = m.add({ title: "A" });
    const b = m.add({ title: "B" });
    const c = m.add({ title: "C" });
    const x = m.add({ title: "X" });
    m.change(x, (d) => addParent(d, a, undefined, 1));
    m.change(x, (d) => addParent(d, b, undefined, 2));
    m.change(x, (d) => addParent(d, c, undefined, 3));
    expect(m.get(x)!.home).toBe(a);
    m.change(x, (d) => removeParent(d, a));
    expect(m.get(x)!.home).toBe(b);
    expect(m.index().home(x)).toBe(b);
  });

  test("descendants count once over several ways; relative paths", () => {
    const m = new MemRepo();
    const arbeit = m.add({ title: "Arbeit" });
    const einv = m.add({ title: "Relaunch", parents: [arbeit] });
    const fr = m.add({ title: "Frankreich", parents: [einv] });
    const kunden = m.add({ title: "Kunden", parents: [arbeit] });
    const nord = m.add({ title: "Nordlicht", parents: [kunden] });
    const nordFr = m.add({ title: "Nordlicht · Frankreich", parents: [fr, nord] });
    const task = m.add({ title: "Farben wählen", parents: [nordFr] });
    const ix = m.index();
    expect(ix.descendants(arbeit).size).toBe(6);
    expect([...ix.descendants(arbeit)].filter((x) => x === task).length).toBe(1);
    expect(ix.relPath(einv, task)!.map((id) => ix.get(id)!.title)).toEqual(["Frankreich", "Nordlicht · Frankreich"]);
    expect(ix.relPath(nord, task)!.map((id) => ix.get(id)!.title)).toEqual(["Nordlicht · Frankreich"]);
    expect(ix.relPath(fr, nordFr)).toEqual([]);
    expect(ix.relPath(kunden, einv)).toBeUndefined();
    expect(ix.homePath(task).map((id) => ix.get(id)!.title)).toEqual(["Arbeit", "Relaunch", "Frankreich", "Nordlicht · Frankreich"]);
    expect(ix.wouldCycle(arbeit, task)).toBe(true);
  });

  test("offline cycles resolve deterministically: the edge added last does not count", () => {
    const a = new Y.Doc({ guid: "a" });
    const b = new Y.Doc({ guid: "b" });
    a.transact(() => initItem(a, { title: "A" }));
    b.transact(() => initItem(b, { title: "B" }));
    // laptop: A under B (t=10); phone: B under A (t=20)
    a.transact(() => addParent(a, "b", undefined, 10));
    b.transact(() => addParent(b, "a", undefined, 20));
    const m = new MemRepo();
    m.docs.set("a", a);
    m.docs.set("b", b);
    const ix = m.index();
    expect(ix.parentsOf("a")).toEqual(["b"]);
    expect(ix.parentsOf("b")).toEqual([]);
    expect(ix.cycleEdgesOf("b")).toEqual(["a"]);
  });
});

describe("inbox and sidebar", () => {
  test("inbox = no type and no parent; refs, links and tags do not count", () => {
    const m = new MemRepo();
    runSetup(m.writer, "de");
    const p = m.add({ title: "Nordlicht · Frankreich", type: SYS.project });
    const loose = m.add({ title: "Idee", body: "siehe [[Nordlicht · Frankreich]]", tags: ["idee"], refs: [p] });
    const note = m.add({ title: "Notiz", parents: [p] });
    const card = m.add({ title: "Karte", type: SYS.card });
    const ix = m.index();
    expect(isInInbox(ix.get(loose)!, ix)).toBe(true);
    expect(isInInbox(ix.get(note)!, ix)).toBe(false);
    expect(isInInbox(ix.get(card)!, ix)).toBe(false);
    expect(isInInbox(ix.get(p)!, ix)).toBe(false);
    // losing the last parent puts a note back into the inbox, also if the parent is deleted
    m.change(p, (d) => setMeta(d, { deleted: true }));
    const ix2 = m.index();
    expect(isInInbox(ix2.get(note)!, ix2)).toBe(true);
  });

  test("files are in the inbox only without parent and without use", () => {
    const m = new MemRepo();
    const f = m.add({ kind: "datei", title: "rechnung.pdf" });
    m.change(f, (d) => d.getMap("file").set("name", "rechnung.pdf"));
    const img = m.add({ kind: "datei", title: "skizze.png" });
    m.change(img, (d) => d.getMap("file").set("name", "skizze.png"));
    m.add({ title: "Notiz", body: "![[skizze.png]]" });
    const ix = m.index();
    expect(isInInbox(ix.get(f)!, ix)).toBe(true);
    expect(isInInbox(ix.get(img)!, ix)).toBe(false);
    expect(ix.usedIn(img).length).toBe(1);
  });

  test("pinned items form the top of the sidebar", () => {
    const m = new MemRepo();
    runSetup(m.writer, "de");
    const arbeit = m.add({ title: "Arbeit", pinned: "V" });
    const gewerbe = m.add({ title: "Gewerbe", pinned: "W" }); // empty, pinned: a place, not in the inbox
    const kunden = m.add({ title: "Kunden", parents: [arbeit] });
    const open = m.add({ title: "Offen", type: SYS.project, parents: [arbeit], props: { p_status: "st_active" } });
    const done = m.add({ title: "Fertig", type: SYS.project, parents: [arbeit], props: { p_status: "st_done" } });
    const card = m.add({ title: "Lose Karte", type: SYS.card, parents: [arbeit] });
    const steuer = m.add({ title: "Steuererklärung 2025", type: SYS.project, parents: [kunden], pinned: "X" });
    const ix = m.index();
    expect(sidebarRoots(ix).map((i) => i.title)).toEqual(["Arbeit", "Gewerbe", "Steuererklärung 2025"]);
    expect(isInInbox(ix.get(gewerbe)!, ix)).toBe(false);
    // all children, whatever the type; done ones not, except the open page; pinned items also below their parent
    expect(sidebarChildren(arbeit, ix).map((i) => i.id).sort()).toEqual([kunden, open, card].sort());
    expect(sidebarChildren(arbeit, ix, [arbeit, done]).map((i) => i.id)).toContain(done);
    expect(sidebarChildren(kunden, ix).map((i) => i.id)).toEqual([steuer]);
    // a type's page can be pinned too: it joins the top level, in its own order
    m.change(SYS.project, (d) => setMeta(d, { pinned: "Y" }));
    expect(sidebarRoots(m.index()).map((i) => i.title).at(-1)).toBe("Projekt");
  });

  test("a keyword with notes below, not pinned, stays in the inbox as a bundle; pinning places it", () => {
    const m = new MemRepo();
    runSetup(m.writer, "de");
    const kw = m.add({ title: "Blog-Relaunch" });
    m.add({ title: "Notiz 1", parents: [kw] });
    let ix = m.index();
    expect(isInInbox(ix.get(kw)!, ix)).toBe(true);
    m.change(kw, (d) => setMeta(d, { pinned: "V" }));
    ix = m.index();
    expect(isInInbox(ix.get(kw)!, ix)).toBe(false);
    expect(runQuery(parseQuery("angeheftet", ix).def, { ix }).items.map((i) => i.title)).toEqual(["Blog-Relaunch"]);
    expect(printQuery(parseQuery("pinned -inbox", ix).def, "de", ix)).toBe("angeheftet -eingang");
  });
});

describe("the inbox", () => {
  test("follows its stored rule; changing it changes membership everywhere", () => {
    const m = new MemRepo();
    runSetup(m.writer, "de");
    const lone = m.add({ title: "Task ohne Projekt", type: SYS.task });
    const idea = m.add({ title: "Idee" });
    let ix = m.index();
    expect(inbox(ix).map((i) => i.id)).toEqual([idea]);
    // "| typ:Task ohne:eltern" – tasks without a project land in the inbox too
    const { def } = parseQuery("ohne:typ ohne:eltern | datei ohne:eltern ohne:verwendung | typ:Task ohne:eltern", ix);
    m.change(SETTINGS_ID, (d) => setSettings(d, { inbox: def.where! }));
    ix = m.index();
    expect(isInInbox(ix.get(lone)!, ix)).toBe(true);
    expect(runQuery(parseQuery("eingang", ix).def, { ix }).items.length).toBe(2);
    resetInbox(m.writer);
    ix = m.index();
    expect(isInInbox(ix.get(lone)!, ix)).toBe(false);
  });

  test("a rule that names the inbox itself does not loop", () => {
    const m = new MemRepo();
    runSetup(m.writer, "en");
    m.add({ title: "Book", tags: ["book"] });
    m.change(SETTINGS_ID, (d) => setSettings(d, { inbox: { or: [{ tag: "book" }, { inbox: true }] } }));
    const ix = m.index();
    expect(runQuery(parseQuery("inbox", ix).def, { ix }).items.map((i) => i.title)).toEqual(["Book"]);
  });
});

describe("set aside", () => {
  test("pinned leaves the inbox, later until its time – whatever the rule says", () => {
    const m = new MemRepo();
    runSetup(m.writer, "de");
    const pinned = m.add({ title: "Gedanke" });
    const later = m.add({ title: "Morgen" });
    const back = m.add({ title: "Wieder da" });
    m.change(pinned, (d) => setMeta(d, { pinned: "a0" }));
    m.change(later, (d) => setMeta(d, { later: Date.now() + 60_000 }));
    m.change(back, (d) => setMeta(d, { later: Date.now() - 1 }));
    // a rule that would take them all: set aside still wins
    m.change(SETTINGS_ID, (d) => setSettings(d, { inbox: { or: [{ without: "type" }] } }));
    const ix = m.index();
    expect(inbox(ix).map((i) => i.title).sort()).toEqual(["Wieder da"]);
    expect(runQuery(parseQuery("eingang", ix).def, { ix }).items.map((i) => i.title).sort()).toEqual(["Wieder da"]);
    expect(setAside(ix.get(later)!, Date.now() + 120_000)).toBe(false);
    // "Morgen wieder" in the panel: what the rule takes and waits, not the pinned one
    expect(laterItems(ix).map((i) => i.title)).toEqual(["Morgen"]);
    // unpinned: back in the inbox
    m.change(pinned, (d) => setMeta(d, { pinned: null }));
    expect(isInInbox(m.index().get(pinned)!, m.index())).toBe(true);
  });

  test("tomorrow is the next local midnight", () => {
    const at = new Date(2026, 9, 29, 23, 40);
    expect(tomorrow(at)).toBe(new Date(2026, 9, 30).getTime());
  });
});

describe("today", () => {
  test("due by today, active projects with their last change, changed last without the inbox", () => {
    const m = new MemRepo();
    runSetup(m.writer, "de");
    const relaunch = m.add({ title: "Relaunch", type: SYS.project, props: { p_status: "st_active" }, updated: 100 });
    const closed = m.add({ title: "Abgeschlossen", type: SYS.project, props: { p_status: "st_done" } });
    m.add({ title: "Unterprojekt", type: SYS.project, props: { p_status: "st_active" }, parents: [relaunch] });
    m.add({ title: "Überfällig", type: SYS.task, props: { p_due: "2026-10-27" }, parents: [relaunch], updated: 500 });
    m.add({ title: "Heute", type: SYS.task, props: { p_due: "2026-10-29" } });
    m.add({ title: "Erledigt", type: SYS.task, props: { p_due: "2026-10-28", p_status: "st_done" } });
    m.add({ title: "Morgen", type: SYS.task, props: { p_due: "2026-10-30" } });
    m.add({ title: "Im abgeschlossenen", type: SYS.task, props: { p_due: "2026-10-01" }, parents: [closed] });
    m.add({ title: "Lose Idee", updated: 900 });
    const ix = m.index();
    expect(dueBy(ix, "2026-10-29").map((x) => x.item.title)).toEqual(["Überfällig", "Heute"]);
    const active = running(ix);
    expect(active.map((x) => x.item.title)).toEqual(["Relaunch"]);
    expect(active[0]!.touched).toBeGreaterThanOrEqual(500);
    expect(recentlyChanged(ix, 50).some((i) => i.title === "Lose Idee")).toBe(false);
  });
});

describe("zero types", () => {
  test("the model works without any type", () => {
    const m = new MemRepo();
    const a = m.add({ title: "A" });
    const b = m.add({ title: "B", parents: [a], body: "[[A]]" });
    const ix = m.index();
    expect(inbox(ix).map((i) => i.id)).toEqual([a]);
    expect(ix.backlinks(a).map((x) => x.from)).toEqual([b]);
    expect(sidebarRoots(ix)).toEqual([]);
    expect(ix.progress(a)).toEqual({ done: 0, total: 0 });
  });

  test("default types can be deleted and restored", () => {
    const m = new MemRepo();
    runSetup(m.writer, "en");
    expect(m.get(SYS.task)!.schema!.name).toBe("Task");
    expect(m.get(SYS.card)!.schema!.name).toBe("Card");
    expect(m.index().types.size).toBe(3); // Karte, Projekt, Task
    m.change(SYS.task, (d) => setMeta(d, { deleted: true }));
    expect(m.index().types.has(SYS.task)).toBe(false);
    expect(restoreDefaultTypes(m.writer, "en")).toEqual([SYS.task]);
    expect(m.index().types.has(SYS.task)).toBe(true);
  });
});

describe("progress", () => {
  test("counts done descendants with a status, filter optional and survives type deletion", () => {
    const m = new MemRepo();
    runSetup(m.writer, "de");
    const p = m.add({ title: "Relaunch", type: SYS.project, props: { p_status: "st_active" } });
    const sub = m.add({ title: "Frankreich", type: SYS.project, parents: [p], props: { p_status: "st_active" } });
    m.add({ title: "T1", type: SYS.task, parents: [sub], props: { p_status: "st_done" } });
    const t2 = m.add({ title: "T2", type: SYS.task, parents: [sub], props: { p_status: "st_todo" } });
    m.add({ title: "Unteraufgabe", type: SYS.task, parents: [t2], props: { p_status: "st_done" } });
    m.add({ title: "Notiz", parents: [p] });
    let ix = m.index();
    expect(ix.progressOf(ix.get(p)!)).toEqual({ done: 2, total: 3 });
    expect(ix.progress(p)).toEqual({ done: 2, total: 4 }); // without filter the sub-project counts too
    expect(ix.progressOf(ix.get(t2)!)).toEqual({ done: 1, total: 1 });
    m.change(SYS.task, (d) => setMeta(d, { deleted: true }));
    ix = m.index();
    // filter on a deleted type is ignored; tasks have no status any more (type gone), the sub-project still has one
    expect(ix.progressOf(ix.get(p)!)).toEqual({ done: 0, total: 1 });
  });
});

describe("i18n", () => {
  test("every key exists in every catalog", () => {
    const keys = new Set(Object.values(CATALOGS).flatMap((c) => Object.keys(c)));
    for (const [lang, cat] of Object.entries(CATALOGS)) {
      const missing = [...keys].filter((k) => !(k in cat));
      expect({ lang, missing }).toEqual({ lang, missing: [] });
    }
  });
});

test("readItem ignores uninitialised and legacy documents", () => {
  const d = new Y.Doc();
  expect(readItem("x", d)).toBeNull();
  d.getMap("meta").set("type", "x"); // no kind: not an Obtion document
  expect(readItem("x", d)).toBeNull();
  d.transact(() => initItem(d, { title: "x", type: META_TYPE }));
  expect(readItem("x", d)!.schema).toBeDefined();
  d.transact(() => setProp(d, "p", ""));
  expect(readItem("x", d)!.props).toEqual({});
});

test("typing moves the change time: local text edits touch meta.updated, edits from elsewhere don't", () => {
  jest.useFakeTimers();
  try {
    const doc = new Y.Doc();
    initItem(doc, { title: "Notiz", body: "Alt", created: 1000, updated: 1000 });
    let now = 50_000;
    const stop = touchOnTextEdit(doc, 3000, () => now);
    const updated = () => doc.getMap<any>("meta").get("updated");
    doc.getText("body").insert(3, " und neu"); // typed here
    jest.advanceTimersByTime(0);
    expect(updated()).toBe(50_000);
    // a burst: the next stamp waits for the window, then the last edit counts
    now = 51_000;
    doc.getText("body").insert(0, "x");
    jest.advanceTimersByTime(1999);
    expect(updated()).toBe(50_000);
    now = 53_000;
    jest.advanceTimersByTime(1);
    expect(updated()).toBe(53_000);
    // an edit that arrives from another device brings its own time
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    other.getText("body").insert(0, "y");
    now = 90_000;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
    jest.advanceTimersByTime(3000);
    expect(updated()).toBe(53_000);
    stop();
  } finally {
    jest.useRealTimers();
  }
});

describe("selects", () => {
  test("schemas stored with the kinds status and multiselect: the first status stays one, the rest are selects", () => {
    const d = new Y.Doc();
    initSchema(d, {
      name: "Alt",
      icon: "box",
      color: "gray",
      description: "",
      capabilities: {},
      properties: [
        { id: "p_st", name: "Status", kind: "status", options: [{ id: "a", name: "Offen", group: "todo" }, { id: "b", name: "Fertig", group: "done" }] },
        { id: "p_ms", name: "Tags", kind: "multiselect" as any, options: [{ id: "x", name: "X" }] },
        { id: "p_old", name: "Zweiter Status", kind: "status", options: [{ id: "c", name: "C", group: "todo" }] },
      ],
    });
    const s = readSchema(d);
    expect(s.properties.map((p) => [p.id, p.kind, !!p.multiple, p.default])).toEqual([
      ["p_st", "status", false, "a"],
      ["p_ms", "select", true, undefined],
      // a type has one status: a plain select that may be empty
      ["p_old", "select", false, undefined],
    ]);
    expect(statusProp(s)?.id).toBe("p_st");
    expect(initialProps(s)).toEqual({ p_st: "a" });
  });

  test("a select with a default fills new items; the status always starts filled", () => {
    const s = { name: "T", icon: "box", color: "gray", description: "", capabilities: {}, removedProperties: [], properties: [
      { id: "p_st", name: "Status", kind: "status", options: [{ id: "a", name: "Offen", group: "todo" }] },
      { id: "p_pr", name: "Prio", kind: "select", default: "m", options: [{ id: "h", name: "Hoch" }, { id: "m", name: "Mittel" }] },
      { id: "p_x", name: "Leer", kind: "select", options: [{ id: "q", name: "Q" }] },
      { id: "p_many", name: "Viele", kind: "select", multiple: true, default: "z", options: [{ id: "z", name: "Z" }], sort: "D" },
    ] } as TypeSchema;
    expect(initialProps(s)).toEqual({ p_st: "a", p_pr: "m" });
    expect(optionIds("a")).toEqual(["a"]);
    expect(optionIds(["a", "b"])).toEqual(["a", "b"]);
    expect(optionIds(undefined)).toEqual([]);
  });

  test("a type's former status capability on a select reads as kind status and migrates without loss", () => {
    const d = new Y.Doc();
    initSchema(d, {
      name: "Alt",
      icon: "box",
      color: "gray",
      description: "",
      capabilities: { status: "p_st", due: "p_due" } as any,
      properties: [
        { id: "p_old", name: "Alter Status", kind: "status", options: [{ id: "c", name: "C", group: "todo" }] },
        { id: "p_st", name: "Stand", kind: "select", options: [{ id: "a", name: "Neu", group: "todo" }, { id: "p", name: "Ruht", group: "active", state: "paused" }, { id: "x", name: "Verworfen", group: "done", state: "dropped" }, { id: "n" as string, name: "Ohne" }] as any },
        { id: "p_due", name: "Termin", kind: "date" },
      ],
    });
    const before = readSchema(d);
    // readers understand the old shape before the migration ran
    expect(statusProp(before)?.id).toBe("p_st");
    expect(before.properties.map((p) => p.kind)).toEqual(["select", "status", "date"]);
    expect(before.capabilities).toEqual({ due: "p_due" });
    expect(statusProp(before)?.options).toEqual([
      { id: "a", name: "Neu", group: "todo" },
      { id: "p", name: "Ruht", group: "active" },
      { id: "x", name: "Verworfen", group: "done" },
      { id: "n", name: "Ohne", group: "todo" },
    ]);
    expect(statusProp(before)?.default).toBe("a");
    expect(migrateStatus(d)).toBe(true);
    const caps = d.getMap("schema").get("capabilities") as Y.Map<unknown>;
    expect(caps.has("status")).toBe(false);
    const stored = (d.getMap("schema").get("properties") as Y.Map<Y.Map<unknown>>);
    expect(stored.get("p_st")!.get("kind")).toBe("status");
    expect(stored.get("p_old")!.get("kind")).toBe("select");
    expect(JSON.stringify(stored.get("p_st")!.get("options"))).not.toContain("state");
    expect(readSchema(d)).toEqual(before);
    expect(migrateStatus(d)).toBe(false); // idempotent
    expect(readSchema(d)).toEqual(before);
  });

  test("changing a property's kind into and out of the status", () => {
    const sel: PropDef = { id: "p", name: "Phase", kind: "select", sort: "V", options: [{ id: "a", name: "Idee" }, { id: "b", name: "Fertig" }] };
    const toStatus = kindPatch(sel, "status");
    expect(toStatus).toEqual({ kind: "status", multiple: null, options: [{ id: "a", name: "Idee", group: "todo" }, { id: "b", name: "Fertig", group: "todo" }], default: "a" });
    expect(kindPatch({ options: [] }, "status", [{ id: "f", name: "Offen", group: "todo" }]).options).toEqual([{ id: "f", name: "Offen", group: "todo" }]);
    expect(kindPatch({ options: toStatus.options! }, "select").options).toEqual(sel.options);
  });
});

describe("link targets", () => {
  test("a link is written by title only when the title leads to that entry alone", () => {
    const m = new MemRepo();
    const work = m.add({ title: "Arbeit" });
    const home = m.add({ title: "Privat" });
    const a = m.add({ title: "Notizen", parents: [work] });
    const b = m.add({ title: "notizen ", parents: [home] });
    const single = m.add({ title: "Einzeln" });
    const odd = m.add({ title: "C# Tipps" });
    const ix = m.index();
    expect(ix.linkTarget(ix.get(single)!)).toBe("Einzeln");
    expect(ix.linkTarget(ix.get(a)!), "two entries with one title: by id").toBe(a);
    expect(ix.linkTarget(ix.get(b)!)).toBe(b);
    expect(ix.linkTarget(ix.get(odd)!), "a # can't be in a link by name").toBe(odd);
    for (const id of [a, b]) expect(ix.resolveTitle(ix.linkTarget(ix.get(id)!))).toBe(id);
  });
});
