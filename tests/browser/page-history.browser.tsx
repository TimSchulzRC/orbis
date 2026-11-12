// "Verlauf" in the side panel: the changes to this one page from the server's log, as the activity
// page shows them, with the live ones; on every page; a text change can go back to the text before
// it; a failed load says so and can be tried again. The tests run in German, so the labels below are.

import { replaceBody } from "@obtion/core/model";
import type { ActivityEvent } from "@obtion/core/protocol";
import { SYS } from "@obtion/core/setup";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import * as accounts from "../../packages/ui/src/accounts";
import { AppToaster } from "../../packages/ui/src/ui/toasts";
import { ItemPage } from "../../packages/ui/src/views/ItemPage";
import { noop, workspace } from "./workspace";

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.mocked(accounts.spaceCall).mockReset();
});

/** The item page; `go` switches it to another item, as navigating does. */
let go: (id: string) => void = noop;
function Shown({ start }: { start: string }) {
	const [id, setId] = useState(start);
	go = setId;
	return <ItemPage id={id} isNew={false} />;
}

const event = (id: number, doc: string, e: Partial<ActivityEvent>): ActivityEvent => ({
	id,
	ts: Date.now() - (100 - id) * 60_000,
	doc,
	title: "Relaunch",
	type: SYS.project,
	kind: "updated",
	origin: "web:Test;u=u-test",
	changes: [],
	...e,
});

test("the history of this page: rows as on the activity page, live ones join at the top", async () => {
	const repo = await workspace(false);
	const project = repo.create({ title: "Relaunch", type: SYS.project, pinned: "a" });
	const asked: string[] = [];
	vi.mocked(accounts.spaceCall).mockImplementation((_space, path) => {
		asked.push(path);
		return Promise.resolve([
			event(3, project, { changes: [{ field: "update", to: "Kickoff war gut.", id: "u1" }] }),
			event(2, project, {
				origin: "agent:claude-code;u=u-test;n=Test",
				changes: [{ field: "title", from: "Relaunch alt", to: "Relaunch" }],
			}),
			event(1.5, project, { changes: [{ field: "update", from: "Vertippt.", id: "gone" }] }),
			event(1, project, { kind: "created" }),
			// another page's: never shown here
			event(0, "other", { kind: "created" }),
		] as never);
	});
	await render(<ItemPage id={project} isNew={false} />);
	await page.getByRole("button", { name: "Verlauf" }).click();
	const panel = page.getByRole("dialog", { name: /^Updates zu / });
	await expect.element(panel.getByRole("radio", { name: "Verlauf" })).toBeChecked();
	// writing belongs to the updates
	expect(panel.getByRole("textbox").query()).toBeNull();

	await expect.element(panel.getByText("umbenannt: „Relaunch alt“ → „Relaunch“")).toBeVisible();
	expect(asked[0]).toContain(`doc=${project}`);
	await expect.element(panel.getByText("Update: „Kickoff war gut.“")).toBeVisible();
	await expect.element(panel.getByText("Update gelöscht: „Vertippt.“")).toBeVisible();
	// the page is the one beside the panel: its rows don't name it
	await expect.element(panel.getByText("hat angelegt")).toBeVisible();
	expect(panel.getByRole("link", { name: /Relaunch/ }).query()).toBeNull();
	await expect.element(panel.getByText(/^Claude/)).toBeVisible();

	// a change arriving live joins at the top
	// (as the server's "event" message does it)
	repo.events = [
		event(4, project, { changes: [{ field: "tags", to: ["web"], from: [] }] }),
		...repo.events,
	];
	(repo as unknown as { emit(): void }).emit();
	await expect.element(panel.getByText("getaggt #web")).toBeVisible();
	await panel.getByRole("button", { name: "Schließen" }).click();
});

test("every page has its history, also one whose type has no updates", async () => {
	const repo = await workspace(false);
	const note = repo.create({ title: "Notiz", pinned: "a" });
	vi.mocked(accounts.spaceCall).mockResolvedValue([event(1, note, { kind: "created" })] as never);
	await render(<ItemPage id={note} isNew={false} />);
	expect(page.getByRole("button", { name: /Update/ }).query()).toBeNull();
	await page.getByRole("button", { name: "Verlauf" }).click();
	const panel = page.getByRole("dialog", { name: "Verlauf von „Notiz“" });
	await expect.element(panel.getByText("hat angelegt")).toBeVisible();
	expect(panel.getByRole("radio").query()).toBeNull();
	expect(panel.getByRole("textbox").query()).toBeNull();
	await panel.getByRole("button", { name: "Schließen" }).click();
});

