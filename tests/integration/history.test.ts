import { afterAll, beforeEach, expect, test } from "bun:test";
import { putBackUpdate, removeUpdate, replaceBody, touch } from "@obtion/core/model";
import { agentOrigin, personOrigin } from "@obtion/core/origin";
import type { Ops } from "@obtion/server/ops";
import type { Store } from "@obtion/server/store";
import { undoStep } from "@obtion/server/undo";
import { removeTempDirs } from "../support/helpers";
import { setupStore, tool as storeTool } from "../support/store";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
beforeEach(() => ({ s, ops } = setupStore("obtion-history-")));

const AG = agentOrigin("claude-code", { id: "u1", name: "Tim" });
const TIM = personOrigin({ id: "u1", name: "Tim" }, "Mac");
const ANNA = personOrigin({ id: "u2", name: "Anna" }, "Phone");
const tool = (name: string, args: unknown) => storeTool(s, name, args);
const idOf = (title: string) => s.index().resolveTitle(title)!;

/** A person's edit in the app: one step of its own. */
function edit(origin: string, id: string, body: string) {
	s.step(origin, () => s.change(id, origin, (d) => (replaceBody(d, body), touch(d))));
	s.flush();
}
/** Typing in the app: several flushes of one step by one person. */
function typing(origin: string, id: string, texts: string[]) {
	s.step(origin, () => {
		for (const t of texts) {
			s.change(id, origin, (d) => replaceBody(d, t));
			s.flush();
		}
	});
}

test("every change of the text keeps a version; typing in one step folds into one", () => {
	ops.call(AG, () => (ops.create({ title: "Mapping concept", body: "Line one\n" }, AG), "ok"));
	const id = idOf("Mapping concept");
	expect(s.versions(id)).toEqual([]); // created: nothing to keep yet, the first change keeps it
	typing(TIM, id, ["Line one\nL", "Line one\nLine tw", "Line one\nLine two\n"]);
	const v = s.versions(id);
	expect(v.map((x) => [x.n, x.origin])).toEqual([
		[1, AG], // the text it was created with, by whoever created it
		[2, TIM], // three flushes of typing: one version
	]);
	expect(s.versionText(v[0]!.id)).toBe("Line one\n");
	expect(s.versionText(v[1]!.id)).toBe("Line one\nLine two\n");
	// another step (or another person) is a version of its own
	edit(ANNA, id, "Line one\nLine two\nLine three\n");
	ops.call(
		AG,
		() => (ops.update("Mapping concept", { body: "Line zero\n", body_mode: "prepend" }, AG), "ok"),
	);
	expect(s.versions(id).map((x) => x.origin)).toEqual([AG, TIM, ANNA, AG]);
	expect(s.versionText(s.versions(id).at(-1)!.id)).toBe(s.records.get(id)!.body);
	// only changes of the text make versions
	ops.call(AG, () => (ops.update("Mapping concept", { tags_add: ["concept"] }, AG), "ok"));
	expect(s.versions(id).length).toBe(4);
});

test("versions are stored compressed", () => {
	const long = "A long paragraph about the integration that repeats a lot. ".repeat(400);
	ops.call(AG, () => (ops.create({ title: "Long" }, AG), "ok"));
	const id = idOf("Long");
	edit(TIM, id, long);
	const row = s.db
		.query("SELECT length(data) AS size, len FROM versions WHERE doc = ?")
		.get(id) as { size: number; len: number };
	expect(row.len).toBe(long.length);
	expect(row.size).toBeLessThan(long.length / 10);
});

test("activity: text changes as a diff, properties and options by name, updates with their text", async () => {
	await tool("create", {
		items: [
			{
				title: "Client North",
				type: "Projekt",
				body: "# Goal\nSend invoices\n\n# Open\n- Mapping\n",
			},
		],
	});
	await tool("create", {
		items: [{ title: "Check mapping", type: "Task", parents: ["Client North"] }],
	});
	const id = idOf("Client North");
	edit(TIM, id, "# Goal\nSend and receive invoices\n\n# Open\n- Mapping\n- Test run\n");
	await tool("update", { ref: "Check mapping", properties: { Status: "erledigt" } });
	await tool("add_update", { ref: "Client North", text: "Test run with three receipts ok" });
	const out = (await tool("activity", { days: 1 })).text;
	expect(out).toContain(`· Tim · updated "Client North" [${id}] · Projekt`);
	expect(out).toContain("    -Send invoices");
	expect(out).toContain("    +Send and receive invoices");
	expect(out).toContain("    +- Test run");
	expect(out).toMatch(/text: \d+ → \d+ characters/);
	expect(out).toContain("Status: Nicht begonnen → Erledigt");
	expect(out).not.toContain("p:p_status");
	expect(out).toContain('update posted: "Test run with three receipts ok"');
	expect(out).toMatch(/cursor: \d+-0/);
});

