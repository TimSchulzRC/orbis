// The inbox panel, sorting: one inbox entry at a time beside the list; sorting moves on and moves it
// in the list down under "Einsortiert", with its undo back up; the entry is edited right in the card.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { InboxPanel } from "../../packages/ui/src/views/Review";
import type { Repo } from "@obtion/sync";
import { setMeta } from "@obtion/core/model";
import { queryFence } from "@obtion/core/query";
import { workspace } from "./workspace";

const panel = () =>
  render(
    <main>
      <InboxPanel desktop />
    </main>,
  );
let repo: Repo;
beforeEach(async () => {
  localStorage.removeItem("obtion.inbox.sorted");
  repo = await workspace();
  await panel();
});
afterEach(() => cleanup());

const card = () => page.getByRole("article").getByRole("heading", { level: 2 });
const titleNow = () => document.querySelector("main article h2")?.textContent?.trim() ?? "";
/** Whether the list shows the entry under "Einsortiert" (and no longer among those waiting). */
const sortedBelow = (title: string) => {
  const done = [...document.querySelectorAll("main section[aria-label=Einsortiert] li")].some((li) => li.textContent?.trim().startsWith(title));
  const waiting = [...document.querySelectorAll("main li [aria-current]")].some((b) => b.textContent?.includes(title));
  return done && !waiting;
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

describe('"Einsortiert"', () => {
  test("stays after the panel is opened anew (as after a reload), until cleared by hand", async () => {
    await expect.element(card()).toBeVisible();
    const title = titleNow();
    await page.getByRole("button", { name: /Anheften/ }).click();
    await expect.poll(() => sortedBelow(title)).toBe(true);
    await cleanup();
    await panel();
    await expect.poll(() => sortedBelow(title)).toBe(true);
    await page.getByRole("button", { name: "Einsortiert leeren" }).click();
    await expect.poll(() => document.querySelector("main section[aria-label=Einsortiert]")).toBeNull();
    expect(JSON.parse(localStorage.getItem("obtion.inbox.sorted")!)).toEqual([]);
  });

  test('set aside with "Morgen", it waits again once it is due', async () => {
    await expect.element(card()).toBeVisible();
    const title = titleNow();
    await page.getByRole("button", { name: /Morgen/ }).click();
    await expect.poll(() => sortedBelow(title)).toBe(true);
    const id = repo.index().live.find((i) => i.title === title)!.id;
    repo.change(id, (d) => setMeta(d, { later: Date.now() - 1000 }));
    await expect.poll(() => document.querySelector("main section[aria-label=Einsortiert]")).toBeNull();
    await expect.poll(() => [...document.querySelectorAll("main li[data-row]")].some((li) => li.textContent?.includes(title))).toBe(true);
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

  test("a click elsewhere in the panel (its head) ends editing", async () => {
    await expect.element(card()).toBeVisible();
    await page.getByRole("button", { name: "Bearbeiten" }).click();
    await expect.poll(() => document.querySelector("main article textarea")).not.toBeNull();
    await page.getByRole("heading", { level: 2, name: "Einsortieren" }).click();
    await expect.poll(() => document.querySelector("main article textarea")).toBeNull();
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

describe("the card's text", () => {
  test("a query shows its results while read, as on the note's page", async () => {
    await expect.element(card()).toBeVisible();
    const id = repo.index().live.find((i) => i.title === titleNow())!.id;
    repo.getDoc(id).getText("body").insert(0, queryFence('{"where":{"type":"task"}}') + "\n");
    await expect.poll(() => document.querySelector("main article .cm-queryblock")).not.toBeNull();
    expect(document.querySelector("main article textarea"), "still read, not edited").toBeNull();
  });
});

describe("the list", () => {
  test("a click on a row shows that entry beside", async () => {
    await expect.element(card()).toBeVisible();
    const rows = [...document.querySelectorAll<HTMLButtonElement>("main li > button[aria-current]")];
    const other = rows.find((b) => b.getAttribute("aria-current") === "false")!;
    const title = other.querySelector("span.font-medium")?.textContent ?? "";
    other.click();
    await expect.poll(titleNow).toBe(title);
    await expect.poll(() => other.getAttribute("aria-current")).toBe("true");
  });
});

describe("the head", () => {
  test("no estimate of how long sorting takes", async () => {
    await expect.element(card()).toBeVisible();
    expect(document.querySelector("main header")?.textContent).not.toMatch(/Min\./);
  });

  test("the close button sits as far from the top as from the right", async () => {
    const close = page.getByRole("button", { name: "Schließen" });
    await expect.element(close).toBeVisible();
    const panel = document.querySelector("[role=dialog]")!.getBoundingClientRect();
    const icon = close.element().querySelector("svg")!.getBoundingClientRect();
    expect(Math.abs(icon.top - panel.top - (panel.right - icon.right))).toBeLessThanOrEqual(1);
  });
});
