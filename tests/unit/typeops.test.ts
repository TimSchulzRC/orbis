import { test, expect } from "bun:test";
import { MemRepo } from "../support/helpers";
import { runSetup, SYS } from "@obtion/core/setup";
import { type PropKind, setProp } from "@obtion/core/model";
import { deleteType, previewTagToType, tagToType, typeUsage, wouldBeInInbox } from "@obtion/core/typeops";
import { isInInbox } from "@obtion/core/placement";
import { visibleProps } from "@obtion/core/traits";

function books() {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  m.addType("t_person", { name: "Person", icon: "user", color: "pink" });
  m.addType("t_buch", {
    name: "Buch",
    icon: "book",
    color: "brown",
    // stored as before 30.10.2026 ("status"): readSchema reads it as the select it is now
    capabilities: { status: "p_lese" },
    properties: [
      { id: "p_autor", name: "Autor", kind: "relation", target: "typ:Person", inverseName: "Bücher", multiple: true },
      { id: "p_lese", name: "Status", kind: "status" as PropKind, options: [{ id: "o1", name: "Will lesen", group: "todo" }, { id: "o2", name: "Gelesen", group: "done" }] },
      { id: "p_bew", name: "Bewertung", kind: "number" },
    ],
  });
  const hamming = m.add({ title: "Richard Hamming", type: "t_person" });
  const b1 = m.add({ title: "The Art of Doing Science", type: "t_buch", rels: { p_autor: [hamming] }, props: { p_lese: "o2", p_bew: 5 } });
  const b2 = m.add({ title: "Ohne Ort", type: "t_buch" });
  const proj = m.add({ title: "Lesen 2026", pinned: "V" });
  m.add({ title: "Liste", body: "```abfrage typ:Buch```", parents: [proj] });
  return { m, hamming, b1, b2 };
}

test("delete a type into a tag: values become free properties, relations refs", () => {
  const { m, hamming, b1, b2 } = books();
  let ix = m.index();
  const u = typeUsage(ix, "t_buch");
  expect(u.items.length).toBe(2);
  expect(u.inboxAfterRemove).toBe(2);
  deleteType(m.writer, ix, "t_buch", { mode: "tag", tag: "buch" }, "Buch → #buch");
  ix = m.index();
  const book = ix.get(b1)!;
  expect(book.type).toBeNull();
  expect(book.tags).toEqual(["buch"]);
  expect(book.extra).toEqual({ Status: { k: "select", v: "Gelesen" }, Bewertung: { k: "number", v: 5 } });
  expect(book.refs).toEqual([hamming]);
  expect(isInInbox(ix.get(b2)!, ix)).toBe(true);
  expect(ix.types.has("t_buch")).toBe(false);
});

test("convert a type into another type maps same-named properties", () => {
  const { m, b1 } = books();
  const op = deleteType(m.writer, m.index(), "t_buch", { mode: "type", target: SYS.card }, "Buch → Karte");
  const ix = m.index();
  expect(ix.get(b1)!.type).toBe(SYS.card);
  expect(ix.get(b1)!.extra.Bewertung).toEqual({ k: "number", v: 5 });
  expect(m.get(op)!.kind).toBe("op");
});

test("take over items from a tag: conflicts can be skipped, free properties become typed", () => {
  const { m } = books();
  const a = m.add({ title: "Buch A", tags: ["buch"], extra: { Bewertung: { k: "number", v: 4 } } });
  const c = m.add({ title: "Karte mit Tag", tags: ["buch"], type: SYS.card });
  let ix = m.index();
  const p = previewTagToType(ix, "buch", "t_buch");
  expect(p.untyped).toEqual([a]);
  expect(p.typedOther).toEqual([c]);
  tagToType(m.writer, ix, "buch", "t_buch", { replaceTypes: false, removeTag: true }, "#buch → Buch");
  ix = m.index();
  expect(ix.get(a)!.type).toBe("t_buch");
  expect(ix.get(a)!.props.p_bew).toBe(4);
  expect(ix.get(a)!.extra).toEqual({});
  expect(ix.get(a)!.tags).toEqual([]);
  expect(ix.get(a)!.props.p_lese).toBe("o1"); // initial status
  expect(ix.get(c)!.type).toBe(SYS.card);
});

test("relations: inverse side via backlinks, symmetric relations stored once", () => {
  const { m, hamming, b1 } = books();
  const ix = m.index();
  expect(ix.backlinks(hamming).filter((b) => b.kind === "rel").map((b) => b.from)).toEqual([b1]);
  m.addType("t_art", { name: "Artikel", properties: [{ id: "p_tr", name: "Übersetzung", kind: "relation", symmetric: true }] });
  const en = m.add({ title: "Why I'm blogging again", type: "t_art" });
  const de = m.add({ title: "Warum ich wieder blogge", type: "t_art", rels: { p_tr: [en] } });
  const ix2 = m.index();
  expect(ix2.relValues(ix2.get(en)!, "p_tr", true)).toEqual([de]);
  expect(ix2.relValues(ix2.get(de)!, "p_tr", true)).toEqual([en]);
});

test("delete preview: kept children without type land in the inbox, typed ones and those with another place do not", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  const p = m.add({ title: "Blog-Relaunch" });
  const note = m.add({ title: "Gedanke", parents: [p] });
  const card = m.add({ title: "Karte", type: SYS.card, parents: [p] });
  const other = m.add({ title: "Woanders", pinned: "a" });
  const both = m.add({ title: "Zwei Orte", parents: [p, other] });
  const ix = m.index();
  expect(wouldBeInInbox(ix, [note, card, both], (i) => i, [{ ...ix.get(p)!, deleted: true }])).toBe(1);
});

test("pages show every property of a type, empty ones too – computed ones once they have something", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  m.addType("t_book", {
    name: "Buch",
    properties: [
      { id: "p_autor", name: "Autor", kind: "relation" },
      { id: "p_isbn", name: "ISBN", kind: "text", hideEmpty: true },
      { id: "p_n", name: "Kapitel", kind: "computed", computed: { fn: "progress" } },
    ],
  });
  const b = m.add({ title: "Neues Buch", type: "t_book" });
  const shown = () => visibleProps(m.index().get(b)!, m.index().schemaOf(m.index().get(b)!)!, m.index()).map((p) => p.name);
  expect(shown()).toEqual(["Autor", "ISBN"]); // empty and even an old "only when set" mark: shown; nothing computed yet
  // the shipped task: "Blockiert durch" and "Wartet auf" only when set
  const task = m.index().types.get(SYS.task)!.schema;
  expect(task.properties.filter((p) => p.hideEmpty).map((p) => p.id).sort()).toEqual(["p_blocked", "p_waiting"]);
});

