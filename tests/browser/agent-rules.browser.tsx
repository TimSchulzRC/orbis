// "Regeln für Agenten" on an item: only agents act on them, so the page shows just an icon after the
// tags that opens them in a dialog, saved when the field is left (one step), with what applies from above.
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ItemPage } from "../../packages/ui/src/views/ItemPage";
import { workspace } from "./workspace";

afterEach(() => cleanup());

test("not on the page; the icon after the tags opens them, inherited ones link to their owners", async () => {
  const repo = await workspace(false);
  const root = repo.create({ title: "Beratung", pinned: "a", rules: "Nie in Produktion schreiben." });
  const kunde = repo.create({ title: "Kunde Nord", parents: [root] });
  await render(<ItemPage id={kunde} isNew={false} />);

  // rules apply from above, yet the page does not show them
  await expect.element(page.getByText("Kunde Nord").first()).toBeVisible();
  expect(page.getByText("Regeln für Agenten").query()).toBeNull();

  // the icon opens the dialog, the focus in the field; the page menu no longer has them
  await page.getByRole("button", { name: "Mehr" }).first().click();
  expect(page.getByRole("button", { name: "Regeln für Agenten" }).elements()).toHaveLength(1);
  await commands.keys("press", "Escape");
  await page.getByRole("button", { name: "Regeln für Agenten" }).click();
  const dialog = page.getByRole("dialog", { name: "Regeln für Agenten" });
  const field = dialog.getByRole("textbox", { name: "Regeln für Agenten" });
  await expect.element(field).toHaveFocus();
  await expect.element(dialog.getByRole("link", { name: "Beratung" })).toHaveAttribute("href", expect.stringContaining(root));

  await field.fill("Vor dem Senden fragen.");
  expect(repo.get(kunde)!.rules).toBe(""); // saved when left, not on every key
  await dialog.getByText("Außerdem gelten Regeln von").click();
  await expect.poll(() => repo.get(kunde)!.rules).toBe("Vor dem Senden fragen.");

  // a change from elsewhere (an agent) shows while the field has no focus
  repo.setRules(kunde, "Neu vom Agent.");
  await expect.element(field).toHaveValue("Neu vom Agent.");

  // closing while typing keeps what was typed
  await field.fill("Zuletzt getippt.");
  await commands.keys("press", "Escape");
  await expect.poll(() => repo.get(kunde)!.rules).toBe("Zuletzt getippt.");
  expect(page.getByText("Zuletzt getippt.").query()).toBeNull();
});
