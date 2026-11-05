// The quick note: the tray's field takes the title where it was clicked, Enter grows it into a card,
// written with the page's editor and sorted at once with the inbox's choices. Closed, the note stays
// as the draft; left empty, it goes.
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

const field = () => page.getByRole("textbox", { name: "Neue Notiz" });
const draftField = () => page.getByRole("button", { name: /Entwurf:/ });
const card = () => page.getByRole("dialog", { name: "Neue Notiz" });
const titleField = () => card().getByRole("textbox", { name: "Titel" });
const found = (title: string) => repo.live().find((i) => i.title === title);
const open = async () => {
  await field().click();
  await commands.keys("press", "Enter");
  await expect.element(titleField()).toHaveFocus();
};

test("the title typed into the field itself, Enter grows the card with the caret in the text, ⌘↵: the note lies in the inbox", async () => {
  await field().click();
  await commands.keys("type", "Gespräch mit Lena");
  expect(document.querySelector("[data-quick-note]")).toBeNull();
  await commands.keys("press", "Enter");
  await expect.element(titleField()).toHaveValue("Gespräch mit Lena");
  await expect.poll(() => document.querySelector("[data-quick-note] .cm-editor.cm-focused")).not.toBeNull();
  await commands.keys("type", "Termin verschiebt sich");
  await commands.keys("press", "Control+Enter");
  await expect.poll(() => document.querySelector("[data-quick-note]")).toBeNull();
  const note = found("Gespräch mit Lena")!;
  expect(note.body).toBe("Termin verschiebt sich");
  expect(Object.keys(note.parents)).toEqual([]);
  expect(note.type).toBeNull();
});

test("Esc keeps the draft: the field names it and opens it again", async () => {
  await open();
  await commands.keys("type", "Halber Gedanke");
  await commands.keys("press", "Escape");
  await expect.poll(() => document.querySelector("[data-quick-note]")).toBeNull();
  await expect.element(page.getByRole("button", { name: "Entwurf: Halber Gedanke" })).toBeVisible();
  await draftField().click();
  await expect.element(titleField()).toHaveValue("Halber Gedanke");
  expect(repo.live().filter((i) => i.title === "Halber Gedanke")).toHaveLength(1);
});

test("left empty, the note goes", async () => {
  const before = repo.live().length;
  await open();
  await commands.keys("press", "Escape");
  await expect.poll(() => document.querySelector("[data-quick-note]")).toBeNull();
  await expect.poll(() => repo.live().length).toBe(before);
  await expect.element(field()).toBeVisible();
});

test("⌘↵ in the field files the title alone; Esc there keeps it as the draft", async () => {
  await field().click();
  await commands.keys("type", "Nur ein Titel");
  await commands.keys("press", "Control+Enter");
  await expect.poll(() => found("Nur ein Titel")).toBeTruthy();
  expect(document.querySelector("[data-quick-note]")).toBeNull();
  await expect.element(field()).toHaveValue("");
  await field().click();
  await commands.keys("type", "Später");
  await commands.keys("press", "Escape");
  await expect.element(page.getByRole("button", { name: "Entwurf: Später" })).toBeVisible();
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
