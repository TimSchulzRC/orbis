// "Typ bearbeiten" is laid out like the app's settings: Eigenschaften lists the properties, each
// opens a page of its own with a way back; a status option moves to another group from its colour.
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { SYS } from "@obtion/core/setup";
import { removeProp, upsertProp } from "@obtion/core/model";
import { ScopeContext } from "../../packages/ui/src/scope";
import { TypeEditor } from "../../packages/ui/src/views/TypeEditor";
import { useRepo } from "../../packages/ui/src/hooks";
import { noFiles, workspace } from "./workspace";

afterEach(() => cleanup());

/** As in the app: the editor gets the type anew after each change. */
function Host() {
  return <TypeEditor item={useRepo().get(SYS.project)!} onClose={() => {}} />;
}

async function setup() {
  const repo = await workspace(false);
  await render(
    <ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
      <Host />
    </ScopeContext.Provider>,
  );
  const dialog = page.getByRole("dialog");
  return { repo, dialog, schema: () => repo.get(SYS.project)!.schema! };
}

/** The editor opens on Allgemein; most tests go on to the properties. */
async function setupProps() {
  const s = await setup();
  await s.dialog.getByRole("navigation").getByRole("button", { name: /^Eigenschaften/ }).click();
  return s;
}

test("the editor opens on Allgemein", async () => {
  const { dialog, schema } = await setup();
  await expect.element(dialog.getByRole("navigation").getByRole("button", { name: "Allgemein" })).toHaveAttribute("aria-current", "page");
  await expect.element(dialog.getByRole("textbox").first()).toHaveValue(schema().name);
});

test("a property opens its page, and the arrow goes back to the list", async () => {
  const { dialog, schema } = await setupProps();
  const status = schema().properties.find((p) => p.kind === "status")!;
  await dialog.getByRole("button", { name: new RegExp("^" + status.name) }).first().click();
  await expect.element(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(status.name);
  await dialog.getByRole("button", { name: "Zurück", exact: true }).click();
  await expect.element(dialog.getByText("Oben als Badges")).toBeVisible();
});

test("removing a property shows the list again, its values stay", async () => {
  const { dialog, schema } = await setupProps();
  const prop = schema().properties.find((p) => p.kind === "date")!;
  await dialog.getByRole("button", { name: new RegExp("^" + prop.name) }).first().click();
  await dialog.getByRole("button", { name: "Eigenschaft entfernen", exact: true }).click();
  await expect.poll(() => schema().removedProperties.map((p) => p.id)).toContain(prop.id);
  await expect.element(dialog.getByText("Oben als Badges")).toBeVisible();
});

test("one step down moves a property after the next one", async () => {
  const { dialog, schema } = await setupProps();
  const [first, second] = schema().properties;
  await dialog.getByRole("button", { name: "Nach unten" }).first().click({ force: true });
  await expect.poll(() => schema().properties.slice(0, 2).map((p) => p.id)).toEqual([second!.id, first!.id]);
});

test("a status option moves to another group", async () => {
  const { dialog, schema } = await setupProps();
  const status = () => schema().properties.find((p) => p.kind === "status")!;
  const option = status().options!.find((o) => (o.group ?? "todo") === "active")!;
  await dialog.getByRole("button", { name: new RegExp("^" + status().name) }).first().click();
  const row = dialog.getByRole("textbox", { name: "Name der Option" }).and(page.elementLocator(document.querySelector(`input[value="${option.name}"]`)!));
  await page.elementLocator(row.element().closest("[draggable]")!).getByRole("button", { name: "Farbe und Gruppe" }).click();
  await page.getByRole("radio", { name: "Erledigt" }).click();
  await expect.poll(() => status().options!.find((o) => o.id === option.id)?.group).toBe("done");
});

test("the badges and the rows below are two cards, each sorted on its own", async () => {
  const { repo, dialog, schema } = await setupProps();
  const card = (title: string) => [...dialog.element().querySelectorAll("section")].find((s) => s.querySelector("h3")?.textContent === title)!;
  const names = (title: string) => [...card(title).querySelectorAll("[draggable] .font-medium")].map((e) => e.textContent);
  expect(names("Oben als Badges")).toEqual(["Status", "Priorität"]);
  expect(names("Darunter als Zeilen")).toEqual(["Zeitraum", "Zusammenfassung", "Fortschritt", "Blockiert durch"]);
  // the last badge has no step down into the rows
  const down = card("Oben als Badges").querySelectorAll('button[aria-label="Nach unten"]');
  expect((down[1] as HTMLButtonElement).disabled).toBe(true);
  // a selection made multiple leaves the badges
  repo.change(SYS.project, (d) => upsertProp(d, "p_priority", { multiple: true }));
  await expect.poll(() => names("Oben als Badges")).toEqual(["Status"]);
  expect(schema().properties.some((p) => p.id === "p_priority")).toBe(true);
});

test("the add button sits beside the heading; back from the new property, its row has the focus", async () => {
  const { dialog, schema } = await setupProps();
  const heading = dialog.getByRole("heading", { name: "Eigenschaften", level: 2 });
  expect(heading.element().parentElement!.querySelector("button")!.textContent).toContain("Eigenschaft hinzufügen");
  await dialog.getByRole("button", { name: "Eigenschaft hinzufügen" }).click();
  await page.getByPlaceholder("Name").fill("Budget");
  await page.getByRole("button", { name: "Hinzufügen", exact: true }).click();
  await expect.element(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Budget");
  // on a property's page there is no add button
  expect(dialog.getByRole("button", { name: "Eigenschaft hinzufügen" }).query()).toBeNull();
  await dialog.getByRole("button", { name: "Zurück", exact: true }).click();
  const row = dialog.getByRole("button", { name: /^Budget/ });
  await expect.element(row).toHaveFocus();
  expect(schema().properties.some((p) => p.name === "Budget")).toBe(true);
});

test("a type without properties shows one card with the button in it", async () => {
  const { repo, dialog, schema } = await setupProps();
  repo.change(SYS.project, (d) => schema().properties.forEach((p) => removeProp(d, p.id)));
  await expect.element(dialog.getByText("Noch keine Eigenschaften.")).toBeVisible();
  expect(dialog.getByText("Oben als Badges").query()).toBeNull();
  expect(dialog.getByRole("button", { name: "Eigenschaft hinzufügen" }).elements()).toHaveLength(1);
});
