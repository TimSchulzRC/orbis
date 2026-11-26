// "Darunter": a new entry is typed into its group's own line, a type without entries yet gets its
// group from the menu, and the arrow that opens an entry sits at the end of its line.

import { EX_TYPES } from "@orbis/core/examples";
import { SYS } from "@orbis/core/setup";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { Below } from "../../packages/ui/src/ui/Sections";
import { workspace } from "./workspace";

afterEach(() => {
	cleanup();
	localStorage.removeItem("orbis.fold.below:ex-build");
});

async function setup(id: string) {
	const repo = await workspace();
	await render(<Below item={repo.get(id)!} />);
	const found = (title: string) => repo.live().find((i) => i.title === title);
	/** The label of the field that holds the keyboard. */
	const typingIn = () => document.activeElement?.getAttribute("aria-label");
	const pick = async (name: string) => {
		await page.getByRole("button", { name: "Darunter anlegen" }).click();
		await page.getByRole("button", { name, exact: true }).click();
		// the menu has faded out: a click on its button while it does would not open it again
		await expect.poll(() => document.querySelector("[data-popover]")).toBeNull();
	};
	return { found, typingIn, pick };
}

test("a click on the plus starts typing; Enter adds an entry of the group's type and stays", async () => {
	const { found, typingIn } = await setup("ex-relaunch");
	const line = page.getByRole("textbox", { name: "Projekt anlegen …" });
	await expect.element(line).toBeVisible();
	await userEvent.click(page.elementLocator(line.element().closest("form")!.querySelector("svg")!));
	expect(typingIn()).toBe("Projekt anlegen …");
	await userEvent.keyboard("Texte{Enter}");
	await expect.poll(() => found("Texte")?.type).toBe(SYS.project);
	expect(Object.keys(found("Texte")!.parents)).toEqual(["ex-relaunch"]);
	// ready for the next one
	expect(typingIn()).toBe("Projekt anlegen …");
	await expect.element(line).toHaveValue("");
});

test("a type picked in the menu gets its group with the line ready; Escape takes the empty group away", async () => {
	const { found, typingIn, pick } = await setup("ex-relaunch");
	// no task directly below the project yet
	await expect.element(page.getByText("Tasks", { exact: true })).not.toBeInTheDocument();
	await pick("Task");
	await expect.poll(typingIn).toBe("Task anlegen …");
	await expect.element(page.getByText("Tasks", { exact: true })).toBeVisible();
	await userEvent.keyboard("{Escape}");
	await expect.element(page.getByText("Tasks", { exact: true })).not.toBeInTheDocument();

	await pick("Task");
	await expect.poll(typingIn).toBe("Task anlegen …");
	await userEvent.keyboard("Texte schreiben{Enter}");
	await expect.poll(() => found("Texte schreiben")?.type).toBe(SYS.task);
	// the entry shows in that group, the line stays below it
	await expect.element(page.getByRole("link", { name: "Texte schreiben" })).toBeVisible();
	expect(typingIn()).toBe("Task anlegen …");

	// a group that is there already: the menu leads to its line, and an unused group makes way
	await pick("Buch");
	await expect.poll(typingIn).toBe("Buch anlegen …");
	await pick("Notiz");
	await expect.poll(typingIn).toBe("Notiz anlegen …");
	await expect.element(page.getByText("Bücher", { exact: true })).not.toBeInTheDocument();
});

test("nothing below yet: the menu opens the first group", async () => {
	const { found, typingIn, pick } = await setup("ex-t-cms");
	await expect.element(page.getByText("Darunter", { exact: true })).not.toBeInTheDocument();
	await pick("Task");
	await expect.poll(typingIn).toBe("Task anlegen …");
	// the other type after all, straight from the empty line
	await pick("Buch");
	await expect.poll(typingIn).toBe("Buch anlegen …");
	await expect.element(page.getByText("Tasks", { exact: true })).not.toBeInTheDocument();
	await userEvent.keyboard("Kleine CMS-Kunde{Enter}");
	await expect.poll(() => found("Kleine CMS-Kunde")?.type).toBe(EX_TYPES.book);
	await expect.element(page.getByText("Darunter", { exact: true })).toBeVisible();
	expect(typingIn()).toBe("Buch anlegen …");
});

test("the arrow that opens an entry is at the end of its line, so every entry starts at the same place", async () => {
	await setup("ex-build");
	const row = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
	const left = (el: Element) => Math.round(el.getBoundingClientRect().left);
	await expect.poll(() => row("ex-t-pages")).toBeTruthy();
	// with entries below and without: the same start
	const title = (id: string) => row(id).querySelector("a")!;
	expect(left(title("ex-t-pages"))).toBe(left(title("ex-t-cms")));
	expect(row("ex-t-pages").firstElementChild!.querySelector("[aria-label^='Status']")).toBeTruthy();
	const arrow = row("ex-t-pages").querySelector("button[aria-label='Aufklappen']")!;
	expect(arrow).toBe(row("ex-t-pages").lastElementChild);
	expect(left(arrow)).toBeGreaterThan(left(title("ex-t-pages")));
	// the due dates stay in one column
	const right = (id: string) =>
		Math.round(row(id).querySelector("a ~ span.ml-auto")!.getBoundingClientRect().right);
	expect(right("ex-t-pages")).toBe(right("ex-t-cms"));

	await userEvent.click(page.elementLocator(arrow));
	await expect.poll(() => row("ex-t-pages-home")).toBeTruthy();
	expect(arrow.getAttribute("aria-expanded")).toBe("true");
	expect(left(title("ex-t-pages-home"))).toBeGreaterThan(left(title("ex-t-pages")));
});

test("the plus of the add line stands at the middle of the capitals beside it", async () => {
	await setup("ex-relaunch");
	const input = page.getByRole("textbox", { name: "Projekt anlegen …" });
	await expect.element(input).toBeVisible();
	const line = input.element().parentElement!;
	const plus = line.querySelector("svg")!.getBoundingClientRect();
	// where the line's baseline is: an empty box in it stands on the baseline
	const probe = line.appendChild(document.createElement("i"));
	const baseline = probe.getBoundingClientRect().bottom;
	probe.remove();
	const pen = document.createElement("canvas").getContext("2d")!;
	const { fontStyle, fontWeight, fontSize, fontFamily } = getComputedStyle(input.element());
	pen.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
	const capitals = pen.measureText("H").actualBoundingBoxAscent;
	expect(Math.abs(plus.top + plus.height / 2 - (baseline - capitals / 2))).toBeLessThan(0.75);
});
