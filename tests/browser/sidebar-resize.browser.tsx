// The sidebar's right edge sets its width (dragged or with the arrow keys), remembered per device;
// its list scrolls without a visible scrollbar.
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ScopeContext } from "../../packages/ui/src/scope";
import { SIDEBAR_WIDTH, Sidebar } from "../../packages/ui/src/ui/Sidebar";
import { KEYS } from "../../packages/ui/src/ui/storage";
import { noFiles, noop, workspace } from "./workspace";

afterEach(() => {
	cleanup();
	localStorage.removeItem(KEYS.sidebarWidth);
});

async function setup() {
	const repo = await workspace();
	await render(
		<ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
			<div style={{ display: "flex", height: 400 }}>
				<Sidebar onSearch={noop} />
			</div>
		</ScopeContext.Provider>,
	);
	const handle = page.getByRole("separator", { name: "Breite der Seitenleiste ändern" });
	await expect.element(handle).toBeInTheDocument();
	const aside = handle.element().closest("aside")!;
	return { handle, aside };
}

test("dragging the edge sets the width and keeps it", async () => {
	const { handle, aside } = await setup();
	expect(aside.getBoundingClientRect().width).toBe(SIDEBAR_WIDTH.initial);
	const r = handle.element().getBoundingClientRect();
	const y = r.top + r.height / 2;
	await commands.mouse("move", r.left + r.width / 2, y);
	await commands.mouse("down");
	await commands.mouse("move", r.left + r.width / 2 + 100, y, { steps: 5 });
	await commands.mouse("up");
	await expect.poll(() => aside.getBoundingClientRect().width).toBe(SIDEBAR_WIDTH.initial + 100);
	expect(JSON.parse(localStorage.getItem(KEYS.sidebarWidth)!)).toBe(SIDEBAR_WIDTH.initial + 100);
	// no further than the limit
	const r2 = handle.element().getBoundingClientRect();
	await commands.mouse("move", r2.left + r2.width / 2, y);
	await commands.mouse("down");
	await commands.mouse("move", r2.left + 900, y, { steps: 5 });
	await commands.mouse("up");
	await expect.poll(() => aside.getBoundingClientRect().width).toBe(SIDEBAR_WIDTH.max);
});

test("arrow keys change the width, a double click resets it", async () => {
	const { handle, aside } = await setup();
	(handle.element() as HTMLElement).focus();
	await commands.keys("press", "ArrowLeft");
	await expect.poll(() => aside.getBoundingClientRect().width).toBe(SIDEBAR_WIDTH.initial - 16);
	await handle.dblClick();
	await expect.poll(() => aside.getBoundingClientRect().width).toBe(SIDEBAR_WIDTH.initial);
});

test("a stored width is used on the next start", async () => {
	localStorage.setItem(KEYS.sidebarWidth, "320");
	const { aside } = await setup();
	expect(aside.getBoundingClientRect().width).toBe(320);
});

test("the list scrolls without a scrollbar", async () => {
	const { aside } = await setup();
	const list = aside.querySelector<HTMLElement>("nav")!.parentElement!;
	expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
	expect(getComputedStyle(list).overflowY).toBe("auto");
	expect(getComputedStyle(list).scrollbarWidth).toBe("none");
	// no room taken by a scrollbar
	expect(list.offsetWidth - list.clientWidth).toBe(0);
});
