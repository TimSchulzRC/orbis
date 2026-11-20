// The inbox panel, sorting: one inbox entry at a time beside the list; sorting moves on and moves it
// in the list down under "Einsortiert", with its undo back up; the entry is edited right in the card.

import { setMeta } from "@orbis/core/model";
import { queryFence } from "@orbis/core/query";
import type { Repo } from "@orbis/sync";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { InboxPanel } from "../../packages/ui/src/views/Review";
import { workspace } from "./workspace";

const panel = () =>
	render(
		<main>
			<InboxPanel desktop />
		</main>,
	);
let repo: Repo;
beforeEach(async () => {
	localStorage.removeItem("orbis.inbox.sorted");
	repo = await workspace();
	await panel();
});
afterEach(() => cleanup());

const card = () => page.getByRole("article").getByRole("textbox", { name: "Titel" });
const titleNow = () =>
	document.querySelector<HTMLTextAreaElement>("main article textarea")?.value.trim() ?? "";
/** Whether the list shows the entry under "Einsortiert" (and no longer among those waiting). */
const sortedBelow = (title: string) => {
	const done = [...document.querySelectorAll("main section[aria-label=Einsortiert] li")].some(
		(li) => li.textContent?.trim().startsWith(title),
	);
	const waiting = [...document.querySelectorAll("main li [aria-current]")].some((b) =>
		b.textContent?.includes(title),
	);
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
		await expect
			.poll(() => document.querySelector("main section[aria-label=Einsortiert]"))
			.toBeNull();
		expect(JSON.parse(localStorage.getItem("orbis.inbox.sorted")!)).toEqual([]);
	});

	test('set aside with "Morgen", it waits again once it is due', async () => {
		await expect.element(card()).toBeVisible();
		const title = titleNow();
		await page.getByRole("button", { name: /Morgen/ }).click();
		await expect.poll(() => sortedBelow(title)).toBe(true);
		const id = repo.index().live.find((i) => i.title === title)!.id;
		repo.change(id, (d) => setMeta(d, { later: Date.now() - 1000 }));
		await expect
			.poll(() => document.querySelector("main section[aria-label=Einsortiert]"))
			.toBeNull();
		await expect
			.poll(() =>
				[...document.querySelectorAll("main li[data-row]")].some((li) =>
					li.textContent?.includes(title),
				),
			)
			.toBe(true);
	});
});

describe("editing in the card", () => {
	test("title and text are edited in place, no mode; typed there, a letter is no key of the panel", async () => {
		await expect.element(card()).toBeVisible();
		const title = titleNow();
		await card().click();
		await commands.keys("press", "Control+End");
		await commands.keys("type", " Xs"); // "s" is a letter here, not "später" (later)
		await page.getByRole("heading", { level: 2, name: "Einsortieren" }).click();
		await expect.poll(titleNow).toBe(`${title} Xs`);
		expect(page.getByRole("button", { name: "Bearbeiten" }).query()).toBeNull();
		expect(
			document.querySelector("main section[aria-label=Einsortiert]"),
			"nothing sorted",
		).toBeNull();
	});

	test("Esc leaves the text and keeps what was typed; the keys are the panel's again", async () => {
		await expect.element(card()).toBeVisible();
		const title = titleNow();
		await page.getByRole("article").getByRole("textbox").nth(1).click();
		await expect
			.poll(() => document.querySelector("main article .cm-editor.cm-focused"))
			.not.toBeNull();
		await commands.keys("press", "Control+End");
		await commands.keys("type", " Ys");
		await new Promise((r) => setTimeout(r, 300)); // the completions looked and found nothing (else Esc closes them first)
		await commands.keys("press", "Escape");
		await expect
			.poll(() => document.querySelector("main article .cm-editor.cm-focused"))
			.toBeNull();
		await expect.element(page.getByRole("article").getByText(/ Ys$/)).toBeVisible();
		await commands.keys("press", "s");
		await expect.poll(() => sortedBelow(title)).toBe(true);
	});
});

describe("the card's text", () => {
	test("a query shows its results, as on the note's page", async () => {
		await expect.element(card()).toBeVisible();
		const id = repo.index().live.find((i) => i.title === titleNow())!.id;
		repo
			.getDoc(id)
			.getText("body")
			.insert(0, `${queryFence('{"where":{"type":"task"}}')}\n`);
		await expect.poll(() => document.querySelector("main article .cm-queryblock")).not.toBeNull();
	});
});

describe("the list", () => {
	test("a click on a row shows that entry beside", async () => {
		await expect.element(card()).toBeVisible();
		const rows = [
			...document.querySelectorAll<HTMLButtonElement>("main li > button[aria-current]"),
		];
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
