// "Dateien herunterladen (n)": everything below an item as one ZIP with its folders, from the
// sidebar's menu and "Darunter"; the files a query block shows, from its menu.

import { initItem, newId, setFileMeta } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { Space } from "../../packages/ui/src/accounts";
import { DeviceFiles, setFiles, sha256 } from "../../packages/ui/src/files";
import { ScopeContext } from "../../packages/ui/src/scope";
import { SpaceTree } from "../../packages/ui/src/ui/Sidebar";
import { AppToaster } from "../../packages/ui/src/ui/toasts";
import { ItemPage } from "../../packages/ui/src/views/ItemPage";
import { noop, workspace } from "./workspace";

/** What the browser was handed to save: the name and the bytes. */
const saved: { name: string; bytes: Uint8Array }[] = [];
const pending: Promise<unknown>[] = [];
beforeEach(() => {
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		if (!this.download) return;
		const name = this.download;
		pending.push(
			fetch(this.href)
				.then((r) => r.arrayBuffer())
				.then((b) => saved.push({ name, bytes: new Uint8Array(b) })),
		);
	});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	saved.length = 0;
	pending.length = 0;
	slow.ms = 0;
	location.hash = "";
});

/** The entries of a ZIP, from its directory: path and content as text. */
function unzip(zip: Uint8Array): Record<string, string> {
	const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const end = zip.length - 22;
	expect(dv.getUint32(end, true)).toBe(0x06054b50);
	const out: Record<string, string> = {};
	let p = dv.getUint32(end + 16, true);
	for (let n = dv.getUint16(end + 10, true); n > 0; n--) {
		expect(dv.getUint32(p, true)).toBe(0x02014b50);
		const size = dv.getUint32(p + 24, true);
		const nameLen = dv.getUint16(p + 28, true);
		const local = dv.getUint32(p + 42, true);
		const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
		const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
		out[name] = new TextDecoder().decode(zip.subarray(start, start + size));
		p += 46 + nameLen;
	}
	return out;
}

/** How long each content takes to load. */
const slow = { ms: 0 };
/** The device's files with contents held in memory; `lost` ones are on no device and no server. */
const contents = new Map<string, Blob>();
const device = Object.assign(Object.create(DeviceFiles.prototype), {
	subscribe: () => noop,
	getVersion: () => 0,
	isMissing: () => false,
	hasLocal: () => true,
	check: () => Promise.resolve(),
	url: async () => undefined,
	content: async (hash: string) => {
		if (slow.ms) await new Promise((r) => setTimeout(r, slow.ms));
		return contents.get(hash);
	},
	viewUrl: async (hash: string) =>
		contents.has(hash) ? URL.createObjectURL(contents.get(hash)!) : undefined,
}) as DeviceFiles;

async function addFile(repo: Repo, name: string, parent: string, text: string, lost = false) {
	const blob = new Blob([text]);
	const hash = await sha256(blob);
	if (!lost) contents.set(hash, blob);
	const id = newId();
	repo.change(id, (doc) => {
		initItem(doc, { kind: "file", title: name, parents: [parent] });
		setFileMeta(doc, { name, hash, mime: "application/pdf", filetype: "pdf", size: blob.size });
	});
	return id;
}

/** A customer with invoices in one folder, a test run two levels down and a note without files. */
async function customer() {
	const repo = await workspace(false);
	setFiles(device);
	contents.clear();
	const etimex = repo.create({ title: "Etimex", pinned: "a" });
	const invoices = repo.create({ title: "E-Rechnungen", parents: [etimex] });
	const tests = repo.create({ title: "Tests", parents: [etimex] });
	const run = repo.create({ title: "Postfach 29.10.", parents: [tests] });
	const status = repo.create({ title: "Status", parents: [etimex] });
	await addFile(repo, "ZUGFeRD_0074022763.pdf", invoices, "invoice 63");
	await addFile(repo, "ZUGFeRD_0074022773.pdf", invoices, "credit note 73");
	await addFile(repo, "Druckdaten.PDF", run, "print data");
	await Promise.resolve(); // the replica reads changed documents in a microtask
	return { repo, etimex, invoices, tests, run, status };
}

const today = new Date().toLocaleDateString("sv");
const entry = (n: number) => page.getByRole("button", { name: `Dateien herunterladen (${n})` });
async function theSaved() {
	await expect.poll(() => pending.length).toBe(1);
	await Promise.all(pending);
	return saved[0]!;
}

async function sidebar(repo: Repo) {
	await render(
		<ScopeContext.Provider value={{ id: "w1", repo, files: device }}>
			<div style={{ width: 256 }}>
				<SpaceTree space={{ id: "w1", name: "Test" } as Space} />
			</div>
			<AppToaster />
		</ScopeContext.Provider>,
	);
}

test("sidebar: a right click on an item offers all files below it, saved as a ZIP with folders", async () => {
	const { repo } = await customer();
	await sidebar(repo);
	await page.getByRole("link", { name: "Etimex" }).click({ button: "right" });
	await entry(3).click();
	const zip = await theSaved();
	expect(zip.name).toBe(`Etimex_${today}.zip`);
	expect(unzip(zip.bytes)).toEqual({
		"E-Rechnungen/ZUGFeRD_0074022763.pdf": "invoice 63",
		"E-Rechnungen/ZUGFeRD_0074022773.pdf": "credit note 73",
		// a folder's name may not end in a dot (Windows)
		"Tests/Postfach 29.10/Druckdaten.PDF": "print data",
	});
});

