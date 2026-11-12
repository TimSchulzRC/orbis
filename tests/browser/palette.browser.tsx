// The command palette: one dialog, its field focused; it finds pages as one types; Esc closes it.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { CommandPalette } from "../../packages/ui/src/ui/CommandPalette";
import { workspace } from "./workspace";

const onClose = vi.fn();
beforeEach(async () => {
	await workspace();
	onClose.mockClear();
	await render(<CommandPalette onClose={onClose} />);
});
afterEach(() => cleanup());

test("one dialog with its field focused; typing finds the page", async () => {
	expect(document.querySelectorAll("[role=dialog]")).toHaveLength(1);
	await expect.element(page.getByRole("dialog").getByRole("textbox")).toHaveFocus();
	await commands.keys("type", "relaunch");
	await expect
		.element(
			page
				.getByRole("dialog")
				.getByText(/Relaunch/)
				.first(),
		)
		.toBeVisible();
});

test("Esc closes it", async () => {
	await expect.element(page.getByRole("dialog").getByRole("textbox")).toHaveFocus();
	await commands.keys("press", "Escape");
	expect(onClose).toHaveBeenCalled();
});

test("opened with a query (a tag, an old search link), it shows its hits right away", async () => {
	cleanup();
	await render(<CommandPalette onClose={onClose} query="relaunch" />);
	await expect.element(page.getByRole("dialog").getByRole("textbox")).toHaveValue("relaunch");
	await expect
		.element(
			page
				.getByRole("dialog")
				.getByText(/Relaunch/)
				.first(),
		)
		.toBeVisible();
});
