// Updates of a page: the newest as a line in the head, all of them in a panel. The panel keeps a
// draft when closed, posts with Ctrl+Enter, hands the focus back, and marks agent updates as new
// until they were on screen once.
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { appendUpdate } from "@obtion/core/model";
import { SYS } from "@obtion/core/setup";
import { ItemPage } from "../../packages/ui/src/views/ItemPage";
import { workspace } from "./workspace";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("the line opens the panel; a draft survives closing; Ctrl+Enter posts; the focus comes back", async () => {
  const repo = await workspace(false);
  const project = repo.create({ title: "Relaunch", type: SYS.project, pinned: "a" });
  const cms = repo.create({ title: "CMS", type: SYS.project, parents: [project] });
  repo.change(project, (d) => appendUpdate(d, { at: Date.now() - 3600_000, text: "Kickoff war gut.", by: "you" }));
  repo.change(cms, (d) => appendUpdate(d, { at: Date.now() - 60_000, text: "Entscheidung hängt.", by: "agent:claude" }));
  await render(<ItemPage id={project} isNew={false} />);

  // the newest update is in the head, from the page below, with the count of new ones
  const line = page.getByRole("button", { name: /Letztes Update.*1 neu.*Alle 2 Updates öffnen/ });
  await expect.element(line).toBeVisible();
  await expect.element(line.getByText("Entscheidung hängt.")).toBeVisible();
  await expect.element(line.getByText("CMS").first()).toBeVisible();

  // reading: the focus is on the panel, not in the text box; the new one is marked
  await line.click();
  const panel = page.getByRole("dialog", { name: "Updates" });
  await expect.element(panel).toHaveFocus();
  await expect.element(panel.getByText("neu", { exact: true })).toBeVisible();

  // a draft survives Escape, and the focus is back on the line
  const box = panel.getByRole("textbox", { name: "Update zu Relaunch schreiben" });
  await box.fill("Mockups sind fertig.");
  await commands.keys("press", "Escape");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: /Letztes Update/ })).toHaveFocus();
  // seen once: no longer new
  await expect.element(page.getByRole("button", { name: /Letztes Update/ })).not.toHaveAccessibleName(/neu/);

  await page.getByRole("button", { name: /Letztes Update/ }).click();
  await expect.element(box).toHaveValue("Mockups sind fertig.");
  expect(panel.getByText("neu", { exact: true }).query()).toBeNull();

  // Enter makes a new line, Ctrl+Enter posts
  await box.click();
  await commands.keys("press", "Enter");
  expect(repo.get(project)!.updates).toHaveLength(1);
  await commands.keys("press", "Control+Enter");
  await expect.poll(() => repo.get(project)!.updates.map((u) => u.text)).toContain("Mockups sind fertig.");
  await expect.element(box).toHaveValue("");

  // "Nur diese Seite" leaves out the page below
  await panel.getByRole("radio", { name: "Nur diese Seite" }).click();
  await expect.element(panel.getByText("Entscheidung hängt.")).not.toBeInTheDocument();
  await expect.element(panel.getByText("Kickoff war gut.")).toBeVisible();
});

test("a page without updates offers to write the first, with the focus in the box", async () => {
  const repo = await workspace(false);
  const project = repo.create({ title: "Newsletter", type: SYS.project, pinned: "a" });
  await render(<ItemPage id={project} isNew={false} />);
  await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
  const box = page.getByRole("dialog", { name: "Updates" }).getByRole("textbox", { name: "Update zu Newsletter schreiben" });
  await expect.element(box).toHaveFocus();
  await expect.element(page.getByRole("dialog").getByText("Noch keine Updates.")).toBeVisible();
});