test("sidebar: an item with one file below saves that file as it is; one without files has no entry", async () => {
	const { repo } = await customer();
	await sidebar(repo);
	await page.getByRole("button", { name: "Aufklappen" }).first().click();
	await page.getByRole("link", { name: "Status" }).click({ button: "right" });
	await expect.element(page.getByRole("button", { name: "Anheften" })).toBeVisible();
	expect(page.getByText(/Dateien herunterladen/).query()).toBeNull();
	await userEvent.keyboard("{Escape}");

	await page.getByRole("link", { name: "Tests" }).click({ button: "right" });
	await entry(1).click();
	const one = await theSaved();
	expect(one.name).toBe("Druckdaten.PDF");
	expect(new TextDecoder().decode(one.bytes)).toBe("print data");
});

test('page: "Darunter" has the action beside "Darunter anlegen", the … menu has no entry', async () => {
	const { invoices } = await customer();
	await render(<ItemPage id={invoices} isNew={false} />);
	await expect.element(page.getByRole("heading", { name: "Darunter" })).toBeVisible();
	const add = page.getByRole("button", { name: "Darunter anlegen" });
	const action = entry(2);
	// in the section's head, left of "Darunter anlegen"
	const a = action.element().getBoundingClientRect();
	const b = add.element().getBoundingClientRect();
	expect(a.right).toBeLessThanOrEqual(b.left);
	expect(Math.abs(a.top - b.top)).toBeLessThan(2);
	await action.click();
	const zip = await theSaved();
	expect(zip.name).toBe(`E-Rechnungen_${today}.zip`);
	expect(Object.keys(unzip(zip.bytes))).toEqual([
		"ZUGFeRD_0074022763.pdf",
		"ZUGFeRD_0074022773.pdf",
	]);

	await page.getByRole("button", { name: "Mehr", exact: true }).click();
	await expect.element(page.getByRole("button", { name: "Neue Seite darunter" })).toBeVisible();
	// only the section's action
	expect(entry(2).elements().length).toBe(1);
});

test("query block: its … menu offers the files it shows, flat, same names told apart", async () => {
	const { repo, etimex, tests } = await customer();
	await addFile(repo, "Druckdaten.PDF", tests, "other print data");
	const overview = repo.create({
		title: "Übersicht",
		parents: [etimex],
		body: "```query\ndatei unter:[[Etimex]] Druckdaten\n```\n",
	});
	await Promise.resolve();
	await render(<ItemPage id={overview} isNew={false} />);
	await expect.poll(() => document.querySelector(".cm-queryblock")).not.toBeNull();
	const block = page.elementLocator(document.querySelector(".cm-queryblock")!);
	await block.getByRole("button", { name: "Mehr", exact: true }).click();
	await entry(2).click();
	const zip = await theSaved();
	expect(zip.name).toBe(`Übersicht_${today}.zip`);
	expect(Object.values(unzip(zip.bytes)).sort()).toEqual(["other print data", "print data"]);
	expect(Object.keys(unzip(zip.bytes)).sort()).toEqual(["Druckdaten (2).PDF", "Druckdaten.PDF"]);
});

test("a file whose content can't be had is left out and named; with none to be had nothing is saved", async () => {
	const { repo, invoices, status } = await customer();
	await addFile(repo, "lost.pdf", invoices, "never uploaded", true);
	await addFile(repo, "lost-1.pdf", status, "one", true);
	await addFile(repo, "lost-2.pdf", status, "two", true);
	await Promise.resolve();
	await sidebar(repo);
	await page.getByRole("button", { name: "Aufklappen" }).first().click();
	await page.getByRole("link", { name: "E-Rechnungen" }).click({ button: "right" });
	await entry(3).click();
	const zip = await theSaved();
	expect(Object.keys(unzip(zip.bytes))).toHaveLength(2);
	await expect
		.element(page.getByText("1 Datei fehlt im ZIP, der Inhalt war nicht zu bekommen: lost.pdf"))
		.toBeVisible();

	pending.length = 0;
	await page.getByRole("link", { name: "Status" }).click({ button: "right" });
	await entry(2).click();
	await expect
		.element(page.getByText(/Nichts heruntergeladen: .* \(lost-1\.pdf, lost-2\.pdf\)/))
		.toBeVisible();
	expect(pending).toHaveLength(0);
});

test("a download that takes a while says so until the ZIP is saved", async () => {
	const { repo } = await customer();
	slow.ms = 1200;
	await sidebar(repo);
	await page.getByRole("link", { name: "Etimex" }).click({ button: "right" });
	await entry(3).click();
	const notice = page.getByText("3 Dateien werden gepackt …");
	await expect.element(notice).toBeVisible();
	expect(pending).toHaveLength(0);
	await theSaved();
	await expect.element(notice).not.toBeInTheDocument();
});
