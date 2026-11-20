// "+ Task" at the foot of each board column, as in Notion: the new card takes the column's value,
// and with sub-rows the row's value too.

import type { ViewTab } from "@orbis/core/model";
import { tabDef } from "@orbis/core/query";
import { SYS } from "@orbis/core/setup";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ScopeContext } from "../../packages/ui/src/scope";
import { Results } from "../../packages/ui/src/ui/Results";
import { noFiles, workspace } from "./workspace";

afterEach(() => cleanup());

async function setup(look: Partial<ViewTab> = {}) {
	const repo = await workspace(false);
	const tab: ViewTab = { id: "t", pos: "a", kind: "board", group: "status", ...look };
	repo.create({
		title: "Alt",
		type: SYS.task,
		props: { p_status: "st_todo", p_priority: "pr_low" },
	});
	await render(
		<ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
			<Results
				def={tabDef({ type: SYS.task }, tab)}
				look={{ key: `board-add-${Math.random()}`, tab, add: { type: SYS.task } }}
			/>
		</ScopeContext.Provider>,
	);
	/** The column (in the first row of columns) whose header chip reads `name`. */
	const column = (name: string) =>
		[...document.querySelectorAll<HTMLElement>("li")].find(
			(li) => li.querySelector("p")?.textContent?.startsWith(name) ?? false,
		)!;
	const found = (title: string) => repo.live().find((i) => i.title === title);
	return { column, found };
}

test("a card added at the foot of a column gets that column's status", async () => {
	const { column, found } = await setup();
	await expect.poll(() => column("Erledigt")).toBeTruthy();
	await userEvent.click(
		page.elementLocator(column("Erledigt").querySelector("button[aria-label^='Neu']")!),
	);
	await userEvent.keyboard("Fertig gemacht{Enter}");
	await expect.poll(() => found("Fertig gemacht")?.props.p_status).toBe("st_done");
	expect(found("Fertig gemacht")?.type).toBe(SYS.task);
	await expect
		.poll(() => [...column("Erledigt").querySelectorAll("[data-id] a")].map((a) => a.textContent))
		.toEqual(["Fertig gemacht"]);
});

test("with sub-rows the new card also gets the row's value", async () => {
	const { column, found } = await setup({ subgroup: "Priorität" });
	await expect.poll(() => column("Nicht begonnen")).toBeTruthy();
	await userEvent.click(
		page.elementLocator(column("In Bearbeitung").querySelector("button[aria-label^='Neu']")!),
	);
	await userEvent.keyboard("Niedrig und aktiv{Enter}");
	await expect.poll(() => found("Niedrig und aktiv")?.props.p_status).toBe("st_active");
	expect(found("Niedrig und aktiv")?.props.p_priority).toBe("pr_low");
});
