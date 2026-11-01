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
  return { item, link, row, href: `#/w/w1/i/${item.id}` };
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

test.each([
  ["Typen", "types"],
  ["Graph", "graph"],
])("the workspace's … menu leads to: %s", async (name, path) => {
  await setup();
  await page.getByRole("button", { name: "Aktionen für Test" }).click({ force: true });
  // the menu lies in a portal at the end: the last button of that name ("Typen" also folds the types)
  await page.getByRole("button", { name, exact: true }).last().click();
  expect(location.hash).toBe(`#/w/w1/${path}`);
});
