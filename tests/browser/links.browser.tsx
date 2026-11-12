// Links of a page, both ways, behind one button in the page head: its number counts all of them,
// a click lists "Verlinkt von" and "Verweist auf". The page has no section for them at the end.
import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ItemPage } from "../../packages/ui/src/views/ItemPage";
import { workspace } from "./workspace";

afterEach(() => cleanup());

test("the button counts links both ways and lists them; a ref outside the text can be removed", async () => {
	const repo = await workspace(false);
	const home = repo.create({ title: "Work", pinned: "a" });
	const roadmap = repo.create({ title: "Roadmap 2027", parents: [home] });
	const relaunch = repo.create({ title: "Website relaunch", parents: [home] });
	const id = repo.create({
		title: "Marketing",
		parents: [home],
		body: "Status under [[Website relaunch]].",
	});
	repo.create({ title: "How Obtion works", parents: [home], body: "See [[Marketing]]." });
	repo.setMember(id, "refs", roadmap, true);
	await render(<ItemPage id={id} isNew={false} />);

	// one incoming, two outgoing (one in the text, one set by hand)
	const button = page.getByRole("button", { name: "Links: 3" });
	await expect.element(button).toBeVisible();
	expect(page.getByText("Bezüge").query()).toBeNull();
	expect(page.getByText("Verlinkt von").query()).toBeNull();

	await button.click();
	const menu = page.getByRole("dialog");
	await expect.element(menu.getByText(/^Verlinkt von/)).toBeVisible();
	await expect.element(menu.getByText(/^Verweist auf/)).toBeVisible();
	expect(
		menu
			.getByRole("link")
			.elements()
			.map((a) => a.textContent),
	).toEqual(["How Obtion works", "Website relaunch", "Roadmap 2027"]);
	await expect
		.element(menu.getByRole("link", { name: "Website relaunch" }))
		.toHaveAttribute("href", expect.stringContaining(relaunch));

	// only the ref outside the text has a remove button
	expect(menu.getByRole("button", { name: "Ref entfernen" }).elements()).toHaveLength(1);
	await menu.getByRole("button", { name: "Ref entfernen" }).click();
	await expect.poll(() => repo.get(id)!.refs).toEqual([]);
	await expect.element(page.getByRole("button", { name: "Links: 2" })).toBeVisible();
});

test("no links, no link button; + after the chips adds a ref, the page menu no longer does", async () => {
	const repo = await workspace(false);
	const home = repo.create({ title: "Work", pinned: "a" });
	const roadmap = repo.create({ title: "Roadmap 2027", parents: [home] });
	const id = repo.create({ title: "Alone", parents: [home] });
	await render(<ItemPage id={id} isNew={false} />);
	await expect.element(page.getByText("Alone").first()).toBeVisible();
	expect(page.getByRole("button", { name: /^Links:/ }).query()).toBeNull();

	await page.getByRole("button", { name: "Mehr" }).first().click();
	const pageMenu = page.getByRole("dialog");
	await expect.element(pageMenu.getByRole("button", { name: "Neue Seite darunter" })).toBeVisible();
	expect(pageMenu.getByRole("button", { name: "Ref hinzufügen" }).query()).toBeNull();
	await page.getByRole("button", { name: "Mehr" }).first().click();

	await page.getByRole("button", { name: "Ref hinzufügen" }).click();
	const picker = page.getByRole("dialog", { name: "Ref hinzufügen" });
	await picker.getByRole("textbox").fill("Roadmap");
	await picker.getByText("Roadmap 2027").click();
	await expect.poll(() => repo.get(id)!.refs).toEqual([roadmap]);
	await expect.element(page.getByRole("button", { name: "Links: 1" })).toBeVisible();
});

