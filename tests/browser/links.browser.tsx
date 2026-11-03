// Links of a page, both ways, behind one button in the page head: its number counts all of them,
// a click lists "Verlinkt von" and "Verweist auf". The page has no section for them at the end.
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ItemPage } from "../../packages/ui/src/views/ItemPage";
import { workspace } from "./workspace";

afterEach(() => cleanup());

test("the button counts links both ways and lists them; a ref outside the text can be removed", async () => {
  const repo = await workspace(false);
  const home = repo.create({ title: "Arbeit", pinned: "a" });
  const roadmap = repo.create({ title: "Roadmap 2027", parents: [home] });
  const relaunch = repo.create({ title: "Website-Relaunch", parents: [home] });
  const id = repo.create({ title: "Marketing", parents: [home], body: "Stand unter [[Website-Relaunch]]." });
  repo.create({ title: "So funktioniert Obtion", parents: [home], body: "Siehe [[Marketing]]." });
  repo.setMember(id, "refs", roadmap, true);
  await render(<ItemPage id={id} isNew={false} />);

  // one incoming, two outgoing (one in the text, one set by hand)
  const button = page.getByRole("button", { name: "3 Links" });
  await expect.element(button).toBeVisible();
  expect(page.getByText("Bezüge").query()).toBeNull();
  expect(page.getByText("Verlinkt von").query()).toBeNull();

  await button.click();
  const menu = page.getByRole("dialog");
  await expect.element(menu.getByText(/^Verlinkt von/)).toBeVisible();
  await expect.element(menu.getByText(/^Verweist auf/)).toBeVisible();
  expect(menu.getByRole("link").elements().map((a) => a.textContent)).toEqual(["So funktioniert Obtion", "Website-Relaunch", "Roadmap 2027"]);
  await expect.element(menu.getByRole("link", { name: "Website-Relaunch" })).toHaveAttribute("href", expect.stringContaining(relaunch));

  // only the ref outside the text has a remove button
  expect(menu.getByRole("button", { name: "Ref entfernen" }).elements()).toHaveLength(1);
  await menu.getByRole("button", { name: "Ref entfernen" }).click();
  await expect.poll(() => repo.get(id)!.refs).toEqual([]);
  await expect.element(page.getByRole("button", { name: "2 Links" })).toBeVisible();
});

test("no links, no button", async () => {
  const repo = await workspace(false);
  const id = repo.create({ title: "Allein", pinned: "a" });
  await render(<ItemPage id={id} isNew={false} />);
  await expect.element(page.getByText("Allein").first()).toBeVisible();
  expect(page.getByRole("button", { name: /Links$/ }).query()).toBeNull();
});
