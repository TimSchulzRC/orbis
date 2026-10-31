// The review: one inbox entry at a time; sorting moves on and lists it under "Erledigt" with its
// undo; the entry is edited right in the card.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { Review } from "../../packages/ui/src/views/Review";
import { workspace } from "./workspace";

beforeEach(async () => {
  await workspace();
  await render(
    <main>
      <Review />
    </main>,
  );
});
afterEach(() => cleanup());

const card = () => page.getByRole("article").getByRole("heading", { level: 2 });
const titleNow = () => document.querySelector("main article h2")?.textContent?.trim() ?? "";

describe("sorting", () => {
  test('"Lose behalten" moves on and lists the entry under "Erledigt"; its undo brings it back', async () => {
    await expect.element(card()).toBeVisible();
    const title = titleNow();
    await page.getByRole("button", { name: /Lose behalten/ }).click();
    await expect.poll(titleNow).not.toBe(title);
    await expect.poll(() => document.querySelector("section[aria-label='Erledigt']")?.textContent ?? "").toContain(title);
    await page.getByRole("button", { name: `„${title}“ rückgängig machen` }).click();
    await expect.poll(titleNow).toBe(title);
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