test("a text change can go back to the text before it, as a change of its own", async () => {
	const repo = await workspace(false);
	const note = repo.create({ title: "Angebot", pinned: "a" });
	repo.change(note, (d) => replaceBody(d, "Preis: 200 €\n"));
	await expect.poll(() => repo.get(note)?.body).toBe("Preis: 200 €\n");
	vi.mocked(accounts.spaceCall).mockImplementation(async (_space, path) =>
		path.startsWith("/api/history")
			? ({ doc: note, before: "Preis: 100 €\n", after: "Preis: 200 €\n", from: 1, to: 2 } as never)
			: ([
					event(2, note, {
						origin: "agent:claude-code;u=u-test;n=Test",
						changes: [{ field: "body", from: 13, to: 13, diff: true }],
					}),
				] as never),
	);
	await render(
		<>
			<ItemPage id={note} isNew={false} />
			<AppToaster />
		</>,
	);
	await page.getByRole("button", { name: "Verlauf" }).click();
	const panel = page.getByRole("dialog");
	await panel.getByRole("button", { name: /Änderung zeigen/ }).click();
	await panel.getByRole("button", { name: "Text von davor wiederherstellen" }).click();
	await expect.poll(() => repo.get(note)?.body).toBe("Preis: 100 €\n");
	await expect.element(page.getByText("Text wiederhergestellt")).toBeVisible();
	// it is the text there now: nothing more to restore
	expect(panel.getByRole("button", { name: "Text von davor wiederherstellen" }).query()).toBeNull();
	await panel.getByRole("button", { name: "Schließen" }).click();
});

test("not loaded: says so, and asks again for the same", async () => {
	const repo = await workspace(false);
	const project = repo.create({ title: "Newsletter", type: SYS.project, pinned: "a" });
	vi.mocked(accounts.spaceCall)
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue([event(1, project, { kind: "created" })] as never);
	await render(<ItemPage id={project} isNew={false} />);
	await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
	const panel = page.getByRole("dialog", { name: /^Updates zu / });
	await panel.getByRole("radio", { name: "Verlauf" }).click();
	await expect
		.element(panel.getByText("Die Änderungen liegen auf deinem Server.", { exact: false }))
		.toBeVisible();
	await panel.getByRole("button", { name: "Erneut versuchen" }).click();
	await expect.element(panel.getByText("hat angelegt")).toBeVisible();
	await panel.getByRole("button", { name: "Schließen" }).click();
});

test("older changes load below, until the log ends; a failed load is asked for again", async () => {
	const repo = await workspace(false);
	const project = repo.create({ title: "Archiv", type: SYS.project, pinned: "a" });
	const page1 = Array.from({ length: 50 }, (_, n) =>
		event(200 - n, project, { changes: [{ field: "tags", to: [`t${200 - n}`], from: [] }] }),
	);
	const asked: string[] = [];
	vi.mocked(accounts.spaceCall).mockImplementation((_space, path) => {
		asked.push(path);
		// the first try below fails, the second answers
		if (path.includes("before=151") && asked.filter((p) => p.includes("before=151")).length > 1)
			return Promise.resolve([event(10, project, { kind: "created" })] as never);
		return Promise.reject(new Error("down"));
	});
	vi.mocked(accounts.spaceCall).mockImplementationOnce((_s, path) => {
		asked.push(path);
		return Promise.resolve(page1 as never);
	});
	await render(<ItemPage id={project} isNew={false} />);
	await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
	const panel = page.getByRole("dialog", { name: /^Updates zu / });
	await panel.getByRole("radio", { name: "Verlauf" }).click();
	await expect.element(panel.getByText("getaggt #t200")).toBeInTheDocument();
	await panel.getByRole("button", { name: "Ältere laden" }).click();
	// failed: what is there stays, and trying again asks for the same rows
	await expect.element(panel.getByText("Nicht alles geladen.", { exact: false })).toBeVisible();
	await expect.element(panel.getByText("getaggt #t200")).toBeInTheDocument();
	await panel.getByRole("button", { name: "Erneut versuchen" }).click();
	await expect.element(panel.getByText("hat angelegt")).toBeInTheDocument();
	expect(asked.slice(1)).toEqual([
		expect.stringContaining("before=151"),
		expect.stringContaining("before=151"),
	]);
	// the whole log is there: no more to load
	expect(panel.getByRole("button", { name: "Ältere laden" }).query()).toBeNull();
	await panel.getByRole("button", { name: "Schließen" }).click();
});