test("activity: a long diff is cut, with the call that shows all of it", async () => {
	await tool("create", { items: [{ title: "Much text" }] });
	const id = idOf("Much text");
	edit(TIM, id, Array.from({ length: 120 }, (_, i) => `Line ${i}`).join("\n") + "\n");
	const out = (await tool("activity", { days: 1, ref: "Much text" })).text;
	expect(out).toContain(`more line(s): history ref=${id} from=0 to=1`);
	const full = (await tool("history", { ref: id, from: 0, to: 1 })).text;
	expect(full).toContain("+120 −0 line(s)");
	expect(full).toContain("+Line 119");
});

test("activity since a cursor: only what changed after it, also later edits folded into an earlier entry", async () => {
	await tool("create", {
		items: [
			{ title: "Note A", body: "a\n" },
			{ title: "Note B", body: "b\n" },
		],
	});
	const first = (await tool("activity", { since: "2020-01-01T00:00" })).text;
	expect(first).toContain('created "Note A"');
	const cursor = /cursor: (\d+-\d+)/.exec(first)![1]!;
	expect((await tool("activity", { since: cursor })).text).toStartWith("0 change(s)");
	await Bun.sleep(2);
	typing(TIM, idOf("Note A"), ["a\ntwo\n"]);
	const second = (await tool("activity", { since: cursor })).text;
	expect(second).toStartWith("1 change(s)");
	expect(second).toContain('updated "Note A"');
	const cursor2 = /cursor: (\d+-\d+)/.exec(second)![1]!;
	// Tim types on in the same step: the same activity entry grows – and shows up again
	await Bun.sleep(2);
	s.step(TIM, () => s.change(idOf("Note A"), TIM, (d) => replaceBody(d, "a\ntwo\nthree\n")));
	s.flush();
	const third = (await tool("activity", { since: cursor2 })).text;
	expect(third).toStartWith("1 change(s)");
	expect(third).toContain("+three");
	// an entry id and an ISO time work as since too; nonsense is refused with the reason
	expect(
		(await tool("activity", { since: new Date(Date.now() + 60_000).toISOString() })).text,
	).toStartWith("0 change(s)");
	expect((await tool("activity", { since: "yesterday" })).error).toBe(true);
});

test("activity since: in pages with limit, the cursor continues where the page ended", async () => {
	const start = new Date(Date.now() - 1000).toISOString();
	await tool("create", { items: Array.from({ length: 7 }, (_, i) => ({ title: `Point ${i}` })) });
	const seen: string[] = [];
	let since = start;
	for (let round = 0; round < 5; round++) {
		const out = (await tool("activity", { since, limit: 3 })).text;
		seen.push(...[...out.matchAll(/created "(Point \d)"/g)].map((m) => m[1]!));
		const more = /since="(\d+-\d+)"/.exec(out);
		if (!more) break;
		since = more[1]!;
	}
	expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `Point ${i}`));
});

test("activity under: an item and everything below it, deleted items included", async () => {
	await tool("create", {
		items: [
			{ title: "Client East", type: "Projekt" },
			{ title: "Client West", type: "Projekt" },
		],
	});
	await tool("create", {
		items: [
			{ title: "Specification", parents: ["Client East"] },
			{ title: "West note", parents: ["Client West"] },
		],
	});
	await tool("create", {
		items: [
			{ title: "Detail", parents: ["Specification"] },
			{ title: "Old", parents: ["Client East"] },
		],
	});
	const cursor = /cursor: (\d+-\d+)/.exec((await tool("activity", { days: 1 })).text)![1]!;
	await Bun.sleep(2);
	edit(TIM, idOf("Detail"), "deep down\n");
	edit(TIM, idOf("West note"), "elsewhere\n");
	await tool("delete", { ref: "Old" });
	const out = (await tool("activity", { since: cursor, under: "Client East" })).text;
	expect(out).toContain('updated "Detail"');
	expect(out).toContain('deleted "Old"');
	expect(out).not.toContain("West note");
	expect(out).toContain('under "Client East"');
});

