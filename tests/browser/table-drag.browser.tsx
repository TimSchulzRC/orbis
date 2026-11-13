// Rows of a table are dragged by their title, with real drags: onto a row's middle below that
// entry, between two rows to that place (the order is the view's, kept while it has no sort), and
// into another group to its value.

import type { ViewTab } from "@obtion/core/model";
import { tabDef } from "@obtion/core/query";
import { SYS } from "@obtion/core/setup";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ScopeContext } from "../../packages/ui/src/scope";
import { Results } from "../../packages/ui/src/ui/Results";
import { AppToaster } from "../../packages/ui/src/ui/toasts";
import { noFiles, workspace } from "./workspace";

afterEach(() => cleanup());

// what a table remembers on the device (opened rows) goes by this key: a fresh one per test
let run = 0;

let saved: Partial<ViewTab>[] = [];
function View({ look }: { look: Partial<ViewTab> }) {
	const [tab, setTab] = useState<ViewTab>({ id: "t", pos: "a", kind: "table", ...look });
	return (
		<Results
			def={tabDef({ type: SYS.project }, tab)}
			look={{
				key: `drag-test-${run}`,
				tab,
				onLook: (patch) => {
					saved.push(patch);
					setTab({ ...tab, ...patch });
				},
			}}
		/>
	);
}

async function setup(look: Partial<ViewTab> = {}) {
	saved = [];
	run++;
	const repo = await workspace(false);
	const project = (title: string, status: string) =>
		repo.create({ title, type: SYS.project, props: { p_status: status } });
	const a = project("Alpha", "st_planning");
	const b = project("Beta", "st_planning");
	const c = project("Gamma", "st_active");
	await render(
		<ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
			<View look={look} />
			<AppToaster />
		</ScopeContext.Provider>,
	);
	const rowOf = (title: string) =>
		[...document.querySelectorAll<HTMLElement>("tr[data-id]")].find(
			(row) => row.querySelector("td a")?.textContent === title,
		)!;
	/** Drags `title`'s row by its title onto `onto`'s row, `at` of its height from the top. */
	const drag = (title: string, onto: string, at: number) => {
		const target = rowOf(onto);
		return userEvent.dragAndDrop(
			page.elementLocator(rowOf(title).querySelector("[draggable=true]")!),
			page.elementLocator(target),
			{ targetPosition: { x: 150, y: target.getBoundingClientRect().height * at } },
		);
	};
	const titles = () =>
		[...document.querySelectorAll("tr[data-id] td:first-child a")].map((x) => x.textContent);
	const parents = (id: string) => Object.keys(repo.get(id)!.parents);
	await expect.poll(titles).toEqual(["Alpha", "Beta", "Gamma"]);
	return { repo, a, b, c, drag, titles, parents };
}

test("a row dropped between two rows goes there and stays on their level", async () => {
	const { c, drag, titles, parents } = await setup();
	await drag("Gamma", "Alpha", 0.2);
	await expect.poll(titles).toEqual(["Gamma", "Alpha", "Beta"]);
	await drag("Gamma", "Alpha", 0.8);
	await expect.poll(titles).toEqual(["Alpha", "Gamma", "Beta"]);
	expect(parents(c)).toEqual([]);
	// onto the gap it already follows: it stays
	await drag("Gamma", "Alpha", 0.8);
	await expect.poll(() => saved.length).toBe(3);
	expect(titles()).toEqual(["Alpha", "Gamma", "Beta"]);
});

test("a row dropped on the middle of a row goes below it, and out again between two rows", async () => {
	const { a, c, drag, titles, parents } = await setup();
	await drag("Gamma", "Alpha", 0.5);
	await expect.poll(() => parents(c)).toEqual([a]);
	// the row it went into opens: its sub-item follows it, indented
	await expect.poll(titles).toEqual(["Alpha", "Gamma", "Beta"]);
	await drag("Gamma", "Beta", 0.8);
	await expect.poll(() => parents(c)).toEqual([]);
	await expect.poll(titles).toEqual(["Alpha", "Beta", "Gamma"]);
});

test("below an open row with sub-items is the place of its first one", async () => {
	const { a, b, c, drag, titles, parents } = await setup();
	await drag("Gamma", "Alpha", 0.5);
	await expect.poll(titles).toEqual(["Alpha", "Gamma", "Beta"]);
	await drag("Beta", "Alpha", 0.8);
	await expect.poll(titles).toEqual(["Alpha", "Beta", "Gamma"]);
	expect(parents(b)).toEqual([a]);
	expect(parents(c)).toEqual([a]);
	// among the sub-items: after the last one, still below the same row
	await drag("Beta", "Gamma", 0.8);
	await expect.poll(titles).toEqual(["Alpha", "Gamma", "Beta"]);
	expect(parents(b)).toEqual([a]);
});

test("a row dropped into another group takes its value, without going into the row there", async () => {
	const { repo, c, drag, parents } = await setup({ group: "status" });
	await drag("Gamma", "Alpha", 0.2);
	await expect.poll(() => repo.get(c)!.props.p_status).toBe("st_planning");
	expect(parents(c)).toEqual([]);
});

test("a view with a sort keeps its order: rows still go into and out of each other", async () => {
	const { a, c, drag, titles, parents } = await setup({ sort: [{ key: "title" }] });
	await drag("Gamma", "Alpha", 0.2);
	await expect
		.poll(() => document.body.textContent, { timeout: 4000 })
		.toContain("Diese Ansicht ist sortiert.");
	expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
	await drag("Gamma", "Alpha", 0.5);
	await expect.poll(() => parents(c)).toEqual([a]);
	expect(saved).toEqual([]);
});
