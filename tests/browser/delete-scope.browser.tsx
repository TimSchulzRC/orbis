// Deleting from the sidebar block of a workspace that is not the open one: it goes to the trash
// there, never in the open workspace.

import { onlyBelow } from "@obtion/core/trash";
import type { Repo } from "@obtion/sync";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ScopeContext } from "../../packages/ui/src/scope";
import { DeleteDialog, deleteOrAsk } from "../../packages/ui/src/views/ItemPage";
import { noFiles, noop, workspace } from "./workspace";

afterEach(() => cleanup());
const byTitle = (r: Repo, title: string) => r.live().find((i) => i.title === title)!;

test("the dialog deletes in the workspace of its block", async () => {
	const other = await workspace();
	const open = await workspace(); // the open one: set last
	const item = byTitle(other, "Website-Relaunch");
	expect(onlyBelow(other.index(), item.id).length).toBeGreaterThan(0);
	await render(
		<ScopeContext.Provider value={{ id: "other", repo: other, files: noFiles }}>
			<DeleteDialog item={item} leave={false} onClose={noop} />
		</ScopeContext.Provider>,
	);
	await page.getByRole("button", { name: /^Alle \d+ löschen$/ }).click();
	await expect.poll(() => other.get(item.id)?.deleted).toBe(true);
	expect(open.get(item.id)?.deleted).toBeFalsy();
});

test("right away, without children, in the given workspace", async () => {
	const other = await workspace();
	const open = await workspace();
	const item = byTitle(other, "Kleine Systeme");
	expect(deleteOrAsk(other, item.id, noop, false)).toBe(true);
	await expect.poll(() => other.get(item.id)?.deleted).toBe(true);
	expect(open.get(item.id)?.deleted).toBeFalsy();
});
