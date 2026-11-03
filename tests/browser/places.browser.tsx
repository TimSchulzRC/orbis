// Places of an entry that lies in more than one: "+N" in the path opens them right there, the home
// first with its path; each one can become the home or be removed, and another place added.
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ItemPage } from "../../packages/ui/src/views/ItemPage";
import { workspace } from "./workspace";

afterEach(() => cleanup());

test("+N in the path lists the places; make home and remove work from there", async () => {
  const repo = await workspace(false);
  const kunden = repo.create({ title: "Kunden", pinned: "a" });
  const nord = repo.create({ title: "Kunde Nord", parents: [kunden] });
  const intern = repo.create({ title: "Intern", pinned: "b" });
  const vertrieb = repo.create({ title: "Vertrieb", parents: [intern] });
  const page1 = repo.create({ title: "Marketing", parents: [nord, vertrieb] });
  await render(<ItemPage id={page1} isNew={false} />);

  // the places are no longer a section at the end of the page
  await expect.element(page.getByText("Marketing").first()).toBeVisible();
  expect(page.getByText("Bezüge").query()).toBeNull();

  await page.getByRole("button", { name: "+1" }).click();
  const places = page.getByRole("dialog").first();
  const links = places.getByRole("link");
  await expect.poll(() => links.elements().map((a) => a.textContent)).toEqual(["Kunde NordKunden", "VertriebIntern"]);
  await expect.element(places.getByText("Hauptort")).toBeVisible();

  // the second place becomes the home; the menu stays open and lists it first
  await places.getByRole("button", { name: "Mehr" }).nth(1).click();
  await page.getByRole("button", { name: "Als Hauptort" }).click();
  await expect.poll(() => repo.get(page1)!.home).toBe(vertrieb);
  await expect.poll(() => links.elements().map((a) => a.textContent)).toEqual(["VertriebIntern", "Kunde NordKunden"]);

  // removed from one place, the page has one left and "+N" is gone
  await places.getByRole("button", { name: "Mehr" }).nth(1).click();
  await page.getByRole("button", { name: "Hier entfernen" }).click();
  await expect.poll(() => Object.keys(repo.get(page1)!.parents)).toEqual([vertrieb]);
  expect(page.getByRole("button", { name: "+1" }).query()).toBeNull();
});

test("adding another place opens the place picker", async () => {
  const repo = await workspace(false);
  const a = repo.create({ title: "Arbeit", pinned: "a" });
  const b = repo.create({ title: "Privat", pinned: "b" });
  const id = repo.create({ title: "Notiz", parents: [a, b] });
  await render(<ItemPage id={id} isNew={false} />);
  await page.getByRole("button", { name: "+1" }).click();
  await page.getByRole("button", { name: "Weiteren Ort hinzufügen" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
});
