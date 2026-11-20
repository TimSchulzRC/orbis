// Protection against lost updates: an agent that replaces a body it read earlier must not wipe
// out what someone else wrote in between (base_version on update).
import { afterAll, beforeEach, expect, test } from "bun:test";
import { replaceBody, touch } from "@orbis/core/model";
import { personOrigin } from "@orbis/core/origin";
import { type Ops, versionOf } from "@orbis/server/ops";
import type { Store } from "@orbis/server/store";
import * as Y from "yjs";
import { removeTempDirs } from "../support/helpers";
import { setupStore, tool as storeTool } from "../support/store";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
// set up in German: "Projekt", "Planung" and "aktiv" are German names and words
beforeEach(() => ({ s, ops } = setupStore("orbis-versions-")));

const tool = (name: string, args: unknown) => storeTool(s, name, args);
const body = (title: string) => s.records.get(s.index().resolveTitle(title)!)!.body;
const versionIn = (text: string) => /version ([0-9a-f]{12})/.exec(text)![1]!;
const getVersion = async (ref: string) =>
	JSON.parse((await tool("get", { ref })).text).version as string;

async function note() {
	await tool("create", {
		items: [{ title: "Supplier list", body: "First line.\n\nSecond line." }],
	});
}

test("lost update: a stale full replace no longer wipes out what another agent appended", async () => {
	await note();
	const read = await getVersion("Supplier list"); // agent B reads
	// agent A appends in between
	expect(
		(await tool("update", { ref: "Supplier list", body: "IMPORTANT from A", body_mode: "append" }))
			.error,
	).toBe(false);
	// agent B writes its stale copy back
	const r = await tool("update", {
		ref: "Supplier list",
		body: "First line.\n\nSecond line, revised by B.",
		base_version: read,
	});
	expect(r.error).toBe(true);
	expect(r.text).toMatch(/^Nothing changed\. "Supplier list" \[\w+\] changed since you read it/);
	expect(r.text).toMatch(
		/Only in the current body \(your replace would drop it\):\n( {2}.*\n)* {2}IMPORTANT from A\n/,
	);
	expect(r.text).toMatch(/Only in your body:\n {2}Second line, revised by B\./);
	expect(r.text).toMatch(/Last changes:\n- \S+ by mcp for Kai: text: /);
	expect(body("Supplier list")).toContain("IMPORTANT from A");
	expect(body("Supplier list")).not.toContain("by B");
	// B reads again, merges, and passes the new version
	const now = await getVersion("Supplier list");
	const ok = await tool("update", {
		ref: "Supplier list",
		body: "First line.\n\nSecond line, revised by B.\n\nIMPORTANT from A",
		base_version: now,
	});
	expect(ok.error).toBe(false);
	expect(body("Supplier list")).toBe(
		"First line.\n\nSecond line, revised by B.\n\nIMPORTANT from A",
	);
	expect(versionIn(ok.text)).toBe(await getVersion("Supplier list"));
});

test("an edit in the app makes the agent's copy stale and the answer names who changed it", async () => {
	await note();
	const id = s.index().resolveTitle("Supplier list")!;
	const read = await getVersion(id);
	// the browser edits its replica and sends the Yjs update, as the sync does
	const replica = new Y.Doc({ guid: id });
	Y.applyUpdate(replica, s.stateOf(id));
	const sv = Y.encodeStateVector(replica);
	replica.transact(() => {
		replaceBody(replica, "First line.\n\nSecond line.\n\nAddendum from the browser");
		touch(replica);
	});
	s.applyRemote(
		id,
		Y.encodeStateAsUpdate(replica, sv),
		personOrigin({ id: "u-tim", name: "tim" }, "laptop"),
	);
	const r = await tool("update", { ref: id, body: "All new.", base_version: read });
	expect(r.error).toBe(true);
	expect(r.text).toMatch(/Last changes:\n- \d{4}-\d\d-\d\dT\d\d:\d\d by tim: text: /);
	expect(r.text).toContain("Addendum from the browser");
	expect(r.text).toMatch(/Get it again, merge/);
	expect(body("Supplier list")).toContain("Addendum from the browser");
});