test("refs show as chips after the link button; a link from the text can be pinned there", async () => {
	const repo = await workspace(false);
	const home = repo.create({ title: "Work", pinned: "a" });
	const roadmap = repo.create({ title: "Roadmap 2027", parents: [home] });
	const relaunch = repo.create({ title: "Website relaunch", parents: [home] });
	const id = repo.create({
		title: "Marketing",
		parents: [home],
		body: "Status under [[Website relaunch]].",
	});
	repo.setMember(id, "refs", roadmap, true);
	await render(<ItemPage id={id} isNew={false} />);

	// the ref set by hand is a chip; the link in the text is not
	const chips = () =>
		page
			.getByRole("link", { name: /Roadmap 2027|Website relaunch/ })
			.elements()
			.filter((a) => !a.closest(".cm-editor"));
	await expect.poll(() => chips().map((a) => a.textContent)).toEqual(["Roadmap 2027"]);

	// pinned from the menu, the link from the text shows as a chip too, in front
	await page.getByRole("button", { name: "Links: 2" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Oben anheften" }).click();
	await expect.poll(() => repo.get(id)!.refs).toEqual([relaunch, roadmap]);
	await page.getByRole("button", { name: "Links: 2" }).click(); // close the menu
	await expect
		.poll(() => chips().map((a) => a.textContent))
		.toEqual(["Website relaunch", "Roadmap 2027"]);

	// its × unpins it; the link in the text stays
	await page.getByRole("button", { name: "Nicht mehr oben anheften" }).click();
	await expect.poll(() => repo.get(id)!.refs).toEqual([roadmap]);
	expect(repo.get(id)!.body).toContain("[[Website relaunch]]");
});

test("refs keep their order: a pinned link goes in front, chips can be dragged or moved with Alt+arrows", async () => {
	const repo = await workspace(false);
	const home = repo.create({ title: "Work", pinned: "a" });
	const a = repo.create({ title: "Alpha", parents: [home] });
	const b = repo.create({ title: "Beta", parents: [home] });
	const g = repo.create({ title: "Gamma", parents: [home] });
	const id = repo.create({ title: "Page", parents: [home], body: "See [[Gamma]]." });
	repo.setMember(id, "refs", a, true);
	repo.setMember(id, "refs", b, true);
	await render(<ItemPage id={id} isNew={false} />);

	// pinned from the menu, the link from the text goes in front
	await page.getByRole("button", { name: "Links: 3" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Oben anheften" }).click();
	await expect.poll(() => repo.get(id)!.refs).toEqual([g, a, b]);
	// the first row of the open menu shows no tools until hovered (the menu focuses its first button)
	await commands.mouse("move", 5, 600);
	const unpin = page.getByRole("dialog").getByRole("button", { name: "Nicht mehr oben anheften" });
	await expect.poll(() => getComputedStyle(unpin.element()).opacity).toBe("0");
	await page.getByRole("button", { name: "Links: 3" }).click();
	const chips = () => [...document.querySelectorAll("[data-ref]")].map((x) => x.textContent);
	await expect.poll(chips).toEqual(["Gamma", "Alpha", "Beta"]);

	// dragged over the left half of the first chip, a line shows in front of it, and the chip lands there
	const box = (title: string) =>
		document
			.querySelector(
				`[data-ref="${({ Alpha: a, Beta: b, Gamma: g } as Record<string, string>)[title]}"]`,
			)!
			.getBoundingClientRect();
	const from = box("Beta");
	await commands.mouse("move", from.left + from.width / 2, from.top + from.height / 2);
	await commands.mouse("down");
	const to = box("Gamma");
	await commands.mouse("move", to.left + 4, to.top + to.height / 2, { steps: 8 });
	await expect.poll(() => document.querySelectorAll("[data-drop-line]").length).toBe(1);
	expect(document.querySelector(`[data-ref="${g}"] [data-drop-line]`)).not.toBeNull();
	await commands.mouse("up");
	await expect.poll(() => repo.get(id)!.refs).toEqual([b, g, a]);
	expect(document.querySelector("[data-drop-line]")).toBeNull();

	// Alt+→ moves the focused chip one place to the right
	document.querySelector<HTMLElement>(`[data-ref="${b}"] a`)!.focus();
	await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
	await expect.poll(() => repo.get(id)!.refs).toEqual([g, b, a]);
	await expect.poll(chips).toEqual(["Gamma", "Beta", "Alpha"]);
});
