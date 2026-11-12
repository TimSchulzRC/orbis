// Dragging into the sidebar tree, with real drags: a link to an item from the page gets a place
// where it is dropped, and the room between two rows is wide enough to reorder without nesting.

import { sidebarRoots } from "@obtion/core/placement";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { Space } from "../../packages/ui/src/accounts";
import { ScopeContext } from "../../packages/ui/src/scope";
import { SpaceTree } from "../../packages/ui/src/ui/Sidebar";
import { noFiles, workspace } from "./workspace";

afterEach(() => cleanup());

async function setup() {
	const repo = await workspace(false);
	const a = repo.create({ title: "Alpha", pinned: "a" });
	const b = repo.create({ title: "Beta", pinned: "b" });
	const c = repo.create({ title: "Gamma", pinned: "c" });
	const home = repo.create({ title: "Elsewhere" });
	const loose = repo.create({ title: "Loose page", parents: [home] });
	await render(
		<ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
			<div style={{ display: "flex", gap: 40 }}>
				<div style={{ width: 256 }}>
					<SpaceTree space={{ id: "w1", name: "Test" } as Space} />
				</div>
				<main>
					{/* as lists and paths on a page link to an item */}
					<a href={`#/w/w1/i/${loose}`}>Loose page</a>
					{/* as a board card: dragged itself, with its item's link and a URL property in it */}
					<div data-testid="card" draggable>
						<a draggable={false} href={`#/w/w1/i/${loose}`}>
							Card
						</a>
						<a draggable={false} href="https://example.com/">
							example.com
						</a>
					</div>
				</main>
			</div>
		</ScopeContext.Provider>,
	);
	const tree = page.getByRole("region", { name: "Test" });
	const row = (title: string) =>
		page.elementLocator(tree.getByRole("link", { name: title }).element().parentElement!);
	/** Drops on `title`'s row, `at` of its height from the top. */
	const dropOn = (
		source: Parameters<typeof userEvent.dragAndDrop>[0],
		title: string,
		at: number,
	) => {
		const box = row(title).element().getBoundingClientRect();
		return userEvent.dragAndDrop(source, row(title), {
			targetPosition: { x: 120, y: box.height * at },
		});
	};
	const pinned = () => sidebarRoots(repo.index()).map((i) => i.title);
	return { repo, a, b, c, home, loose, row, dropOn, pinned };
}

test("a link from the page dropped on a row gets a place below it and keeps its own", async () => {
	const { repo, a, home, loose, dropOn } = await setup();
	let carried: readonly string[] = [];
	const seen = (e: DragEvent) => (carried = [...(e.dataTransfer?.types ?? [])]);
	window.addEventListener("dragstart", seen);
	await dropOn(page.getByRole("main").getByRole("link", { name: "Loose page" }), "Alpha", 0.5);
	window.removeEventListener("dragstart", seen);
	await expect.poll(() => Object.keys(repo.get(loose)!.parents).sort()).toEqual([a, home].sort());
	expect(repo.get(loose)!.pinned).toBeFalsy();
	// only its text: no URL the browser would open in a new tab or split view
	expect(carried).toEqual(["text/plain"]);
});

test("a link from the page dropped between two rows is pinned there", async () => {
	const { repo, loose, home, dropOn, pinned } = await setup();
	await dropOn(page.getByRole("main").getByRole("link", { name: "Loose page" }), "Beta", 0.1);
	await expect.poll(pinned).toEqual(["Alpha", "Loose page", "Beta", "Gamma"]);
	expect(Object.keys(repo.get(loose)!.parents)).toEqual([home]);
});

test("a row dropped a third down another row lands before it, not in it", async () => {
	const { repo, c, row, dropOn, pinned } = await setup();
	await dropOn(row("Gamma"), "Alpha", 0.3);
	await expect.poll(pinned).toEqual(["Gamma", "Alpha", "Beta"]);
	expect(repo.get(c)!.parents).toEqual({});
});

test("a row dropped on the middle of another row goes into it", async () => {
	const { repo, a, c, row, dropOn, pinned } = await setup();
	await dropOn(row("Gamma"), "Alpha", 0.5);
	await expect.poll(() => Object.keys(repo.get(c)!.parents)).toEqual([a]);
	expect(pinned()).toEqual(["Alpha", "Beta"]);
});

test("a card with its item's link and a link elsewhere in it is dropped as that item", async () => {
	const { repo, a, home, loose, dropOn } = await setup();
	await dropOn(page.getByTestId("card"), "Alpha", 0.5);
	await expect.poll(() => Object.keys(repo.get(loose)!.parents).sort()).toEqual([a, home].sort());
});
