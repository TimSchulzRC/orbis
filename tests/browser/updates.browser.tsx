// Updates of a page: the newest as a line in the head, all of them in a panel. The panel keeps a
// draft when closed, posts with Ctrl+Enter, hands the focus back, and marks agent updates as new
// until they were on screen once.
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { useState } from "react";
import { appendUpdate } from "@obtion/core/model";
import { SYS } from "@obtion/core/setup";
import { ItemPage } from "../../packages/ui/src/views/ItemPage";
import { AppToaster } from "../../packages/ui/src/ui/toasts";
import { ConfirmHost } from "../../packages/ui/src/ui/feedback";
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
  const line = page.getByRole("button", { name: /^Neues Update, .*Claude, CMS\. 1 neu\. Alle 2 Updates öffnen/ });
  await expect.element(line).toBeVisible();
  await expect.element(line.getByText("Entscheidung hängt.")).toBeVisible();
  // an unread one is not called the latest
  expect(line.element().textContent).toMatch(/^Neues Update/);
  await expect.element(line.getByText("CMS").first()).toBeVisible();

  // reading: the focus is on the panel, not in the text box; the new one is marked
  await line.click();
  const panel = page.getByRole("dialog", { name: /^Updates zu / });
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

  // without "Mit Unterseiten", the page below is left out
  await panel.getByRole("checkbox", { name: "Mit Unterseiten" }).click();
  await expect.element(panel.getByText("Entscheidung hängt.")).not.toBeInTheDocument();
  await expect.element(panel.getByText("Kickoff war gut.")).toBeVisible();
  await panel.getByRole("button", { name: "Schließen" }).click();
});

test("a page without updates offers to write the first, with the focus in the box", async () => {
  const repo = await workspace(false);
  const project = repo.create({ title: "Newsletter", type: SYS.project, pinned: "a" });
  await render(<ItemPage id={project} isNew={false} />);
  await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
  const box = page.getByRole("dialog", { name: /^Updates zu / }).getByRole("textbox", { name: "Update zu Newsletter schreiben" });
  await expect.element(box).toHaveFocus();
  await expect.element(page.getByRole("dialog").getByText("Noch keine Updates.")).toBeVisible();
  await commands.keys("press", "Escape");
});

test("wide: the panel docks beside the page, which stays in use; only what was on screen counts as read", async () => {
  await page.viewport(1440, 900);
  const repo = await workspace(false);
  const project = repo.create({ title: "Relaunch", type: SYS.project, pinned: "a" });
  const other = repo.create({ title: "Website", type: SYS.project, pinned: "b" });
  for (let n = 0; n < 40; n++) repo.change(project, (d) => appendUpdate(d, { at: Date.now() - (40 - n) * 3600_000, text: `Stand ${n}`, by: "agent:claude" }));
  let go: (id: string) => void = () => {};
  function Shown() {
    const [id, setId] = useState(project);
    go = setId;
    return <ItemPage id={id} isNew={false} />;
  }
  await render(<Shown />);

  await page.getByRole("button", { name: /^Neues Update, .*40 neu/ }).click();
  const panel = page.getByRole("dialog", { name: /^Updates zu / });
  await expect.element(panel).toBeVisible();
  // beside the page: no backdrop, the page makes room
  expect(document.querySelector("[data-slot=dialog-overlay]")).toBeNull();
  expect(document.documentElement.hasAttribute("data-side-panel")).toBe(true);
  await expect.element(panel.getByRole("button", { name: "Ältere zeigen (10)" })).toBeInTheDocument();

  // Escape in the page is the page's: the panel stays
  await page.getByRole("textbox", { name: "Titel" }).click();
  await commands.keys("press", "Escape");
  await expect.element(panel).toBeVisible();

  // a draft goes along to another page and back; docked, the panel opens there too
  await panel.getByRole("textbox", { name: "Update zu Relaunch schreiben" }).fill("Halb geschrieben");
  go(other);
  await expect.element(page.getByRole("dialog").getByRole("textbox", { name: "Update zu Website schreiben" })).toHaveValue("");
  go(project);
  await expect.element(page.getByRole("dialog").getByRole("textbox", { name: "Update zu Relaunch schreiben" })).toHaveValue("Halb geschrieben");

  // closed without scrolling: the older ones below the fold are still new
  await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(document.documentElement.hasAttribute("data-side-panel")).toBe(false);
  // the ones on screen are read, one by one: fewer are new, but not none
  const left = Number(/(\d+) neu/.exec(page.getByRole("button", { name: /^Neues Update, / }).element().getAttribute("aria-label")!)![1]);
  expect(left).toBeGreaterThan(0);
  expect(left).toBeLessThan(40);
  await page.viewport(1280, 900);
});

test("the button in the top bar opens the panel too, says what is new, and gets the focus back", async () => {
  const repo = await workspace(false);
  const project = repo.create({ title: "Relaunch", type: SYS.project, pinned: "a" });
  repo.change(project, (d) => appendUpdate(d, { at: Date.now() - 60_000, text: "Entscheidung hängt.", by: "agent:claude" }));
  await render(<ItemPage id={project} isNew={false} />);
  const button = page.getByRole("button", { name: "Updates, 1 neu" });
  await button.click();
  const panel = page.getByRole("dialog", { name: /^Updates zu / });
  await expect.element(panel.getByText("Entscheidung hängt.")).toBeVisible();
  await commands.keys("press", "Escape");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Updates", exact: true })).toHaveFocus();
});

test("an update can be deleted, and put back with Rückgängig", async () => {
  const repo = await workspace(false);
  const project = repo.create({ title: "Relaunch", type: SYS.project, pinned: "a" });
  repo.change(project, (d) => appendUpdate(d, { at: Date.now() - 7200_000, text: "Erstes.", by: "you" }));
  repo.change(project, (d) => appendUpdate(d, { at: Date.now() - 60_000, text: "Vertippt.", by: "you" }));
  await render(
    <>
      <ItemPage id={project} isNew={false} />
      <AppToaster />
      <ConfirmHost />
    </>,
  );
  await page.getByRole("button", { name: /Letztes Update/ }).click();
  const panel = page.getByRole("dialog", { name: /^Updates zu / });
  // asked first: cancelling keeps it
  await panel.getByRole("button", { name: "Update löschen" }).first().click();
  const ask = page.getByRole("dialog", { name: "Update löschen?" });
  await expect.element(ask.getByText("„Vertippt.“", { exact: false })).toBeVisible();
  await ask.getByRole("button", { name: "Abbrechen" }).click();
  expect(repo.get(project)!.updates).toHaveLength(2);
  await panel.getByRole("button", { name: "Update löschen" }).first().click();
  await page.getByRole("dialog", { name: "Update löschen?" }).getByRole("button", { name: "Löschen" }).click();
  await expect.poll(() => repo.get(project)!.updates.map((u) => u.text)).toEqual(["Erstes."]);
  await expect.element(panel.getByText("Vertippt.")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Rückgängig" }).click();
  await expect.poll(() => repo.get(project)!.updates.map((u) => u.text)).toEqual(["Erstes.", "Vertippt."]);
  await expect.element(panel.getByText("Vertippt.")).toBeVisible();
  await panel.getByRole("button", { name: "Schließen" }).click();
});
