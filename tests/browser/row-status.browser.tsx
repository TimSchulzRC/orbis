// The status glyph of a row opens the status menu (no ticking off): any option can be picked.
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ItemRow } from "../../packages/ui/src/ui/Row";
import { workspace } from "./workspace";

afterEach(() => cleanup());

test("a click on the status opens the menu; an option sets it", async () => {
	const repo = await workspace();
	const task = repo.live().find((i) => i.title === "CMS auswählen")!;
	expect(task.props.p_status).toBe("st_todo");
	await render(<ItemRow item={task} />);
	await page.getByRole("button", { name: "Status: Nicht begonnen" }).click();
	// the menu lists the options under the three groups
	await expect.element(page.getByText("Aktiv", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Pausiert" }).click();
	await expect.poll(() => repo.get(task.id)?.props.p_status).toBe("st_paused");
});
