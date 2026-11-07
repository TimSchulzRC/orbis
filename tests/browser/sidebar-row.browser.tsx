// A row of the sidebar tree opens its page wherever it is clicked (icon, empty space), except on
// its buttons: fold, "+" and "…".
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { sidebarChildren } from "@obtion/core/placement";
import { ScopeContext } from "../../packages/ui/src/scope";
import { SpaceTree } from "../../packages/ui/src/ui/Sidebar";
import type { Space } from "../../packages/ui/src/accounts";
import { noFiles, workspace } from "./workspace";
import { closeSettings, settingsOpen } from "../../packages/ui/src/ui/settings-open";
import { closeNewType, closeTypeEditor, newTypeOpen, typeEditing } from "../../packages/ui/src/ui/type-edit";
import { SYS } from "@obtion/core/setup";
import { setMeta } from "@obtion/core/model";

afterEach(() => (cleanup(), (location.hash = "")));

async function setup() {
  const repo = await workspace();
  const ix = repo.index();
  // a pinned item with children: its fold button is visible
  const item = repo.live().find((i) => i.pinned && i.title && sidebarChildren(i.id, ix, []).length)!;
  await render(
    <ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
      <div style={{ width: 256 }}>
        <SpaceTree space={{ id: "w1", name: "Test" } as Space} />
      </div>
    </ScopeContext.Provider>,
  );
  const link = page.getByRole("link", { name: item.title });
  const row = link.element().parentElement!;
  return { repo, item, link, row, href: `#/w/w1/i/${item.id}` };
}

/** Negative `x` counts from the row's right edge. */
const clickAt = (row: HTMLElement, x: number) => {
  const r = row.getBoundingClientRect();
  return page.elementLocator(row).click({ position: { x: x < 0 ? r.width + x : x, y: r.height / 2 } });
};

test("a click on the icon opens the page", async () => {
  const { row, href } = await setup();
  const icon = row.querySelector("svg:not(button svg)")!.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  await clickAt(row, icon.left - r.left + icon.width / 2);
  expect(location.hash).toBe(href);
});

test("a click on the empty space at the end opens the page", async () => {
  const { item, row, href } = await setup();
  // a short title leaves room between it and the buttons; the room left of the buttons
  const more = page.elementLocator(row).getByRole("button", { name: "Mehr" }).element().getBoundingClientRect();
  const r = row.getBoundingClientRect();
  expect(item.title.length).toBeGreaterThan(0);
  await clickAt(row, -(r.right - more.left) - 4);
  expect(location.hash).toBe(href);
});

test("the fold and … buttons do not open the page", async () => {
  const { row } = await setup();
  for (const name of ["Zuklappen", "Mehr"]) {
    location.hash = "";
    const button = row.querySelector(`button[aria-label="${name}"]`)!;
    await page.elementLocator(button).click({ force: true });
    expect(location.hash).toBe("");
  }
  // the fold button did its own job: the row is folded
  expect(row.querySelector('button[aria-label="Aufklappen"]')).not.toBeNull();
});

test("the workspace's … menu opens its settings in the settings dialog", async () => {
  await setup();
  await page.getByRole("button", { name: "Aktionen für Test" }).click({ force: true });
  await page.getByRole("button", { name: "Workspace-Einstellungen", exact: true }).click();
  expect(settingsOpen()).toMatchObject({ space: "w1" });
  closeSettings();
});

test("the workspace's … menu leads to the graph and no longer to a types page", async () => {
  await setup();
  await page.getByRole("button", { name: "Aktionen für Test" }).click({ force: true });
  await expect.element(page.getByRole("button", { name: "Graph", exact: true })).toBeVisible();
  // "Typen" is only the label that folds the types
  expect(page.getByRole("button", { name: "Typen", exact: true }).elements()).toHaveLength(1);
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  expect(location.hash).toBe("#/w/w1/graph");
});

test("the … next to Typen opens a new type for this workspace", async () => {
  await setup();
  await page.getByRole("button", { name: "Aktionen für Typen" }).click({ force: true });
  await page.getByRole("button", { name: "Neuer Typ", exact: true }).click();
  expect(newTypeOpen()).toBe("w1");
  closeNewType();
});

test("the … next to Typen brings back a deleted default type", async () => {
  const { repo } = await setup();
  repo.change(SYS.task, (d) => setMeta(d, { deleted: true }));
  await expect.poll(() => repo.get(SYS.task)?.deleted).toBe(true);
  await page.getByRole("button", { name: "Aktionen für Typen" }).click({ force: true });
  await page.getByRole("button", { name: "Standardtypen wiederherstellen", exact: true }).click();
  await expect.poll(() => repo.get(SYS.task)?.deleted).toBe(false);
});

test("a type's gear in the sidebar opens \"Typ bearbeiten\" in one click, over the page that is open", async () => {
  const { repo, href } = await setup();
  location.hash = href;
  const plural = repo.index().typePlural(SYS.task);
  const row = page.getByRole("navigation", { name: "Typen" }).getByRole("link", { name: plural, exact: true }).element().parentElement!;
  await page.elementLocator(row).getByRole("button", { name: "Typ bearbeiten", exact: true }).click({ force: true });
  expect(location.hash).toBe(href);
  expect(typeEditing()).toEqual({ id: SYS.task, space: "w1" });
  closeTypeEditor();
});
