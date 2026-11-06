// The quick note: the tray's button opens one new note as a card, written with the page's editor and
// sorted at once with the inbox's choices. It joins the inbox once something is in it; left empty, it goes.
import { afterEach, beforeEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { Repo } from "@obtion/sync";
import { queryFence } from "@obtion/core/query";
import { Tray } from "../../packages/ui/src/ui/Tray";
import { closeQuickNote } from "../../packages/ui/src/ui/QuickNote";
import { workspace } from "./workspace";

let repo: Repo;
beforeEach(async () => {
  repo = await workspace();
  // at the foot of the window, as in the app: the card opens above it
  await render(
    <div className="fixed inset-x-0 bottom-0">
      <Tray desktop />
    </div>,
  );
});
afterEach(() => (closeQuickNote(), cleanup()));

const field = () => page.getByRole("button", { name: "Neue Notiz" });
const card = () => page.getByRole("dialog", { name: "Neue Notiz" });
const titleField = () => card().getByRole("textbox", { name: "Titel" });
const found = (title: string) => repo.live().find((i) => i.title === title);
const open = async () => {
  await field().click();
  await expect.element(titleField()).toHaveFocus();
};

test("a title, Enter into the text, ⌘↵: the note lies in the inbox, the card closes", async () => {
  await open();
  await commands.keys("type", "Gespräch mit Lena");
  await commands.keys("press", "Enter");
  await expect.poll(() => document.querySelector("[data-quick-note] .cm-editor.cm-focused")).not.toBeNull();
  await commands.keys("type", "Termin verschiebt sich");
  await commands.keys("press", "Control+Enter");
  await expect.poll(() => document.querySelector("[data-quick-note]")).toBeNull();
  const note = found("Gespräch mit Lena")!;
  expect(note.body).toBe("Termin verschiebt sich");
  expect(Object.keys(note.parents)).toEqual([]);
  expect(note.type).toBeNull();
});

test("Esc closes the card; the note lies in the inbox, the button starts a new one", async () => {
  await open();
  await commands.keys("type", "Halber Gedanke");
  await commands.keys("press", "Escape");
  await expect.poll(() => document.querySelector("[data-quick-note]")).toBeNull();
  await expect.poll(() => found("Halber Gedanke")).toBeTruthy();
  await field().click();
  await expect.element(titleField()).toHaveValue("");
});

test("left empty, the note goes", async () => {
  const before = repo.live().length;
  await open();
  await commands.keys("press", "Escape");
  await expect.poll(() => document.querySelector("[data-quick-note]")).toBeNull();
  await expect.poll(() => repo.live().length).toBe(before);
  await expect.element(page.getByRole("button", { name: "Neue Notiz" })).toBeVisible();
});

test("the inbox counts the note only once something is in it", async () => {
  const count = () => Number(document.querySelector("[aria-label^='Eingang: ']")?.getAttribute("aria-label")?.match(/\d+/)?.[0]);
  const before = count();
  await open();
  await new Promise((r) => setTimeout(r, 300));
  expect(count()).toBe(before);
  await commands.keys("type", "Erster Gedanke");
  await commands.keys("press", "Enter");
  await commands.keys("type", "und mehr");
  await expect.poll(count).toBe(before + 1);
});

test('the inbox\'s choices are there but "Löschen"; "Anheften" sorts the note and closes the card', async () => {
  await open();
  for (const name of ["Einsortieren", "Typ", "Morgen", "Anheften"]) await expect.element(card().getByRole("button", { name })).toBeVisible();
  expect(card().getByRole("button", { name: "Löschen" }).query()).toBeNull();
  await commands.keys("type", "Wichtig");
  await card().getByRole("button", { name: "Anheften" }).click();
  await expect.poll(() => document.querySelector("[data-quick-note]")).toBeNull();
  expect(found("Wichtig")?.pinned).toBeTruthy();
});

test("a query in the text shows its results, as on the note's page", async () => {
  await open();
  const note = [...repo.live()].sort((a, b) => b.created - a.created)[0]!;
  repo.getDoc(note.id).getText("body").insert(0, queryFence('{"where":{"type":"task"}}') + "\n");
  await expect.poll(() => document.querySelector("[data-quick-note] .cm-queryblock")).not.toBeNull();
});

test("on the pinned inbox (Heute), a click on the dimmed inbox beside the card closes it", async () => {
  await cleanup();
  await render(
    <div className="fixed inset-0 flex flex-col justify-end">
      <Tray desktop pinned />
    </div>,
  );
  await open();
  await commands.keys("type", "Neben der Karte");
  const beside = document.querySelector<HTMLElement>("[data-quick-beside]")!.getBoundingClientRect();
  await commands.mouse("click", beside.left + 20, beside.top + 20);
  await expect.poll(() => document.querySelector("[data-quick-note]")).toBeNull();
  await expect.poll(() => found("Neben der Karte")).toBeTruthy();
});
