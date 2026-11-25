// The file page: a text or code file shows its content (monospace), an Office file the text the
// server took out, an Excel workbook its sheets, HTML only as text – never rendered; every file
// has its download.

import { type FileMeta, initItem, newId, setFileMeta } from "@orbis/core/model";
import { zipStore } from "@orbis/core/zip";
import type { Repo } from "@orbis/sync";
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

/** A workbook with two sheets, as Excel stores it (stored, not compressed: the reader takes both). */
function workbook(): Blob {
	const enc = new TextEncoder();
	const files: Record<string, string> = {
		"xl/workbook.xml":
			'<workbook xmlns:r="r"><sheets><sheet name="Umsatz" sheetId="1" r:id="rId1"/><sheet name="Notizen" sheetId="2" r:id="rId2"/></sheets></workbook>',
		"xl/_rels/workbook.xml.rels":
			'<Relationships><Relationship Id="rId1" Type="w" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="w" Target="worksheets/sheet2.xml"/></Relationships>',
		"xl/sharedStrings.xml":
			"<sst><si><t>Kunde</t></si><si><t>Betrag</t></si><si><t>Müller</t></si></sst>",
		"xl/styles.xml":
			'<styleSheet><numFmts><numFmt numFmtId="164" formatCode="#,##0.00 &quot;€&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
		"xl/worksheets/sheet1.xml":
			'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>1234.5</v></c></row><row r="3"><c r="B3" s="1"><f>SUM(B2)</f><v>1234.5</v></c></row></sheetData></worksheet>',
		"xl/worksheets/sheet2.xml":
			'<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Zweites Blatt</t></is></c></row></sheetData></worksheet>',
	};
	const parts = zipStore(Object.entries(files).map(([path, s]) => ({ path, data: enc.encode(s) })));
	return new Blob(parts as BlobPart[]);
}

const sheetFiles = (blob: Blob | undefined) =>
	({ ...serverFiles, content: async () => blob }) as unknown as DeviceFiles;

test("an Excel workbook: its cells as Excel shows them, sheets as tabs, the whole width", async () => {
	await show(
		{ name: "Umsatz.xlsx", filetype: "document", text: "Sheet: Umsatz", extracted: "x" },
		sheetFiles(workbook()),
	);
	const grid = page.getByRole("grid");
	await expect.element(grid).toBeVisible();
	await expect.element(grid.getByText("1.234,50 €").first()).toBeVisible();
	await expect.element(grid.getByText("Müller")).toBeVisible();
	expect(document.querySelector(".page-full")).not.toBeNull();
	expect(document.querySelector("[data-testid=file-text]")).toBeNull();
	// a click shows the cell's value and formula above the grid
	const box = grid.element().getBoundingClientRect();
	const cell = [...grid.element().querySelectorAll(".xl-cell")].filter(
		(e) => e.textContent === "1.234,50 €",
	)[1]!;
	const r = cell.getBoundingClientRect();
	expect(r.left).toBeGreaterThan(box.left);
	await page.elementLocator(cell).click();
	await expect.element(page.getByTestId("sheet-value")).toHaveTextContent("1.234,50 €=SUM(B2)");
	// search jumps to the hit
	await page.getByRole("searchbox", { name: "In der Tabelle suchen" }).fill("müll");
	await expect.element(page.getByText("1 von 1")).toBeVisible();
	await expect.element(page.getByTestId("sheet-value")).toHaveTextContent("Müller");
	// the other sheet
	await page.getByRole("tab", { name: "Notizen" }).click();
	await expect.element(grid.getByText("Zweites Blatt")).toBeVisible();
	await expect
		.element(page.getByRole("tab", { name: "Notizen" }))
		.toHaveAttribute("aria-selected", "true");
});

test("an Excel workbook whose content can't be had: the text the server took out", async () => {
	await show(
		{
			name: "Offline.xlsx",
			filetype: "document",
			text: "Sheet: Umsatz\nKunde\tBetrag",
			extracted: "x",
		},
		sheetFiles(undefined),
	);
	await expect.element(page.getByTestId("file-text")).toBeVisible();
	expect(page.getByTestId("file-text").element().textContent).toBe("Sheet: Umsatz\nKunde\tBetrag");
});
