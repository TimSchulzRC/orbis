// A page shows its type's properties in the order "Typ bearbeiten" gives them: the badges (status,
// single selections) in a row at the top, everything else (dates too) as rows below, each in order.
// Empty ones wait at the very bottom behind a quiet "Mehr"; open, "Weniger" sits below all of them, in that order too.

import { upsertProp } from "@obtion/core/model";
import { BLOCKED_BY, SYS } from "@obtion/core/setup";
import { keyBetween } from "@obtion/core/sortkey";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { useRepo } from "../../packages/ui/src/hooks";
import { PropertyBlock } from "../../packages/ui/src/ui/Properties";
import { workspace } from "./workspace";

afterEach(() => cleanup());

function Host({ id }: { id: string }) {
	const repo = useRepo();
	const item = repo.get(id)!;
	return <PropertyBlock item={item} schema={repo.index().schemaOf(item)} />;
}

/** The names of the rows, top to bottom. */
const rows = () =>
	[...document.querySelectorAll(".group\\/props .grid > div.truncate")].map((e) => e.textContent);
/** The badges' text, left to right ("Backlog", "Priorität"). */
const badges = () =>
	[...document.querySelectorAll(".group\\/props > div:first-child > span.inline-flex")].map(
		(e) => e.textContent,
	);

async function setup() {
	const repo = await workspace(false);
	const id = repo.create({ title: "Relaunch", type: SYS.project });
	await render(<Host id={id} />);
	const props = () => repo.get(SYS.project)!.schema!.properties;
	/** Puts `id` right after `after`. */
	const moveAfter = (id: string, after: string) => {
		const all = props();
		const i = all.findIndex((p) => p.id === after);
		repo.change(SYS.project, (d) =>
			upsertProp(d, id, { sort: keyBetween(all[i]!.sort, all[i + 1]?.sort ?? null) }),
		);
	};
	return { repo, id, props, moveAfter };
}

const more = () => page.getByRole("button", { name: "Mehr", exact: true });
const less = () => page.getByRole("button", { name: "Weniger", exact: true });
/** The text of everything in the rows' grid, top to bottom: rows and the toggle below them. */
const order = () =>
	[...document.querySelectorAll(".group\\/props .grid > *")]
		.map((e) =>
			e.matches("div.truncate")
				? e.textContent
				: e.tagName === "BUTTON"
					? `[${e.textContent}]`
					: null,
		)
		.filter(Boolean);

test("empty properties hide behind a toggle and open in the type's order", async () => {
	const { props, moveAfter } = await setup();
	await expect.poll(rows).toEqual([]);
	await expect.poll(badges).toEqual(["Backlog"]);
	await more().click();
	await expect.poll(rows).toEqual(["Priorität", "Zeitraum", "Zusammenfassung", "Blockiert durch"]);
	await expect
		.poll(order)
		.toEqual(["Priorität", "Zeitraum", "Zusammenfassung", "Blockiert durch", "[Weniger]"]);
	moveAfter("p_period", props().at(-1)!.id);
	await expect.poll(rows).toEqual(["Priorität", "Zusammenfassung", "Blockiert durch", "Zeitraum"]);
	await less().click();
	await expect.poll(rows).toEqual([]);
	await expect.poll(order).toEqual(["[Mehr]"]);
});

test("a property with a value shows above the toggle, the rest stay below it", async () => {
	const { repo, id } = await setup();
	repo.setProp(id, "p_summary", "Neue Website");
	repo.setProp(id, "p_priority", "pr_high");
	await expect.poll(rows).toEqual(["Zusammenfassung"]);
	await expect.poll(() => badges().map((b) => b?.includes("Priorität"))).toEqual([false, true]);
	await more().click();
	await expect.poll(rows).toEqual(["Zusammenfassung", "Zeitraum", "Blockiert durch"]);
	// filling one in the open list moves it up, in the type's order
	repo.setProp(id, "p_period", "2026-11-01/2026-11-30");
	await expect.poll(rows).toEqual(["Zeitraum", "Zusammenfassung", "Blockiert durch"]);
	await expect.element(less()).toBeVisible();
	// emptied again, it goes back down
	repo.setProp(id, "p_summary", null);
	await expect.poll(rows).toEqual(["Zeitraum", "Zusammenfassung", "Blockiert durch"]);
	await less().click();
	await expect.poll(rows).toEqual(["Zeitraum"]);
});

test("the rows with a value follow the type's order; a date is one of them", async () => {
	const { repo, id, props, moveAfter } = await setup();
	repo.setProp(id, "p_period", "2026-11-01/2026-11-30");
	repo.setProp(id, "p_summary", "Neue Website");
	await expect.poll(rows).toEqual(["Zeitraum", "Zusammenfassung"]);
	moveAfter("p_period", props().at(-1)!.id);
	await expect.poll(rows).toEqual(["Zusammenfassung", "Zeitraum"]);
});

test("the badges at the top follow the type's order", async () => {
	const { repo, id, moveAfter } = await setup();
	repo.setProp(id, "p_priority", "pr_high");
	await expect.poll(() => badges().map((b) => b?.includes("Priorität"))).toEqual([false, true]);
	moveAfter("p_status", "p_priority");
	await expect.poll(() => badges().map((b) => b?.includes("Priorität"))).toEqual([true, false]);
});

test("a date range filled in below the toggle keeps its editor open for the end", async () => {
	const { repo, id } = await setup();
	repo.setProp(id, "p_summary", "Neue Website");
	await more().click();
	await page.getByRole("button", { name: "Zeitraum setzen" }).click();
	await page.getByRole("textbox", { name: "Start" }).fill("01.11.2026");
	await page.getByRole("textbox", { name: "Ende" }).fill("30.11.2026");
	await page.getByRole("textbox", { name: "Start" }).click();
	await expect.poll(() => repo.get(id)!.props.p_period).toBe("2026-11-01/2026-11-30");
	await expect.poll(rows).toEqual(["Zeitraum", "Zusammenfassung", "Priorität", "Blockiert durch"]);
});

test("the other side of a relation is no row: what points here stays on the pointing page", async () => {
	const { repo, id } = await setup();
	const other = repo.create({ title: "Shop", type: SYS.project });
	repo.setRel(other, BLOCKED_BY, id, true);
	await expect.poll(() => repo.index().backlinks(id).length).toBe(1);
	await expect.poll(order).toEqual(["[Mehr]"]);
});
