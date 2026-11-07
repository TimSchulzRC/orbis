// The file page: a text or code file shows its content (monospace), an Office file the text the
// server took out, HTML only as text – never rendered; every file has its download.

import { type FileMeta, initItem, newId, setFileMeta } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { type DeviceFiles, setFiles } from "../../packages/ui/src/files";
import { FilePage } from "../../packages/ui/src/views/FilePage";
import { noop, workspace } from "./workspace";

afterEach(() => cleanup());

/** Contents only on the server, nothing on this device: loaded with the token, shown from blob: URLs. */
const saved: unknown[][] = [];
const serverFiles = {
	subscribe: () => noop,
	getVersion: () => 0,
	isMissing: () => false,
	hasLocal: () => false,
	check: () => Promise.resolve(),
	url: async () => undefined,
	viewUrl: async (hash: string) => `blob:loaded-${hash}`,
	download: (...args: unknown[]) => {
		saved.push(args);
		return Promise.resolve(true);
	},
	missingKey: () => "file.missing",
	wholeText: async () => undefined,
} as unknown as DeviceFiles;

async function show(meta: Partial<FileMeta> & { name: string }, files: DeviceFiles = serverFiles) {
	const repo: Repo = await workspace(false);
	setFiles(files);
	const id = newId();
	repo.change(id, (doc) => {
		initItem(doc, { kind: "file", title: meta.name });
		setFileMeta(doc, {
			hash: "a".repeat(64),
			mime: "application/octet-stream",
			filetype: "other",
			size: 10,
			...meta,
		});
	});
	await Promise.resolve(); // the replica reads changed documents in a microtask
	await render(<FilePage item={repo.index().get(id)!} />);
}

const download = () => page.getByRole("link", { name: "Herunterladen" });

test("a code file: its content in monospace, scrollable, with the download", async () => {
	await show({
		name: "schema.xsd",
		text: '<xs:schema>\n  <xs:element name="Example"/>\n</xs:schema>',
		extracted: "x",
	});
	await expect.element(page.getByText("Inhalt", { exact: true })).toBeVisible();
	const pre = page.getByTestId("file-text");
	await expect.element(pre).toBeVisible();
	expect(pre.element().textContent).toContain('<xs:element name="Example"/>');
	expect(pre.element().className).toContain("font-mono");
	expect(getComputedStyle(pre.element()).overflowY).toBe("auto");
	// no server URL: the click loads the content with the token and saves it
	expect(download().element().getAttribute("href")).toBe("#");
	saved.length = 0;
	await download().click();
	expect(saved).toEqual([["a".repeat(64), "schema.xsd", "application/octet-stream"]]);
});

test("a Word file: the extracted text", async () => {
	await show({
		name: "Concept.docx",
		filetype: "document",
		text: "Approval process\nField\tSource",
		extracted: "x",
	});
	await expect.element(page.getByText("Erkannter Text", { exact: true })).toBeVisible();
	await expect.element(page.getByTestId("file-text")).toBeVisible();
	expect(page.getByTestId("file-text").element().textContent).toBe(
		"Approval process\nField\tSource",
	);
	expect(page.getByTestId("file-text").element().className).toContain("font-sans");
});

test("HTML only as its text: no markup is rendered", async () => {
	await show({ name: "page.html", text: "Header\nA & B", extracted: "x" });
	await expect.element(page.getByTestId("file-text")).toBeVisible();
	expect(page.getByTestId("file-text").element().textContent).toBe("Header\nA & B");
	expect(
		document.querySelector(
			"main iframe, [data-testid=file-text] h1, [data-testid=file-text] script",
		),
	).toBeNull();
});

test("a binary file: no preview, but the download", async () => {
	await show({ name: "lib.jar", extracted: "x" });
	await expect
		.element(page.getByText("Für diesen Dateityp gibt es keine Vorschau", { exact: false }))
		.toBeVisible();
	await expect.element(download()).toBeVisible();
});

test("a file the server has not read yet says so", async () => {
	await show({ name: "new.txt" });
	await expect
		.element(page.getByText("Der Server liest den Text dieser Datei gerade noch."))
		.toBeVisible();
});

test("long text cut on the server says so", async () => {
	await show({ name: "large.csv", text: "a;b\nc;d\n…", extracted: "x" });
	await expect
		.element(page.getByText("Gekürzt – der ganze Inhalt steckt im Download."))
		.toBeVisible();
	expect(page.getByTestId("file-text").element().textContent).toBe("a;b\nc;d");
});

test("the facts carry the start of a long text: the page shows the whole one from the server", async () => {
	const asked: string[] = [];
	const whole = {
		...serverFiles,
		wholeText: (h: string) => {
			asked.push(h);
			return Promise.resolve("Start\nMiddle\nEnd");
		},
	} as unknown as DeviceFiles;
	await show({ name: "long.txt", text: "Start\n…", extracted: "x" }, whole);
	await expect
		.poll(() => page.getByTestId("file-text").element().textContent)
		.toBe("Start\nMiddle\nEnd");
	expect(asked).toEqual(["a".repeat(64)]);
	expect(document.body.textContent).not.toContain("Gekürzt");
});

test("a PDF shows from a blob: URL, and its download saves that", async () => {
	await show({ name: "invoice.pdf", filetype: "pdf", mime: "application/pdf", extracted: "x" });
	await expect
		.poll(() => document.querySelector("iframe")?.getAttribute("src"))
		.toBe(`blob:loaded-${"a".repeat(64)}`);
	expect(download().element().getAttribute("href")).toBe(`blob:loaded-${"a".repeat(64)}`);
	expect(download().element().getAttribute("download")).toBe("invoice.pdf");
});
