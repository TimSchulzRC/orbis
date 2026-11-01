// A right click opens the "…" menu of a row at the mouse, with the same entries; the "…" button
// still opens it below itself.
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { MenuItem, MoreMenu, useContextMenu } from "../../packages/ui/src/ui/primitives";

const onTrash = vi.fn();
function Row() {
  const menu = useContextMenu();
  return (
    <div onContextMenu={menu.onContextMenu} style={{ display: "flex", gap: 8, padding: 40 }}>
      <span>Website-Relaunch</span>
      <MoreMenu menu={menu}>
        {(close) => (
          <MenuItem danger onClick={() => (close(), onTrash())}>
            In den Papierkorb
          </MenuItem>
        )}
      </MoreMenu>
    </div>
  );
}
afterEach(() => (cleanup(), onTrash.mockClear()));

test("a right click opens the menu at the mouse, its entries work", async () => {
  await render(<Row />);
  await page.getByText("Website-Relaunch").click({ button: "right" });
  const entry = page.getByRole("button", { name: "In den Papierkorb" });
  await expect.element(entry).toBeVisible();
  // at the mouse: left of the "…" button, below the text
  const text = page.getByText("Website-Relaunch").element().getBoundingClientRect();
  const menu = document.querySelector("[data-popover]")!.getBoundingClientRect();
  expect(menu.left).toBeLessThan(text.right);
  await entry.click();
  expect(onTrash).toHaveBeenCalledOnce();
  await expect.element(entry).not.toBeInTheDocument();
});

test("the … button still opens it", async () => {
  await render(<Row />);
  await page.getByRole("button", { name: "Mehr" }).click();
  await expect.element(page.getByRole("button", { name: "In den Papierkorb" })).toBeVisible();
});
