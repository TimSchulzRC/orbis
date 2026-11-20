import { afterAll, beforeEach, expect, test } from "bun:test";
import { deleteType } from "@orbis/core/typeops";
import { versionOf } from "@orbis/server/ops";
import { storeWriter } from "@orbis/server/setup";
import type { Store } from "@orbis/server/store";
import { Store as ServerStore } from "@orbis/server/store";
import { removeTempDirs, tempDir } from "../support/helpers";
import { setupStore, rpc as storeRpc, tool as storeTool } from "../support/store";

afterAll(removeTempDirs);

let s: Store;
beforeEach(() => ({ s } = setupStore("orbis-mcp-")));

const rpc = (method: string, params: unknown) => storeRpc(s, method, params);
const tool = (name: string, args: unknown) => storeTool(s, name, args);
const count = () => s.live().length;

const weeklyReview = async (store: Store) =>
	(await storeRpc(store, "prompts/get", { name: "weekly_review" })).result.messages![0]!.content
		.text;
/** The queries the weekly review tells the agent to run, as written in its prompt. */
const reviewQueries = [
	...(await weeklyReview(setupStore("orbis-mcp-").s)).matchAll(/query "([^"]+)"/g),
].map((m) => m[1]!);

test("all or nothing: one bad item in a create call, nothing is created", async () => {
	const before = count();
	const seq = s.seq;
	const r = await tool("create", {
		items: [
			{ title: "Good", type: "Task" },
			{ title: "Bad", type: "Task", properties: { Status: "purple" } },
		],
	});
	expect(r.error).toBe(true);
	expect(r.text).toMatch(/^Nothing changed\. "purple" is not an option of "Status"/);
	expect(count()).toBe(before);
	expect(s.seq).toBe(seq);
	expect(s.index().resolveTitle("Good")).toBeUndefined();
	// and the store still works normally afterwards
	expect((await tool("create", { items: [{ title: "Good", type: "Task" }] })).error).toBe(false);
	expect(s.index().resolveTitle("Good")).toBeDefined();
});

