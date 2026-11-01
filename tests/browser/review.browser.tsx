// The review (the tray's panel, sorting): one inbox entry at a time; sorting moves on and moves it
// in the list beside down under "Einsortiert", with its undo back up; the entry is edited right in the card.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ReviewPanel } from "../../packages/ui/src/views/Review";
import { workspace } from "./workspace";

beforeEach(async () => {
  await workspace();
  await render(
    <main>
      <ReviewPanel desktop />
    </main>,
  );
});
afterEach(() => cleanup());

const card = () => page.getByRole("article").getByRole("heading", { level: 2 });
const titleNow = () => document.querySelector("main article h2")?.textContent?.trim() ?? "";
/** The list beside: its rows as text, in order (the heads among them). */
const listRows = () => [...document.querySelectorAll("main aside li")].map((li) => li.textContent?.trim() ?? "");
const sortedBelow = (title: string) => {
  const rows = listRows();
  const head = rows.findIndex((r) => r.startsWith("Einsortiert"));
  const at = rows.findIndex((r) => r.startsWith(title));
  return head >= 0 && at > head;
};

describe("sorting", () => {
  test('"Anheften" moves on and moves the entry down under "Einsortiert"; its undo brings it back up', async () => {
    await expect.element(card()).toBeVisible();
    const title = titleNow();
    expect(sortedBelow(title)).toBe(false);
    await page.getByRole("button", { name: /Anheften/ }).click();
    await expect.poll(titleNow).not.toBe(title);
    await expect.poll(() => sortedBelow(title)).toBe(true);
    await page.getByRole("button", { name: `„${title}“ rückgängig machen` }).click();
    await expect.poll(titleNow).toBe(title);
    await expect.poll(() => sortedBelow(title)).toBe(false);
  });
});

describe("editing in the card", () => {
  test('a click on the title edits it, the keys rest, "Fertig" ends it', async () => {
    await expect.element(card()).toBeVisible();
    const title = titleNow();
    await card().click({ position: { x: 3, y: 12 } });
    const field = page.getByRole("article").getByRole("textbox").first();
    await expect.element(field).toHaveFocus();
    const hints = () => [...document.querySelectorAll<HTMLElement>("main kbd")].filter((k) => k.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
    expect(hints(), "the keys' hints hide").toHaveLength(0);
    await commands.keys("press", "Control+End");
    await commands.keys("type", " Xs"); // "s" is a letter here, not "später"
    await page.getByRole("button", { name: "Fertig" }).click();
    await expect.poll(titleNow).toBe(title + " Xs");
    await expect.poll(() => hints().length, { message: "and come back after it" }).toBeGreaterThan(0);
  });

  test('"Bearbeiten" puts the caret into the text; Esc ends it and keeps what was typed', async () => {
    await expect.element(card()).toBeVisible();
    await page.getByRole("button", { name: "Bearbeiten" }).click();
    await expect.poll(() => document.querySelector("main article .cm-editor.cm-focused")).not.toBeNull();
    await commands.keys("type", " Ys");
    await new Promise((r) => setTimeout(r, 300)); // the completions looked and found nothing (else Esc closes them first)
    await commands.keys("press", "Escape");
    await expect.poll(() => document.querySelector("main article textarea")).toBeNull();
    await expect.element(page.getByRole("article").getByText(/ Ys$/)).toBeVisible();
  });
});
