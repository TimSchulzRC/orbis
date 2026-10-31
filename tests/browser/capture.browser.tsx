// Capturing: a note is preset; without a place it lands in the inbox, a page mentioned with @ is
// offered as its place.
import { afterEach, beforeEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { Repo } from "@obtion/sync";
import { Capture } from "../../packages/ui/src/ui/Capture";
import { workspace } from "./workspace";

let repo: Repo;
beforeEach(async () => {
  repo = await workspace();
  await render(<Capture anywhere />);
});
afterEach(() => cleanup());

const field = () => page.getByRole("textbox", { name: "Erfassen" });
const saved = (start: string) => repo.live().find((i) => i.title.startsWith(start));

test('a note is preset and "Einsortieren …" offered; saved without a place it is in the inbox', async () => {
  await field().click();
  await expect.element(page.getByRole("button", { name: "Typ: Notiz" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Einsortieren …/ })).toBeVisible();
  await field().fill("Notiz ohne Ort");
  await commands.keys("press", "Enter");
  await expect.poll(() => saved("Notiz ohne Ort")).toBeDefined();
  expect(Object.keys(saved("Notiz ohne Ort")!.parents)).toEqual([]);
  await expect.element(field()).toHaveValue("");
});

test("a page mentioned with @ is offered as the place and the note goes below it", async () => {
  await field().click();
  await field().fill("Frage zu @Arbeit");
  await page.getByRole("button", { name: "In Arbeit einsortieren?" }).click();
  await field().click();
  await commands.keys("press", "Enter");
  await expect.poll(() => saved("Frage zu")).toBeDefined();
  expect(Object.keys(saved("Frage zu")!.parents)).toEqual(["ex-work"]);
});
