// The inbox panel, where the user works: one inbox entry at a time beside the list. Sorting and
// typing keep it there; "Erledigt", "Morgen" and "Löschen" move on and move it in the list down
// under "Erledigt", with its undo back up; the entry is edited right in the card. The list shows
// all entries or only the to-dos, a new one typed in at the top, each ticked off right there.

import { setMeta, upsertProp } from "@orbis/core/model";
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
	localStorage.removeItem("orbis.inbox.view");
	repo = await workspace();
	await panel();
});
afterEach(() => cleanup());

const card = () => page.getByRole("article").getByRole("textbox", { name: "Titel" });
const titleNow = () =>
	document.querySelector<HTMLTextAreaElement>("main article textarea")?.value.trim() ?? "";
/** Whether the list shows the entry under "Erledigt" (and no longer among those waiting). */
const sortedBelow = (title: string) => {
	const done = [...document.querySelectorAll("main section[aria-label=Erledigt] li")].some((li) =>
		li.textContent?.trim().startsWith(title),
	);
	const waiting = [...document.querySelectorAll("main li [aria-current]")].some((b) =>
		b.textContent?.includes(title),
	);
	return done && !waiting;
};

const entryNow = () => repo.index().live.find((i) => i.title === titleNow())!;
const doneButton = () => page.getByRole("button", { name: /^Erledigt/ });
/** Gives the entry shown the first type in the picker ("y", then "1"). */
const giveType = async () => {
	await commands.keys("press", "y");
	await expect.element(page.getByRole("dialog", { name: "Typ geben" })).toBeVisible();
	await commands.keys("press", "1");
	await expect.element(page.getByRole("dialog", { name: "Typ geben" })).not.toBeInTheDocument();
};

describe("sorting", () => {
	test("a type or a pin keeps the entry in the inbox and on the card", async () => {
		await expect.element(card()).toBeVisible();
		const title = titleNow();
		await giveType();
		await expect.poll(() => entryNow().type).not.toBeNull();
		await page.getByRole("button", { name: /Anheften/ }).click();
		await expect.poll(() => !!entryNow().pinned).toBe(true);
		expect(titleNow()).toBe(title);
		expect(sortedBelow(title)).toBe(false);
		expect(entryNow().inbox).toBeGreaterThan(0);
	});

	test('"Erledigt" waits for a type or a place; then it moves on, the undo brings it back up', async () => {
		await expect.element(card()).toBeVisible();
		const title = titleNow();
		await expect.element(doneButton()).toBeDisabled();
		await giveType();
		await expect.element(doneButton()).toBeEnabled();
		await commands.keys("press", "d");
		await expect.poll(titleNow).not.toBe(title);
		await expect.poll(() => sortedBelow(title)).toBe(true);
		expect(repo.index().live.find((i) => i.title === title)!.inbox).toBeUndefined();
		await page.getByRole("button", { name: `„${title}“ rückgängig machen` }).click();
		await expect.poll(titleNow).toBe(title);
		await expect.poll(() => sortedBelow(title)).toBe(false);
	});
});

describe('"Erledigt"', () => {
	test("stays after the panel is opened anew (as after a reload), until cleared by hand", async () => {
		await expect.element(card()).toBeVisible();
		const title = titleNow();
		await page.getByRole("button", { name: /Morgen/ }).click();
		await expect.poll(() => sortedBelow(title)).toBe(true);
		await cleanup();
		await panel();
		await expect.poll(() => sortedBelow(title)).toBe(true);
		await page.getByRole("button", { name: "Erledigt leeren" }).click();
		await expect.poll(() => document.querySelector("main section[aria-label=Erledigt]")).toBeNull();
		expect(JSON.parse(localStorage.getItem("orbis.inbox.sorted")!)).toEqual([]);
	});

	test('set aside with "Morgen", it waits again once it is due', async () => {
		await expect.element(card()).toBeVisible();
		const title = titleNow();
		await page.getByRole("button", { name: /Morgen/ }).click();
		await expect.poll(() => sortedBelow(title)).toBe(true);
		const id = repo.index().live.find((i) => i.title === title)!.id;
		repo.change(id, (d) => setMeta(d, { later: Date.now() - 1000 }));
		await expect.poll(() => document.querySelector("main section[aria-label=Erledigt]")).toBeNull();
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
		await page.getByRole("heading", { level: 2, name: "Abarbeiten" }).click();
		await expect.poll(titleNow).toBe(`${title} Xs`);
		expect(page.getByRole("button", { name: "Bearbeiten" }).query()).toBeNull();
		expect(document.querySelector("main section[aria-label=Erledigt]"), "nothing done").toBeNull();
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

describe("to-dos", () => {
	const todoRow = (title: string) =>
		[...document.querySelectorAll("main li[data-row]")].find((li) =>
			li.textContent?.includes(title),
		);
	test("a new one is typed in at the top; ticked off it leaves the inbox and stays struck through in the list", async () => {
		await expect.element(card()).toBeVisible();
		await page.getByRole("tab", { name: /^To-dos/ }).click();
		await expect.element(page.getByText("Keine To-dos im Eingang.").first()).toBeVisible();
		await page.getByRole("textbox", { name: "Neues To-do" }).fill("Angebot schicken");
		await commands.keys("press", "Enter");
		await expect.poll(() => todoRow("Angebot schicken")).toBeTruthy();
		await expect.element(page.getByRole("textbox", { name: "Neues To-do" })).toHaveValue("");
		const made = repo.live().find((i) => i.title === "Angebot schicken")!;
		expect(made.type).toBe("sys:task");
		expect(made.inbox).toBeGreaterThan(0);
		// only to-dos in the list, the notes waiting stay out of it
		expect(document.querySelectorAll("main li[data-row]").length).toBe(1);
		await page.getByRole("button", { name: "„Angebot schicken“ abhaken" }).click();
		await expect.poll(() => repo.get(made.id)?.props.p_status).toBe("st_done");
		await expect
			.poll(() => todoRow("Angebot schicken")?.querySelector(".line-through"))
			.toBeTruthy();
		// opened again: back in the inbox
		await page.getByRole("button", { name: "„Angebot schicken“ wieder öffnen" }).click();
		await expect.poll(() => repo.get(made.id)?.props.p_status).toBe("st_todo");
		await expect
			.poll(() => todoRow("Angebot schicken")?.querySelector(".line-through"))
			.toBeFalsy();
	});
});

describe("a to-do of a type that starts done", () => {
	test("starts open, so it waits in the inbox", async () => {
		repo.change("sys:task", (d) => upsertProp(d, "p_status", { default: "st_done" }));
		await expect.element(card()).toBeVisible();
		await page.getByRole("tab", { name: /^To-dos/ }).click();
		await page.getByRole("textbox", { name: "Neues To-do" }).fill("Rechnung prüfen");
		await commands.keys("press", "Enter");
		await expect.poll(() => repo.live().find((i) => i.title === "Rechnung prüfen")).toBeTruthy();
		const made = repo.live().find((i) => i.title === "Rechnung prüfen")!;
		expect(made.props.p_status).toBe("st_todo");
		await expect
			.element(page.getByRole("button", { name: "„Rechnung prüfen“ abhaken" }))
			.toBeVisible();
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
