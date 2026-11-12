import { expect, test } from "bun:test";
import { type PropKind, setProp } from "@obtion/core/model";
import { isInInbox } from "@obtion/core/placement";
import { runSetup, SYS } from "@obtion/core/setup";
import { visibleProps } from "@obtion/core/traits";
import {
	deleteType,
	previewTagToType,
	tagToType,
	typeUsage,
	wouldBeInInbox,
} from "@obtion/core/typeops";
import { MemRepo } from "../support/helpers";

function books() {
	const m = new MemRepo();
	runSetup(m.writer, "de");
	m.addType("t_person", { name: "Person", icon: "user", color: "pink" });
	m.addType("t_book", {
		name: "Book",
		icon: "book",
		color: "brown",
		properties: [
			{
				id: "p_author",
				name: "Author",
				kind: "relation",
				target: "type:Person",
				inverseName: "Books",
				multiple: true,
			},
			{
				id: "p_read",
				name: "Status",
				kind: "status",
				options: [
					{ id: "o1", name: "Want to read", group: "todo" },
					{ id: "o2", name: "Read", group: "done" },
				],
			},
			{ id: "p_rating", name: "Rating", kind: "number" },
		],
	});
	const hamming = m.add({ title: "Richard Hamming", type: "t_person" });
	const b1 = m.add({
		title: "The Art of Doing Science",
		type: "t_book",
		rels: { p_author: [hamming] },
		props: { p_read: "o2", p_rating: 5 },
	});
	const b2 = m.add({ title: "No place", type: "t_book" });
	const proj = m.add({ title: "Reading 2026", pinned: "V" });
	m.add({ title: "List", body: "```query type:Book```", parents: [proj] });
	return { m, hamming, b1, b2 };
}

test("delete a type into a tag: values become free properties, relations refs", () => {
	const { m, hamming, b1, b2 } = books();
	let ix = m.index();
	const u = typeUsage(ix, "t_book");
	expect(u.items.length).toBe(2);
	expect(u.inboxAfterRemove).toBe(2);
	deleteType(m.writer, ix, "t_book", { mode: "tag", tag: "book" }, "Book → #book");
	ix = m.index();
	const book = ix.get(b1)!;
	expect(book.type).toBeNull();
	expect(book.tags).toEqual(["book"]);
	expect(book.extra).toEqual({ Status: { k: "select", v: "Read" }, Rating: { k: "number", v: 5 } });
	expect(book.refs).toEqual([hamming]);
	expect(isInInbox(ix.get(b2)!, ix)).toBe(true);
	expect(ix.types.has("t_book")).toBe(false);
});

test("convert a type into another type maps same-named properties", () => {
	const { m, b1 } = books();
	const op = deleteType(
		m.writer,
		m.index(),
		"t_book",
		{ mode: "type", target: SYS.card },
		"Book → Card",
	);
	const ix = m.index();
	expect(ix.get(b1)!.type).toBe(SYS.card);
	expect(ix.get(b1)!.extra.Rating).toEqual({ k: "number", v: 5 });
	expect(m.get(op)!.kind).toBe("op");
});

test("take over items from a tag: conflicts can be skipped, free properties become typed", () => {
	const { m } = books();
	const a = m.add({ title: "Book A", tags: ["book"], extra: { Rating: { k: "number", v: 4 } } });
	const c = m.add({ title: "Card with tag", tags: ["book"], type: SYS.card });
	let ix = m.index();
	const p = previewTagToType(ix, "book", "t_book");
	expect(p.untyped).toEqual([a]);
	expect(p.typedOther).toEqual([c]);
	tagToType(
		m.writer,
		ix,
		"book",
		"t_book",
		{ replaceTypes: false, removeTag: true },
		"#book → Book",
	);
	ix = m.index();
	expect(ix.get(a)!.type).toBe("t_book");
	expect(ix.get(a)!.props.p_rating).toBe(4);
	expect(ix.get(a)!.extra).toEqual({});
	expect(ix.get(a)!.tags).toEqual([]);
	expect(ix.get(a)!.props.p_read).toBe("o1"); // initial status
	expect(ix.get(c)!.type).toBe(SYS.card);
});

test("relations: inverse side via backlinks, symmetric relations stored once", () => {
	const { m, hamming, b1 } = books();
	const ix = m.index();
	expect(
		ix
			.backlinks(hamming)
			.filter((b) => b.kind === "rel")
			.map((b) => b.from),
	).toEqual([b1]);
	m.addType("t_art", {
		name: "Article",
		properties: [{ id: "p_tr", name: "Translation", kind: "relation", symmetric: true }],
	});
	const en = m.add({ title: "Why I'm blogging again", type: "t_art" });
	// the German translation of the article
	const de = m.add({ title: "Warum ich wieder blogge", type: "t_art", rels: { p_tr: [en] } });
	const ix2 = m.index();
	expect(ix2.relValues(ix2.get(en)!, "p_tr", true)).toEqual([de]);
	expect(ix2.relValues(ix2.get(de)!, "p_tr", true)).toEqual([en]);
});

test("delete preview: kept children without type land in the inbox, typed ones and those with another place do not", () => {
	const m = new MemRepo();
	runSetup(m.writer, "de");
	const p = m.add({ title: "Blog-Relaunch" });
	const note = m.add({ title: "Thought", parents: [p] });
	const card = m.add({ title: "Card", type: SYS.card, parents: [p] });
	const other = m.add({ title: "Elsewhere", pinned: "a" });
	const both = m.add({ title: "Two places", parents: [p, other] });
	const ix = m.index();
	expect(wouldBeInInbox(ix, [note, card, both], (i) => i, [{ ...ix.get(p)!, deleted: true }])).toBe(
		1,
	);
});

test("pages show every property of a type, empty ones too – computed ones once they have something", () => {
	const m = new MemRepo();
	runSetup(m.writer, "de");
	m.addType("t_book", {
		name: "Book",
		properties: [
			{ id: "p_author", name: "Author", kind: "relation" },
			{ id: "p_isbn", name: "ISBN", kind: "text" },
			{ id: "p_n", name: "Chapters", kind: "computed", computed: { fn: "progress" } },
		],
	});
	const b = m.add({ title: "New book", type: "t_book" });
	const shown = () =>
		visibleProps(m.index().get(b)!, m.index().schemaOf(m.index().get(b)!)!, m.index()).map(
			(p) => p.name,
		);
	expect(shown()).toEqual(["Author", "ISBN"]); // empty ones too; nothing computed yet
});