test("answers have one line per entry with id, type, status, due, path and blockers", async () => {
	await tool("create", { items: [{ title: "Work", pin: true }] });
	await tool("create", {
		items: [
			{ title: "Website", type: "Projekt", parents: ["Work"], properties: { Status: "aktiv" } },
		],
	});
	await tool("create", { items: [{ title: "Certificate", type: "Task", parents: ["Website"] }] });
	const r = await tool("create", {
		items: [
			{
				title: "Deploy",
				type: "Task",
				parents: ["Website"],
				properties: { Fällig: "30.10.2026", "Blockiert durch": ["Certificate"] },
			},
		],
	});
	const id = s.index().resolveTitle("Deploy")!;
	expect(r.text.split("\n").slice(0, 2)).toEqual([
		"Created:",
		`- Deploy [${id}] · Task · Nicht begonnen (todo) · due 2026-10-30 · Work › Website · ⚠ blocked by "Certificate" · version ${versionOf(s.records.get(id)!)}`,
	]);
	expect(r.text).toMatch(/\(step s\w+ – undo it with the undo tool\)$/);
	const q = await tool("query", { query: "typ:Task blockiert" });
	expect(q.text.split("\n")).toEqual([
		expect.stringMatching(/^1 item\(s\) · typ:Task blockiert/),
		expect.stringMatching(/^- Deploy \[/),
	]);
});

test("hints: unresolved links, duplicate and unlinkable titles, done with open items, no longer blocked", async () => {
	const a = await tool("create", {
		items: [{ title: "Project X", type: "Projekt", body: "See [[Does not exist]]." }],
	});
	expect(a.text).toContain('[[Does not exist]] in "Project X" does not match any item');
	const b = await tool("create", { items: [{ title: "Project X" }] });
	expect(b.text).toContain('Another item is also called "Project X"');
	const c = await tool("create", { items: [{ title: "C# | Notes" }] });
	const cid =
		s.index().resolveTitle("C# | Notes") ?? s.live().find((i) => i.title === "C# | Notes")!.id;
	expect(c.text).toContain(`can't be linked by title; link it as [[${cid}|C Notes]]`);
	// [[id|Label]] links exactly
	await tool("create", { items: [{ title: "Reference", body: `See [[${cid}|C# Notes]].` }] });
	expect(
		s
			.index()
			.textLinks(s.live().find((i) => i.title === "Reference")!)
			.map((l) => l.to),
	).toEqual([cid]);

	await tool("create", { items: [{ title: "Release", type: "Projekt" }] });
	await tool("create", {
		items: [
			{ title: "Tests", type: "Task", parents: ["Release"] },
			{
				title: "Docs",
				type: "Task",
				parents: ["Release"],
				properties: { "Blockiert durch": ["Tests"] },
			},
		],
	});
	const done = await tool("update", { ref: "Release", properties: { Status: "erledigt" } });
	expect(done.text).toContain('"Release" is marked done, but 2 open item(s) are below it');
	const freed = await tool("set_status", { refs: ["Tests"], status: "done" });
	expect(freed.text).toContain('No longer blocked: "Docs".');
	// a relation value outside the target is saved, with a hint
	await tool("create", { items: [{ title: "Loose idea" }] });
	const off = await tool("update", {
		ref: "Docs",
		properties: { "Blockiert durch": ["Loose idea"] },
	});
	expect(off.error).toBe(false);
	expect(off.text).toContain('"Loose idea" doesn\'t match. Saved anyway.');
	const fine = await tool("update", {
		ref: "Docs",
		properties: { "Blockiert durch": ["Loose idea", "Release"] },
	});
	expect(fine.text).not.toContain("Saved anyway");
});

test("a link to the item itself is refused", async () => {
	const r = await tool("create", { items: [{ title: "Self", body: "More at [[Self]]." }] });
	expect(r.error).toBe(true);
	expect(r.text).toMatch(/^Nothing changed\. .*links to itself/);
	await tool("create", { items: [{ title: "Neighbour" }] });
	const id = s.index().resolveTitle("Neighbour")!;
	expect(
		(await tool("update", { ref: "Neighbour", body: `See [[${id}|me]]`, body_mode: "append" }))
			.text,
	).toMatch(/links to itself/);
	expect((await tool("update", { ref: "Neighbour", refs_add: ["Neighbour"] })).text).toMatch(
		/cannot refer to itself/,
	);
	expect(
		(
			await tool("create", {
				items: [{ title: "T", type: "Task", properties: { "Blockiert durch": ["T"] } }],
			})
		).error,
	).toBe(true);
});

test("prompts process_inbox and weekly_review", async () => {
	const r = await rpc("prompts/list", {});
	expect(r.result.prompts!.map((p) => p.name).sort()).toEqual(["process_inbox", "weekly_review"]);
	const text = await weeklyReview(s);
	for (const part of ["done>-7d", "blocked", "14 days", "inbox"]) expect(text).toContain(part);
	expect(reviewQueries).toHaveLength(4);
});

test.each(reviewQueries)("the weekly review's query %p parses", async (q) => {
	expect((await tool("query", { query: q })).error).toBe(false);
});

test("with zero types the agent still reads, creates, queries and gets told how to start a type", async () => {
	const w = storeWriter(s, "system:test");
	await tool("create", {
		items: [{ title: "Website", type: "Projekt", properties: { Status: "aktiv" } }],
	});
	for (const id of [...s.index().types.keys()])
		deleteType(w, s.index(), id, { mode: "remove" }, "test");
	s.flush();
	expect(s.index().types.size).toBe(0);
	const schema = await tool("schema", {});
	expect(schema.error).toBe(false);
	const c = await tool("create", { items: [{ title: "Note without type", parents: ["Website"] }] });
	expect(c.error).toBe(false);
	const q = await tool("query", { query: "unter:[[Website]]" });
	expect(q.text).toContain("Note without type");
	const bad = await tool("create", { items: [{ title: "X", type: "Projekt" }] });
	expect(bad.error).toBe(true);
	expect(bad.text).toMatch(/define_type|No type/i);
	expect(JSON.parse(schema.text).no_types).toMatch(/define_type/);
});

/** A long status report with neutral sample content: sections with subsections, \r\n line ends like imported files. */
function report() {
	const filler = (word: string, n: number) =>
		Array.from(
			{ length: n },
			(_, k) => `- ${word} ${k}: Aligned with the business team, mapping checked, test running.`,
		).join("\r\n");
	return [
		"Short preamble.",
		"# Status",
		filler("Point", 60),
		"## Open points",
		filler("Open", 50),
		"The job DEMO_EXPORT_PDF_MAIL_DUPLICATES fails on Receipt_4711_2026-01-15.pdf.",
		"### Details",
		filler("Detail", 20),
		"## Done",
		filler("Finished", 40),
		"# Appendix",
		filler("Attachment", 40),
	].join("\r\n");
}

test("get: a long body comes as its outline; section, offset pages and full read its parts", async () => {
	const body = report();
	expect(body.length).toBeGreaterThan(12000);
	await tool("create", { items: [{ title: "Status report", body }] });
	const got = JSON.parse((await tool("get", { ref: "Status report" })).text);
	expect(got.body).toBeUndefined();
	expect(got.body_length).toBe(body.length);
	expect(got.body_note).toMatch(/outline.*section.*offset.*full: true/);
	expect(got.outline).toHaveLength(5);
	expect(got.outline[1]).toMatch(/^## Open points · at \d+ · \d+ chars$/);

	// a section by path, with its subsections, and where it is
	const sec = JSON.parse(
		(await tool("get", { ref: "Status report", section: "status > open points" })).text,
	);
	expect(sec.section).toMatch(/^Status > Open points · level 2 · at \d+ · \d+ of \d+ chars$/);
	expect(sec.body.startsWith("## Open points")).toBe(true);
	expect(sec.body).toContain("### Details");
	expect(sec.body).not.toContain("## Done");
	expect(sec.outline).toBeUndefined();
	// a heading alone works when it is unique; an unknown one lists the headings
	expect(
		JSON.parse((await tool("get", { ref: "Status report", section: "Details" })).text).body,
	).toMatch(/^### Details/);
	const none = await tool("get", { ref: "Status report", section: "Does not exist" });
	expect(none.error).toBe(true);
	expect(none.text).toContain("- Status > Open points (at ");

	// pages: offsets count from the start of the body, the hint names the next one, together they are the body
	let text = "";
	let offset: number | undefined = 0;
	let pages = 0;
	while (offset !== undefined) {
		const p = JSON.parse(
			(await tool("get", { ref: "Status report", offset, max_chars: 5000 })).text,
		);
		text += p.body;
		pages++;
		const next = p.body_more ? Number(/offset: (\d+)/.exec(p.body_more)![1]) : undefined;
		if (next !== undefined)
			expect(p.body_range).toBe(`characters ${offset}–${next} of ${body.length}`);
		offset = next;
	}
	expect(pages).toBeGreaterThan(2);
	expect(text).toBe(body);
	// a page inside a section stays inside it
	const at = Number(/at (\d+)/.exec(got.outline[3])![1]);
	const inSec = JSON.parse(
		(await tool("get", { ref: "Status report", section: "Done", max_chars: 1000 })).text,
	);
	expect(inSec.body_range).toMatch(
		new RegExp(`^characters ${at}–\\d+ of the section \\(${at}–\\d+\\)$`),
	);
	expect(inSec.body_more).toMatch(/section "Done" and offset: \d+/);
	expect((await tool("get", { ref: "Status report", section: "Done", offset: 0 })).text).toMatch(
		/outside the section/,
	);
	expect((await tool("get", { ref: "Status report", offset: body.length + 10 })).text).toMatch(
		/past the end/,
	);
	// all of it, and the outline next to a short answer
	expect(JSON.parse((await tool("get", { ref: "Status report", full: true })).text).body).toBe(
		body,
	);
	const short = JSON.parse(
		(await tool("get", { ref: "Status report", section: "Appendix", outline: true })).text,
	);
	expect(short.outline).toHaveLength(5);
	// a short body comes whole as before; include_body false leaves it out
	await tool("create", { items: [{ title: "Short", body: "# One\nText" }] });
	expect(JSON.parse((await tool("get", { ref: "Short" })).text)).toMatchObject({
		body: "# One\nText",
	});
	expect(
		JSON.parse((await tool("get", { ref: "Short", include_body: false })).text).body,
	).toBeUndefined();
});

test("get: a long body without headings comes in pages; a long file text too", async () => {
	const body = "A sentence without a heading. ".repeat(1000);
	await tool("create", { items: [{ title: "Running text", body }] });
	const got = JSON.parse((await tool("get", { ref: "Running text" })).text);
	expect(got.body.length).toBe(12000);
	expect(got.body_more).toBe("More from offset 12000: get with offset: 12000.");
	// a file keeps its extracted text in its meta: the same paging applies to it
	const { setFileMeta } = await import("@orbis/core/model");
	const id = s.create({ kind: "file", title: "Manual.txt" }, "test");
	s.change(id, "test", (d) =>
		setFileMeta(d, { name: "Manual.txt", text: "First page. ".repeat(3000) }),
	);
	s.flush();
	const f = JSON.parse((await tool("get", { ref: id })).text);
	expect(f.text.length).toBe(12000);
	expect(f.text_more).toMatch(/offset: 12000/);
	const p2 = JSON.parse((await tool("get", { ref: id, offset: 30000 })).text);
	expect(p2.text).toBe("First page. ".repeat(3000).slice(30000));
	expect(p2.text_more).toBeUndefined();
});

test("get: children and updates come in pages", async () => {
	await tool("create", { items: [{ title: "Big project", type: "Projekt" }] });
	await tool("create", {
		items: Array.from({ length: 70 }, (_, n) => ({
			title: `Task ${n}`,
			type: "Task",
			parents: ["Big project"],
		})),
	});
	for (let n = 0; n < 20; n++)
		await tool("add_update", { ref: "Big project", text: `Status ${n}` });
	const first = JSON.parse((await tool("get", { ref: "Big project" })).text);
	expect(first.children).toHaveLength(60);
	expect(first.children_range).toBe("1–60 of 70 – more with children_offset: 60");
	expect(first.updates.map((u: { text: string }) => u.text).at(-1)).toBe("Status 19");
	expect(first.updates).toHaveLength(15);
	expect(first.updates_range).toBe("1–15 newest of 20 – older ones with updates_offset: 15");
	const next = JSON.parse(
		(await tool("get", { ref: "Big project", children_offset: 60, updates_offset: 15 })).text,
	);
	expect(next.children).toHaveLength(10);
	expect(next.children_range).toBe("61–70 of 70");
	expect(next.updates.map((u: { text: string }) => u.text)).toEqual([
		"Status 0",
		"Status 1",
		"Status 2",
		"Status 3",
		"Status 4",
	]);
	expect(next.updates_range).toBe("16–20 newest of 20");
});

test("search: identifiers by their parts, the excerpt at the hit with underscores, and its section", async () => {
	await tool("create", {
		items: [
			{ title: "Status report", body: report() },
			{ title: "DeliveryNote_Sample_4711_2026-01-15.pdf" },
		],
	});
	const r = await tool("search", { query: "DEMO_EXPORT_PDF_MAIL_DUPLICATES" });
	expect(r.text).toMatch(
		/^- Status report \[\w+\] · \w+ · § Status > Open points — “…[^”]*DEMO_EXPORT_PDF_MAIL_DUPLICATES[^”]*”$/,
	);
	const parts = (await tool("search", { query: "4711" })).text.split("\n");
	expect(parts).toHaveLength(2);
	expect(parts.join("\n")).toContain("Receipt_4711_2026-01-15.pdf");
	expect((await tool("search", { query: "Sample" })).text).toContain(
		"DeliveryNote_Sample_4711_2026-01-15.pdf",
	);
});

test("schema names every view as its tab shows it; that name finds an unnamed view again", async () => {
	const schema = JSON.parse((await tool("schema", {})).text);
	const views = schema.types.flatMap((t: { views: { name: string | null }[] }) => t.views);
	expect(views.length).toBeGreaterThan(3);
	expect(views.every((v: { name: string | null }) => typeof v.name === "string" && v.name)).toBe(
		true,
	);
	const project = schema.types.find((t: { name: string }) => t.name === "Projekt");
	expect(project.views.map((v: { name: string }) => v.name)).toContain("Kalender");
	// giving the views back as schema shows them keeps the unnamed calendar unnamed, with its id
	const calendar = s.index().types.get("sys:project")!;
	const before = calendar.schema.views?.length
		? calendar.schema.views
		: (await import("@orbis/core/setup")).typeTabs(calendar, "de");
	const views2 = project.views.map((v: { name: string; query: string }) => ({
		name: v.name,
		query: v.query,
	}));
	expect((await tool("update_type", { type: "Projekt", views: views2 })).error).toBe(false);
	const after = s.index().types.get("sys:project")!.schema.views!;
	expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
	expect(after.find((t) => t.kind === "calendar")!.name).toBeUndefined();
});

test("a workspace no app has set up: schema says so, setup creates the default types once", async () => {
	const bare = new ServerStore(tempDir("orbis-mcp-bare-"));
	const call = (name: string, args: unknown) => storeTool(bare, name, args);
	const schema = JSON.parse((await call("schema", {})).text);
	expect(schema.types).toEqual([]);
	expect(schema.not_set_up).toMatch(/Call setup/);
	expect((await call("create", { items: [{ title: "X", type: "Projekt" }] })).error).toBe(true);
	const r = await call("setup", { language: "en" });
	expect(r.error).toBe(false);
	expect(r.text).toMatch(
		/^Set up in English\. Types: Project \(Projects\), Task \(Tasks\), Card \(Cards\)/,
	);
	const now = JSON.parse((await call("schema", {})).text);
	expect(now.not_set_up).toBeUndefined();
	expect(now.ui_language).toBe("en");
	expect(now.types.map((t: { name: string }) => t.name)).toEqual(["Project", "Task", "Card"]);
	expect((await call("create", { items: [{ title: "Website", type: "Project" }] })).error).toBe(
		false,
	);
	// never twice: the app (or another agent) finds the settings and leaves it
	const again = await call("setup", {});
	expect(again.error).toBe(true);
	expect(again.text).toMatch(/^Nothing changed\. This workspace is set up already \(language en\)/);
	expect(bare.index().types.size).toBe(3);
});
