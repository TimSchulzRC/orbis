// A new note: the tray's "Neu" and the "+" in the inbox's head open the inbox panel at a new empty
// note, the caret in its title. Left empty, it goes when the panel closes or moves on to another entry.

import type { Repo } from "@orbis/sync";
import { afterEach, beforeEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { dismissShelf } from "../../packages/ui/src/ui/inbox";
import { Tray } from "../../packages/ui/src/ui/Tray";
import { workspace } from "./workspace";

let repo: Repo;
beforeEach(async () => {
	localStorage.removeItem("orbis.inbox.sorted");
	repo = await workspace();
	await render(
		<div className="fixed inset-x-0 bottom-0">
			<Tray desktop />
		</div>,
	);
});
afterEach(() => {
	dismissShelf();
	return cleanup();
});

const panel = () => page.getByRole("dialog", { name: "Eingang" });
const titleField = () => panel().getByRole("textbox", { name: "Titel" });
const found = (title: string) => repo.live().find((i) => i.title === title);
const open = async () => {
	await page.getByRole("button", { name: "Neu", exact: true }).click();
	await expect.element(titleField()).toHaveFocus();
	await expect.element(titleField()).toHaveValue("");
};

test("the tray's button opens the inbox at a new note; written in, it stays in the inbox", async () => {
	await open();
	await commands.keys("type", "Call with Lena");
	await commands.keys("press", "Enter");
	await expect.poll(() => document.querySelector("article .cm-editor.cm-focused")).not.toBeNull();
	await commands.keys("type", "The meeting moves");
	await panel().getByRole("button", { name: "Schließen" }).click();
	await expect.element(panel()).not.toBeInTheDocument();
	await expect.poll(() => found("Call with Lena")?.body).toBe("The meeting moves");
	const note = found("Call with Lena")!;
	expect(Object.keys(note.parents)).toEqual([]);
	expect(note.type).toBeNull();
});

test("left empty, the note goes when the panel closes", async () => {
	const before = repo.live().length;
	await open();
	expect(repo.live().length).toBe(before + 1);
	await commands.keys("press", "Escape");
	await commands.keys("press", "Escape");
	await expect.element(panel()).not.toBeInTheDocument();
	await expect.poll(() => repo.live().length).toBe(before);
});

test('the "+" in the inbox\'s head starts a new note; on to another entry, the empty one goes', async () => {
	const before = repo.live().length;
	await page.getByRole("button", { name: /^Eingang: / }).click();
	await panel().getByRole("button", { name: "Neue Notiz" }).click();
	await expect.element(titleField()).toHaveFocus();
	await expect.element(titleField()).toHaveValue("");
	// it heads the list
	const first = document.querySelector("[data-row]")!;
	expect(
		first.getAttribute("aria-current") ??
			first.querySelector("[aria-current]")?.getAttribute("aria-current"),
	).toBe("true");
	expect(repo.live().length).toBe(before + 1);
	document.querySelectorAll<HTMLElement>("[data-row] button")[1]!.click();
	await expect.element(titleField()).not.toHaveValue("");
	await expect.poll(() => repo.live().length).toBe(before);
});

test("with a tab shown, a new note switches the list to the whole inbox", async () => {
	localStorage.setItem("orbis.inbox.view", JSON.stringify("to-dos"));
	await open();
	await expect
		.element(panel().getByRole("tab", { name: /^Eingang/ }))
		.toHaveAttribute("aria-selected", "true");
	await commands.keys("type", "Idea");
	await expect.poll(() => found("Idea")?.inbox).toBeGreaterThan(0);
	localStorage.removeItem("orbis.inbox.view");
});

test("clicked again while the new note is still empty, the same note stays open", async () => {
	const before = repo.live().length;
	await open();
	const shown = () => document.querySelector("[data-row]")?.getAttribute("data-row");
	const first = shown();
	// the tray's button, then the one in the inbox's head
	await page.getByRole("button", { name: "Neu", exact: true }).click();
	await panel().getByRole("button", { name: "Neue Notiz" }).click();
	await expect.element(titleField()).toHaveFocus();
	expect(shown()).toBe(first);
	expect(repo.live().length).toBe(before + 1);
	// written in, the next click starts another
	await commands.keys("type", "First");
	await panel().getByRole("button", { name: "Neue Notiz" }).click();
	await expect.element(titleField()).toHaveValue("");
	expect(repo.live().length).toBe(before + 2);
});