test("each way in opens its view: the history button the history, the update line the updates", async () => {
	const repo = await workspace(false);
	const project = repo.create({ title: "Newsletter", type: SYS.project, pinned: "a" });
	vi.mocked(accounts.spaceCall).mockResolvedValue([
		event(1, project, { kind: "created" }),
	] as never);
	await render(<ItemPage id={project} isNew={false} />);
	await page.getByRole("button", { name: "Verlauf" }).click();
	await expect
		.element(page.getByRole("dialog").getByRole("radio", { name: "Verlauf" }))
		.toBeChecked();
	await expect.element(page.getByRole("dialog").getByText("hat angelegt")).toBeVisible();
	await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
	await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
	await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
	await expect
		.element(page.getByRole("dialog").getByRole("radio", { name: /^Updates/ }))
		.toBeChecked();
	await expect.element(page.getByRole("dialog").getByRole("textbox")).toHaveFocus();
	await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
	await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

test("docked and open, each way in switches the view; the button of the view shown closes it", async () => {
	await page.viewport(1440, 900);
	const repo = await workspace(false);
	const project = repo.create({ title: "Newsletter", type: SYS.project, pinned: "a" });
	vi.mocked(accounts.spaceCall).mockResolvedValue([
		event(1, project, { kind: "created" }),
	] as never);
	await render(<ItemPage id={project} isNew={false} />);
	await page.getByRole("button", { name: "Verlauf" }).click();
	const panel = page.getByRole("dialog");
	await expect.element(panel.getByRole("radio", { name: "Verlauf" })).toBeChecked();
	await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
	await expect.element(panel.getByRole("radio", { name: /^Updates/ })).toBeChecked();
	// without the app's layout the page makes no room, so the docked panel covers the top bar here
	const historyButton = () =>
		(page.getByRole("button", { name: "Verlauf", exact: true }).element() as HTMLElement).click();
	historyButton();
	await expect.element(panel.getByRole("radio", { name: "Verlauf" })).toBeChecked();
	historyButton();
	await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
	await page.viewport(1280, 900);
});

test("a late answer for the page before never shows on the next one", async () => {
	await page.viewport(1440, 900);
	const repo = await workspace(false);
	const first = repo.create({ title: "Relaunch", type: SYS.project, pinned: "a" });
	const second = repo.create({ title: "Website", type: SYS.project, pinned: "b" });
	// the first page's answer comes only when let go
	let release: () => void = noop;
	vi.mocked(accounts.spaceCall).mockImplementation((_s, path) =>
		path.includes(first)
			? new Promise(
					(done) =>
						(release = () =>
							done([
								event(1, first, { changes: [{ field: "tags", to: ["alt"], from: [] }] }),
							] as never)),
				)
			: Promise.resolve([event(2, second, { kind: "created" })] as never),
	);
	await render(<Shown start={first} />);
	await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
	await page.getByRole("dialog").getByRole("radio", { name: "Verlauf" }).click();
	// docked, the panel stays open on the next page; the first answer arrives after
	go(second);
	await expect.element(page.getByRole("dialog").getByText("hat angelegt")).toBeVisible();
	release();
	await new Promise((r) => setTimeout(r, 100));
	expect(page.getByRole("dialog").getByText("getaggt #alt").query()).toBeNull();
	await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
	await page.viewport(1280, 900);
});

test("an entry the server folded: the later copy counts, and one folded down to nothing leaves", async () => {
	const repo = await workspace(false);
	const note = repo.create({ title: "Fritz", pinned: "a" });
	const typed = event(2, note, {
		title: "Fritzm",
		changes: [{ field: "title", from: "Fritz", to: "Fritzm" }],
	});
	vi.mocked(accounts.spaceCall).mockResolvedValue([
		typed,
		event(1, note, { kind: "created" }),
	] as never);
	await render(<ItemPage id={note} isNew={false} />);
	await page.getByRole("button", { name: "Verlauf" }).click();
	const panel = page.getByRole("dialog");
	await expect.element(panel.getByText("umbenannt: „Fritz“ → „Fritzm“")).toBeVisible();
	const live = (e: ActivityEvent) => {
		repo.events = [e, ...repo.events.filter((x) => x.id !== e.id)];
		(repo as unknown as { emit(): void }).emit();
	};
	// typed on: the same entry, grown
	live({
		...typed,
		ts: Date.now(),
		title: "Fritzmeier",
		changes: [{ field: "title", from: "Fritz", to: "Fritzmeier" }],
	});
	await expect.element(panel.getByText("umbenannt: „Fritz“ → „Fritzmeier“")).toBeVisible();
	expect(panel.getByText("umbenannt: „Fritz“ → „Fritzm“", { exact: true }).query()).toBeNull();
	// deleted back to the title it had: nothing changed, so no entry
	live({ ...typed, ts: Date.now() + 1, title: "Fritz", changes: [] });
	await expect.element(panel.getByText("hat angelegt")).toBeVisible();
	expect(panel.getByText(/umbenannt/).query()).toBeNull();
	expect(panel.getByText("hat geändert").query()).toBeNull();
	await panel.getByRole("button", { name: "Schließen" }).click();
});
