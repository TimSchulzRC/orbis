// "Bibliotheken durchsuchen" in a diagram: Excalidraw's public libraries shown in the app, searched
// and sorted there, each added with "Zu Orbis hinzufügen" straight into the drawing.
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { LibraryBrowser } from "../../packages/ui/src/drawing/LibraryBrowser";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const SITE = "https://libraries.excalidraw.com/";
const LIST = [
	{
		name: "Cloud",
		description: "Symbols for cloud things",
		authors: [{ name: "rf" }],
		source: "rf/cloud.excalidrawlib",
		preview: "rf/cloud.png",
		created: "2022-01-01",
		updated: "2022-01-01",
	},
	{
		name: "AWS Icons",
		description: "Lambda, S3",
		authors: [{ name: "anna" }],
		source: "anna/aws.excalidrawlib",
		preview: "anna/aws.png",
		created: "2024-05-01",
		updated: "2024-05-01",
	},
];
const STATS = { "rf-cloud": { total: 900 }, "anna-aws": { total: 10 } };

/** The library site's answers. */
function answer(url: string) {
	if (url === `${SITE}libraries.json`) return Response.json(LIST);
	if (url === `${SITE}stats.json`) return Response.json(STATS);
	if (url === `${SITE}libraries/anna/aws.excalidrawlib`)
		return new Response('{"type":"excalidrawlib","libraryItems":[]}');
	return new Response("", { status: 404 });
}

test("lists, searches and sorts the libraries; a library goes into the drawing", async () => {
	const fetched: string[] = [];
	vi.stubGlobal("fetch", (url: string) => {
		fetched.push(url);
		return Promise.resolve(answer(url));
	});
	const added: Blob[] = [];
	const onClose = vi.fn();
	await render(<LibraryBrowser onAdd={async (b) => void added.push(b)} onClose={onClose} />);

	const dialog = page.getByRole("dialog", { name: "Bibliotheken" });
	await expect.element(dialog.getByText("AWS Icons")).toBeVisible();
	// most downloaded first
	const names = () => [...document.querySelectorAll("li h3")].map((e) => e.textContent);
	expect(names()).toEqual(["Cloud", "AWS Icons"]);
	await dialog.getByRole("radio", { name: "Neu" }).click();
	await expect.poll(names).toEqual(["AWS Icons", "Cloud"]);

	// the search looks at names, descriptions and authors
	await dialog.getByRole("searchbox").fill("lambda");
	await expect.poll(names).toEqual(["AWS Icons"]);

	await dialog.getByRole("button", { name: "Zu Orbis hinzufügen" }).click();
	await expect.element(dialog.getByRole("button", { name: "Hinzugefügt" })).toBeDisabled();
	expect(await added[0]!.text()).toContain("excalidrawlib");

	await dialog.getByRole("button", { name: "Schließen" }).click();
	expect(onClose).toHaveBeenCalledWith(true);
});
