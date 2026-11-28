// The inbox panel's list: every row has the whole page one click away (an icon, shown on hover); what
// waits until tomorrow is folded below ("Morgen wieder"), opens beside and can come back into the inbox
// now.

import { tomorrow } from "@orbis/core/inbox";
import { setMeta } from "@orbis/core/model";
import { inbox } from "@orbis/core/placement";
import type { Repo } from "@orbis/sync";
import { afterEach, beforeEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { openShelf } from "../../packages/ui/src/ui/inbox";
import { InboxPanel } from "../../packages/ui/src/views/Review";
import { workspace } from "./workspace";

let repo: Repo;
let title = "";

beforeEach(async () => {
	localStorage.removeItem("orbis.inbox.sorted");
	repo = await workspace();
	const waiting = inbox(repo.index())[0]!;
	title = waiting.title;
	repo.change(waiting.id, (d) => setMeta(d, { later: tomorrow() }));
	openShelf(); // the panel is one for the app: not at an entry a test before opened
	await render(
		<div style={{ width: 1040, height: 700, margin: "0 auto" }}>
			<InboxPanel desktop />
		</div>,
	);
});
afterEach(() => cleanup());

const rows = () =>
	page.getByRole("listitem").filter({ has: page.getByRole("button", { name: /.+/ }) });
const titleNow = () =>
	document.querySelector<HTMLTextAreaElement>("article textarea")?.value.trim() ?? "";

test("a row: workspace, title, text; on hover its buttons take the corner from the age", async () => {
	// the mouse is the page's, shared by all test files: off any row
	await commands.mouse("move", 0, 0);
	const row = rows().first();
	await expect.element(row).toBeVisible();
	expect(row.element().textContent).toContain("Personal");
	const open = row.getByRole("link", { name: "Ganz öffnen" });
	const buttons = () => getComputedStyle(open.element().parentElement!).opacity;
	const age = () =>
		getComputedStyle(row.element().querySelector("time")?.parentElement ?? row.element())
			.visibility;
	await expect.poll(buttons).toBe("0");
	await row.hover();
	await expect.poll(buttons).toBe("1");
	await expect.poll(age).toBe("hidden");
	expect(open.element().getAttribute("href")).toMatch(/\/i\//);
	// only one back tomorrow has "back into the inbox now"
	await expect
		.element(row.getByRole("button", { name: "Jetzt zurück in den Eingang" }))
		.not.toBeInTheDocument();
});

test('"Morgen wieder" lists what waits, folded; it opens beside and comes back into the inbox now', async () => {
	const later = page.getByRole("region", { name: "Morgen wieder" });
	await expect.element(later.getByText(title, { exact: true })).not.toBeInTheDocument();
	await page.getByRole("button", { name: /Morgen wieder · 1/ }).click();
	const waiting = later.getByRole("listitem").filter({ hasText: title });
	await waiting.hover();
	await expect
		.element(waiting.getByRole("button", { name: "Jetzt zurück in den Eingang" }))
		.toBeVisible();
	await later.getByText(title, { exact: true }).click();
	await expect.poll(titleNow).toBe(title);
	await page.getByRole("button", { name: /^Zurückholen/ }).click();
	await expect.element(page.getByRole("button", { name: /^Morgen/ }).first()).toBeVisible();
	await expect.element(later.getByText(title, { exact: true })).not.toBeInTheDocument();
});

test("Esc in the title leaves it and the keys are the panel's again", async () => {
	await expect.poll(titleNow).not.toBe("");
	const first = titleNow();
	await page.getByRole("article").getByRole("textbox", { name: "Titel" }).click();
	await commands.keys("press", "Escape");
	await commands.keys("press", "x"); // "Löschen": moves on
	await expect.poll(titleNow).not.toBe(first);
});

test("a button's label shows quickly, centred above it", async () => {
	const row = rows().first();
	await row.hover();
	const open = row.getByRole("link", { name: "Ganz öffnen" });
	await open.hover();
	const tip = page.getByRole("tooltip");
	await expect.element(tip, { timeout: 600 }).toHaveTextContent("Ganz öffnen");
	const b = open.element().getBoundingClientRect();
	const box = document
		.querySelector("[data-radix-popper-content-wrapper] > *")!
		.getBoundingClientRect();
	expect(Math.abs(box.left + box.width / 2 - (b.left + b.width / 2))).toBeLessThan(2);
	expect(box.bottom).toBeLessThanOrEqual(b.top);
});
