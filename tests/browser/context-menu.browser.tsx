// A right click opens the "…" menu of a row at the mouse, with the same entries; the "…" button
// still opens it below itself.
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { MenuItem, MoreMenu, useContextMenu } from "../../packages/ui/src/ui/primitives";

const onTrash = vi.fn();
function Row({ title = "Website relaunch", extra }: { title?: string; extra?: string }) {
	const menu = useContextMenu();
	return (
		<div
			onContextMenu={menu.onContextMenu}
			style={{ display: "flex", gap: 8, width: 320, padding: "0 40px" }}
		>
			<span style={{ flex: 1 }}>{title}</span>
			<MoreMenu menu={menu}>
				{(close) => (
					<>
						{extra && <MenuItem onClick={close}>{extra}</MenuItem>}
						<MenuItem danger onClick={() => (close(), onTrash())}>
							Move to trash
						</MenuItem>
					</>
				)}
			</MoreMenu>
		</div>
	);
}
afterEach(() => (cleanup(), onTrash.mockClear()));

test("a right click opens the menu at the mouse, its entries work", async () => {
	await render(<Row />);
	await page.getByText("Website relaunch").click({ button: "right" });
	const entry = page.getByRole("button", { name: "Move to trash" });
	await expect.element(entry).toBeVisible();
	// at the mouse: left of the "…" button, below the text
	const text = page.getByText("Website relaunch").element().getBoundingClientRect();
	const menu = document.querySelector("[data-popover]")!.getBoundingClientRect();
	expect(menu.left).toBeLessThan(text.right);
	await entry.click();
	expect(onTrash).toHaveBeenCalledOnce();
	await expect.element(entry).not.toBeInTheDocument();
});

test("the … button still opens it", async () => {
	await render(<Row />);
	await page.getByRole("button", { name: "Mehr" }).click();
	await expect.element(page.getByRole("button", { name: "Move to trash" })).toBeVisible();
});

test("a right click on the next row opens its menu, while the first one fades out", async () => {
	await render(
		<div style={{ paddingTop: 40 }}>
			<Row title="Small systems" />
			<Row extra="Make main place" title="Why offline" />
		</div>,
	);
	// the menu opens right of the mouse; the "…" button sits right of the text
	const first = page.getByText("Small systems");
	const { width } = first.element().getBoundingClientRect();
	await first.click({ button: "right", position: { x: width - 5, y: 8 } });
	await expect.element(page.getByRole("button", { name: "Move to trash" })).toBeVisible();
	// left of that, right below: where the fading menu would sit if it went back to its "…" button
	await page.getByText("Why offline").click({ button: "right", position: { x: width - 45, y: 8 } });
	await expect.element(page.getByRole("button", { name: "Make main place" })).toBeVisible();
});
