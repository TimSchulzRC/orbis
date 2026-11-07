import { afterAll, beforeEach, expect, test } from "bun:test";
import { replaceBody, setCapability } from "@obtion/core/model";
import { blockSource, findBlocks, queryFence, readBlock } from "@obtion/core/query";
import { BLOCKED_BY, SYS, typeTabs } from "@obtion/core/setup";
import type { Ops } from "@obtion/server/ops";
import type { Store } from "@obtion/server/store";
import { removeTempDirs } from "../support/helpers";
import { setupStore } from "../support/store";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
const A = "agent:test";
// the store is set up in German: shipped names ("Projekt", "Priorität", "Hoch") and query words stay German
beforeEach(() => ({ s, ops } = setupStore("obtion-typerefs-")));
const tabsOf = (id: string) => typeTabs(s.records.get(id)!, "de");
const prio = () =>
	s
		.index()
		.types.get(SYS.project)!
		.schema.properties.find((p) => p.name === "Priorität")!;

/** A page with a query block; returns its id. */
function page(where: object, columns: string[]): string {
	const id = ops.create({ title: `Overview ${JSON.stringify(where)}` }, A).id;
	const def = { where, columns, sort: [{ key: "Priorität" }] };
	s.change(id, A, (d) => replaceBody(d, `Text\n\n${queryFence(blockSource(def as never))}\n`));
	s.flush();
	return id;
}
const blockOf = (id: string) =>
	readBlock(findBlocks(s.records.get(id)!.body)[0]!.src, s.index()).def;

test("renaming a property: the type's default views, pages on the type and its filters follow", () => {
	expect(s.records.get(SYS.project)!.schema!.views).toBeDefined(); // setup writes the shipped views into the type
	const onType = page({ type: SYS.project }, ["Status", "Priorität"]);
	const anyType = page({ tag: "x" }, ["Priorität"]); // the task's "Priorität" may be meant
	ops.updateType(
		"Projekt",
		{ change_properties: [{ property: "Priorität", name: "Importance" }] },
		A,
	);
	s.flush();
	const tabs = tabsOf(SYS.project);
	expect(tabs.find((t) => t.id === "v_all")!.columns).toContain("Importance");
	expect(tabs.flatMap((t) => t.columns ?? [])).not.toContain("Priorität");
	expect(blockOf(onType)).toMatchObject({
		columns: ["Status", "Importance"],
		sort: [{ key: "Importance" }],
	});
	expect(blockOf(anyType).columns).toEqual(["Priorität"]);
	expect(s.records.get(anyType)!.body.startsWith("Text\n\n```query")).toBe(true);
	// the task's views name its own "Priorität" and stay
	expect(tabsOf(SYS.task).find((t) => t.id === "v_priority")!.group).toBe("Priorität");
});

test("removing a property: it leaves views, filters, grouping, the template and the due capability", () => {
	const id = page({ and: [{ type: SYS.project }, { prop: "Priorität", op: ":", value: "Hoch" }] }, [
		"Priorität",
		"area",
	]);
	s.change(SYS.project, A, (d) => {
		setCapability(d, "template", { body: "x", values: { [prio().id]: "o_x" } });
		setCapability(d, "due", prio().id);
	});
	s.flush();
	ops.updateType("Projekt", { remove_properties: ["Priorität"] }, A);
	s.flush();
	expect(
		tabsOf(SYS.project).flatMap((t) => [
			...(t.columns ?? []),
			...(t.sort ?? []).map((x) => x.key),
			t.group,
		]),
	).not.toContain("Priorität");
	expect(blockOf(id)).toEqual({ where: { type: SYS.project }, columns: ["area"] });
	const caps = s.records.get(SYS.project)!.schema!.capabilities;
	expect(caps.template).toEqual({ body: "x", values: {} });
	expect(caps.due).toBeUndefined();
});

test("stored views change tab by tab", () => {
	ops.updateType(
		"Projekt",
		{
			views: [
				{ name: "A", query: "spalten:Priorität,Status" },
				{ name: "B", query: "spalten:Status" },
			],
		},
		A,
	);
	s.flush();
	ops.updateType(
		"Projekt",
		{ change_properties: [{ property: "Priorität", name: "Importance" }] },
		A,
	);
	s.flush();
	expect(tabsOf(SYS.project).map((t) => [t.name, t.columns])).toEqual([
		["A", ["Importance", "Status"]],
		["B", ["Status"]],
	]);
});

test("renaming a type: relation targets that name it follow", () => {
	const blocked = () =>
		s
			.index()
			.types.get(SYS.task)!
			.schema.properties.find((p) => p.id === BLOCKED_BY)!.target;
	expect(blocked()).toBe("typ:Task | typ:Projekt");
	ops.updateType("Projekt", { name: "Venture" }, A);
	s.flush();
	expect(blocked()).toBe("typ:Task | typ:Venture");
});

test("changing a property's kind: an option becomes its name as text and back", () => {
	const id = ops.create({ title: "P", type: "Projekt", properties: { Priorität: "Hoch" } }, A).id;
	s.flush();
	const optionId = s.records.get(id)!.props[prio().id];
	expect(optionId).not.toBe("Hoch");
	ops.updateType("Projekt", { change_properties: [{ property: "Priorität", kind: "text" }] }, A);
	s.flush();
	expect(s.records.get(id)!.props[prio().id]).toBe("Hoch");
	ops.updateType("Projekt", { change_properties: [{ property: "Priorität", kind: "select" }] }, A);
	s.flush();
	expect(s.records.get(id)!.props[prio().id]).toBe(optionId!);
});