test("activity by: people, agents, others, a name", async () => {
	await tool("create", { items: [{ title: "Shared", body: "x\n" }] });
	const id = idOf("Shared");
	edit(TIM, id, "x\nby Tim\n");
	edit(ANNA, id, "x\nby Tim\nby Anna\n");
	const by = async (who: string) =>
		(await tool("activity", { days: 1, by: who, diff: false })).text;
	const people = await by("people");
	expect(people).toContain("· Tim ·");
	expect(people).toContain("· Anna ·");
	expect(people).not.toContain("· mcp for Kai ·");
	const agents = await by("agents");
	expect(agents).toContain("· mcp for Kai ·");
	expect(agents).not.toContain("· Tim ·");
	// the test calls come from the agent "mcp" for Kai: others are everyone else
	const others = await by("others");
	expect(others).toContain("· Anna ·");
	expect(others).not.toContain("· mcp for Kai ·");
	const anna = await by("anna");
	expect(anna).toContain("· Anna ·");
	expect(anna).not.toContain("· Tim ·");
	expect(await by("Tim, Anna")).toMatch(/^2 change\(s\)/);
});

test("history: the list, one version, and diffs between versions or to now", async () => {
	await tool("create", { items: [{ title: "Guide", body: "Step 1\n" }] });
	const id = idOf("Guide");
	edit(TIM, id, "Step 1\nStep 2\n");
	edit(ANNA, id, "Step 1\nStep 2 in detail\n");
	const list = (await tool("history", { ref: "Guide" })).text;
	expect(list).toContain('3 version(s) of the text of "Guide"');
	expect(list).toMatch(/#3 · .* · Anna · \d+ characters · \+1 −1 line\(s\)/);
	expect(list).toMatch(/#1 · .* · mcp for Kai · /);
	expect(list).toContain("The text now is version 3.");
	expect((await tool("history", { ref: id, version: 1 })).text).toEndWith("\n\nStep 1\n");
	const d = (await tool("history", { ref: id, from: 1, to: 2 })).text;
	expect(d).toContain("#1 → #2, +1 −0 line(s)");
	expect(d).toContain("+Step 2");
	const toNow = (await tool("history", { ref: id, from: 2 })).text;
	expect(toNow).toContain("#2 → the text now");
	expect(toNow).toContain("-Step 2\n+Step 2 in detail");
	expect((await tool("history", { ref: id, version: 9 })).error).toBe(true);
	// an item whose text never changed
	await tool("create", { items: [{ title: "Quiet", body: "stays\n" }] });
	expect((await tool("history", { ref: "Quiet" })).text).toContain("has no versions yet");
});

test("restoring a version is a change of its own: a new version, in the activity, undoable", async () => {
	await tool("create", { items: [{ title: "Contract note", body: "Version A\n" }] });
	const id = idOf("Contract note");
	edit(ANNA, id, "Version B\n");
	const [a] = s.versions(id);
	// what the app does: write the old text as a new change, in its own step
	const step = s.step(
		TIM,
		(st) => (s.change(id, TIM, (d) => (replaceBody(d, s.versionText(a!.id)!), touch(d))), st),
	);
	s.flush();
	expect(s.records.get(id)!.body).toBe("Version A\n");
	expect(s.versions(id).map((v) => v.origin)).toEqual(["agent:mcp;u=u0;n=Kai", ANNA, TIM]);
	const restored = s.events({ doc: id, limit: 1 })[0]!;
	expect(restored).toMatchObject({ origin: TIM, step });
	expect(restored.changes.find((c) => c.field === "body")).toMatchObject({ diff: true });
	expect(s.eventText(restored.id)).toMatchObject({
		before: "Version B\n",
		after: "Version A\n",
		from: 2,
		to: 3,
	});
	// undo brings B back, as one more version
	const r = undoStep(s, step, TIM);
	expect(r.changed).toEqual([id]);
	expect(s.records.get(id)!.body).toBe("Version B\n");
	expect(s.versions(id).length).toBe(4);
	expect(s.versionText(s.versions(id).at(-1)!.id)).toBe("Version B\n");
	const out = (await tool("activity", { days: 1, ref: id })).text;
	expect(out).toContain("undid a step");
});

test("what an activity entry changed: the versions before and after it", async () => {
	await tool("create", { items: [{ title: "About HTTP", body: "one\n" }] });
	const id = idOf("About HTTP");
	edit(TIM, id, "one\ntwo\n");
	const ev = s.events({ doc: id, limit: 1 })[0]!;
	expect(s.eventText(ev.id)).toEqual({
		doc: id,
		before: "one\n",
		after: "one\ntwo\n",
		from: 1,
		to: 2,
	});
	// an entry that kept no version (the creation) has nothing to show
	const created = s.events({ doc: id, limit: 5 }).find((e) => e.kind === "created")!;
	expect(s.eventText(created.id)).toBeUndefined();
});

test("edits that keep the length still show their diff when folded into one entry", async () => {
	await tool("create", { items: [{ title: "Animal", body: "cat\n" }] });
	const id = idOf("Animal");
	typing(TIM, id, ["bat\n", "bar\n"]);
	const ev = s.events({ doc: id, limit: 1 })[0]!;
	expect(ev.changes.find((c) => c.field === "body")).toMatchObject({ diff: true });
	expect((await tool("activity", { days: 1, ref: id })).text).toContain("-cat\n    +bar");
});

test("activity without since says how to get the older entries a limit cut off", async () => {
	await tool("create", { items: Array.from({ length: 4 }, (_, i) => ({ title: `Entry ${i}` })) });
	const out = (await tool("activity", { days: 1, limit: 2 })).text;
	expect(out).toMatch(
		/More, older changes than these: raise limit, or go through all of them oldest first with since="\d{4}-/,
	);
});

test("a deleted item's activity and subtree stay readable by id", async () => {
	await tool("create", { items: [{ title: "Old project", type: "Projekt" }] });
	await tool("create", { items: [{ title: "Subitem", parents: ["Old project"] }] });
	const id = idOf("Old project");
	await tool("delete", { ref: "Old project", children: "trash" });
	const out = await tool("activity", { days: 1, under: id });
	expect(out.error).toBe(false);
	expect(out.text).toContain('created "Subitem"');
	expect(out.text).toContain('deleted "Old project"');
});

test("an update in the activity carries its id, so the app can show that one", async () => {
	await tool("create", { items: [{ title: "Relaunch", type: "Projekt" }] });
	const id = idOf("Relaunch");
	expect((await tool("add_update", { ref: id, text: "Kickoff war gut." })).error).toBe(false);
	const update = s.index().get(id)!.updates[0]!;
	const ev = s.events({ doc: id, limit: 1 })[0]!;
	expect(ev.changes.find((c) => c.field === "update")).toEqual({
		field: "update",
		to: "Kickoff war gut.",
		id: update.id,
	});
});

test("a deleted update leaves the list but stays in the activity, and comes back on undo", async () => {
	await tool("create", { items: [{ title: "Relaunch", type: "Projekt" }] });
	const id = idOf("Relaunch");
	await tool("add_update", { ref: id, text: "Erstes." });
	await tool("add_update", { ref: id, text: "Zweites." });
	const [first] = s.index().get(id)!.updates;
	let gone: ReturnType<typeof removeUpdate>;
	s.step(TIM, () => s.change(id, TIM, (d) => void (gone = removeUpdate(d, first!.id))));
	s.flush();
	expect(
		s
			.index()
			.get(id)!
			.updates.map((u) => u.text),
	).toEqual(["Zweites."]);
	const deleted = s.events({ doc: id, limit: 1 })[0]!;
	expect(deleted.changes).toEqual([{ field: "update", from: "Erstes.", id: first!.id }]);
	// the entries that wrote it are still there
	expect(
		s
			.events({ doc: id, limit: 10 })
			.some((e) => e.changes.some((c) => c.field === "update" && c.to === "Erstes.")),
	).toBe(true);
	// put back at its place, with its id
	s.step(TIM, () => s.change(id, TIM, (d) => putBackUpdate(d, gone!.entry, gone!.at)));
	s.flush();
	expect(
		s
			.index()
			.get(id)!
			.updates.map((u) => u.id),
	).toEqual([first!.id, s.index().get(id)!.updates[1]!.id]);
	expect(s.index().get(id)!.updates[0]!.text).toBe("Erstes.");
});
