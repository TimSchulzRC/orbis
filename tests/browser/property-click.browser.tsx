// An empty property row starts its input wherever its value cell is clicked, not only on the "–".

import { SYS } from "@obtion/core/setup";
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
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

async function setup() {
	const repo = await workspace(false);
	const id = repo.create({ title: "Relaunch", type: SYS.project });
	await render(<Host id={id} />);
	await page.getByRole("button", { name: "Mehr", exact: true }).click();
	return { repo, id };
}

/** Clicks the value cell of the row `name` near its right edge, far from the "–". */
async function clickRow(name: string) {
	const label = [...document.querySelectorAll(".group\\/props .grid > div.truncate")].find(
		(e) => e.textContent === name,
	)!;
	const r = label.nextElementSibling!.getBoundingClientRect();
	await commands.mouse("click", r.right - 10, r.top + r.height / 2);
}

test("a click beside the dash of an empty select opens its menu, and a pick sets it", async () => {
	const { repo, id } = await setup();
	await clickRow("Priorität");
	await page.getByRole("button", { name: "Hoch" }).click();
	await expect.poll(() => repo.get(id)!.props.p_priority).toBe("pr_high");
});

test("a click beside the dash of an empty date range opens its editor", async () => {
	await setup();
	await clickRow("Zeitraum");
	await expect.element(page.getByRole("textbox", { name: "Start" })).toHaveFocus();
});

test("an empty date range left without a date closes back to its dash", async () => {
	await setup();
	await clickRow("Zeitraum");
	await expect.element(page.getByRole("textbox", { name: "Start" })).toHaveFocus();
	await page.getByText("Priorität").click();
	await expect.element(page.getByRole("button", { name: "Zeitraum setzen" })).toBeVisible();
	await expect.element(page.getByRole("textbox", { name: "Start" })).not.toBeInTheDocument();
});

test("a click beside the dash of an empty relation opens the picker", async () => {
	await setup();
	await clickRow("Blockiert durch");
	await expect.element(page.getByRole("dialog")).toBeVisible();
});
