// The tray's panel: every row has the whole page one click away (an icon, shown on hover); what
// waits until tomorrow is folded below ("Morgen wieder") and can come back into the inbox now.
import { afterEach, beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { Repo } from "@obtion/sync";
import { setMeta } from "@obtion/core/model";
import { inbox } from "@obtion/core/placement";
import { tomorrow } from "@obtion/core/inbox";
import { ShelfPanel } from "../../packages/ui/src/ui/Shelf";
import { openShelf } from "../../packages/ui/src/ui/inbox";
import { workspace } from "./workspace";

let repo: Repo;
let title = "";

beforeEach(async () => {
  repo = await workspace();
  const waiting = inbox(repo.index())[0]!;
  title = waiting.title;
  repo.change(waiting.id, (d) => setMeta(d, { later: tomorrow() }));
  openShelf(); // the panel is one for the app: at the list, not at an entry a test before opened
  // away from the window's edge, as above the tray (at the edge a label moves inwards to stay whole)
  await render(
    <div style={{ width: 640, margin: "0 auto" }}>
      <ShelfPanel desktop pinned />
    </div>,
  );
});
afterEach(() => cleanup());

test("a row: workspace, title, text; on hover its buttons take the corner from the age", async () => {
  const row = page.getByRole("option").first();
  await expect.element(row).toBeVisible();
  expect(row.element().textContent?.normalize()).toContain("Persönlich".normalize());
  const open = row.getByRole("link", { name: "Ganz öffnen" });
  const buttons = () => getComputedStyle(open.element().parentElement!).opacity;
  const age = () => getComputedStyle(row.element().querySelector("time")?.parentElement ?? row.element()).visibility;
  await expect.poll(buttons).toBe("0");
  await row.hover();
  await expect.poll(buttons).toBe("1");
  await expect.poll(age).toBe("hidden");
  expect(open.element().getAttribute("href")).toMatch(/\/i\//);
  // only one back tomorrow has "back into the inbox now"
  await expect.element(row.getByRole("button", { name: "Jetzt zurück in den Eingang" })).not.toBeInTheDocument();
});

test('"Morgen wieder" lists what waits, folded; it opens in the panel and comes back into the inbox now', async () => {
  await expect.element(page.getByRole("option").getByText(title, { exact: true })).not.toBeInTheDocument();
  await page.getByRole("button", { name: /Morgen wieder · 1/ }).click();
  const waiting = page.getByRole("option").filter({ hasText: title });
  await waiting.hover();
  await expect.element(waiting.getByRole("button", { name: "Jetzt zurück in den Eingang" })).toBeVisible();
  await page.getByRole("option").getByText(title, { exact: true }).click();
  await expect.element(page.getByText("Kommt morgen wieder in den Eingang.")).toBeVisible();
  // the header: the whole page as an icon, nothing to close
  await expect.element(page.getByRole("link", { name: "Ganz öffnen" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Schließen" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Jetzt zurück in den Eingang" }).click();
  await expect.element(page.getByText("Bleibt im Eingang bis zum Einsortieren.")).toBeVisible();
});

test("a button's label shows quickly, centred above it", async () => {
  const row = page.getByRole("option").first();
  await row.hover();
  const open = row.getByRole("link", { name: "Ganz öffnen" });
  await open.hover();
  const tip = page.getByRole("tooltip");
  await expect.element(tip, { timeout: 600 }).toHaveTextContent("Ganz öffnen");
  const b = open.element().getBoundingClientRect();
  const box = document.querySelector("[data-radix-popper-content-wrapper] > *")!.getBoundingClientRect();
  expect(Math.abs(box.left + box.width / 2 - (b.left + b.width / 2))).toBeLessThan(2);
  expect(box.bottom).toBeLessThanOrEqual(b.top);
});
