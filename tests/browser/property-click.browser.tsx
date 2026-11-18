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
}

/** Clicks the value cell of the row `name` near its right edge, far from the "–". */
async function clickRow(name: string) {
	const label = [...document.querySelectorAll(".group\\/props .grid > div.truncate")].find(
		(e) => e.textContent === name,
	)!;
	const r = label.nextElementSibling!.getBoundingClientRect();
	await commands.mouse("click", r.right - 10, r.top + r.height / 2);
}

const focused = () => document.activeElement?.getAttribute("aria-label");

test("a click beside the dash of an empty select opens it", async () => {
	await setup();
	await clickRow("Priorität");
	await expect.poll(() => document.activeElement?.tagName).toBe("SELECT");
	await expect.poll(focused).toBe("Priorität");
});

test("a click beside the dash of an empty date range opens its editor", async () => {
	await setup();
	await clickRow("Zeitraum");
	await expect.element(page.getByRole("textbox", { name: "Start" })).toHaveFocus();
});

test("a click beside the dash of an empty relation opens the picker", async () => {
	await setup();
	await clickRow("Blockiert durch");
	await expect.element(page.getByRole("dialog")).toBeVisible();
});