test("replacing the whole body without base_version is refused, explicit replace too", async () => {
	await note();
	for (const args of [
		{ body: "Away with it" },
		{ body: "Away with it", body_mode: "replace" },
		{ body: "" },
	]) {
		const r = await tool("update", { ref: "Supplier list", ...args });
		expect(r.error).toBe(true);
		expect(r.text).toMatch(
			/^Nothing changed\. Replacing the whole body of "Supplier list" needs base_version.*get shows its version.*old_text\/new_text.*append/,
		);
	}
	// nothing else in the call is applied either
	const r = await tool("update", { ref: "Supplier list", title: "New", body: "Away with it" });
	expect(r.error).toBe(true);
	expect(s.index().resolveTitle("Supplier list")).toBeDefined();
	expect(body("Supplier list")).toBe("First line.\n\nSecond line.");
});

test("append, prepend and old_text/new_text work without base_version", async () => {
	await note();
	expect(
		(await tool("update", { ref: "Supplier list", body: "Bottom", body_mode: "append" })).error,
	).toBe(false);
	expect(
		(await tool("update", { ref: "Supplier list", body: "Top", body_mode: "prepend" })).error,
	).toBe(false);
	expect(
		(await tool("update", { ref: "Supplier list", old_text: "Second", new_text: "2nd" })).error,
	).toBe(false);
	expect(body("Supplier list")).toBe("Top\n\nFirst line.\n\n2nd line.\n\nBottom");
	// properties, title and tags need none either (last writer wins)
	expect(
		(await tool("update", { ref: "Supplier list", title: "Suppliers", tags_add: ["list"] })).error,
	).toBe(false);
});

test("base_version is checked with any change when given", async () => {
	await note();
	const read = await getVersion("Supplier list");
	await tool("update", { ref: "Supplier list", tags_add: ["new"] });
	const r = await tool("update", { ref: "Supplier list", title: "Renamed", base_version: read });
	expect(r.error).toBe(true);
	expect(r.text).toMatch(/changed since you read it[\s\S]*: tags/);
	expect(r.text).not.toMatch(/Only in/); // no body diff when the body is not replaced
	const a = await tool("update", {
		ref: "Supplier list",
		body: "Addendum",
		body_mode: "append",
		base_version: read,
	});
	expect(a.error).toBe(true);
	// the right version passes
	expect(
		(
			await tool("update", {
				ref: "Supplier list",
				title: "Renamed",
				base_version: await getVersion("Supplier list"),
			})
		).error,
	).toBe(false);
});

test("the version covers the content update can overwrite, not places or progress notes", async () => {
	await tool("create", {
		items: [
			{ title: "Folder", pin: true },
			{ title: "Website", type: "Projekt", properties: { Status: "Planung" } },
		],
	});
	const v0 = await getVersion("Website");
	await tool("place", { ref: "Website", add: ["Folder"] });
	await tool("add_update", { ref: "Website", text: "Kickoff went well" });
	expect(await getVersion("Website")).toBe(v0);
	const st = await tool("update", { ref: "Website", properties: { Status: "aktiv" } });
	const v1 = versionIn(st.text);
	expect(v1).not.toBe(v0);
	expect(await getVersion("Website")).toBe(v1);
	const r = await tool("update", { ref: "Website", body: "New", base_version: v0 });
	expect(r.text).toMatch(/: Status/); // the property by its name, not its id
	expect((await tool("update", { ref: "Website", body: "New", base_version: v1 })).error).toBe(
		false,
	);
});

test("versions do not depend on the order keys were written in", () => {
	const a = ops.create(
		{ title: "X", type: "Projekt", properties: { Status: "Planung" }, tags: ["a"] },
		"agent:test",
	);
	const v = versionOf(a);
	const copy = { ...a, props: Object.fromEntries(Object.entries(a.props).reverse()) };
	expect(versionOf(copy)).toBe(v);
	expect(versionOf({ ...a, body: "different" })).not.toBe(v);
});

test("concurrent replaces with the same base_version: exactly one wins", async () => {
	await note();
	const read = await getVersion("Supplier list");
	const results = await Promise.all(
		["Version A", "Version B", "Version C"].map((b) =>
			tool("update", { ref: "Supplier list", body: b, base_version: read }),
		),
	);
	expect(results.filter((r) => !r.error).length).toBe(1);
	expect(
		results.filter((r) => r.error).every((r) => /changed since you read it/.test(r.text)),
	).toBe(true);
	const winner = ["Version A", "Version B", "Version C"][results.findIndex((r) => !r.error)]!;
	expect(body("Supplier list")).toBe(winner);
});

test("concurrent appends all arrive", async () => {
	await note();
	await Promise.all(
		["A1", "B1", "C1"].map((b) =>
			tool("update", { ref: "Supplier list", body: b, body_mode: "append" }),
		),
	);
	for (const b of ["A1", "B1", "C1"]) expect(body("Supplier list")).toContain(b);
});
