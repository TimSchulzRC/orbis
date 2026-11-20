// Several files as one ZIP (zip.ts): which files lie below an item and under which paths, and an
// archive other programs can read.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { addParent, setFileMeta, setMeta } from "@orbis/core/model";
import {
	archivePaths,
	crc32,
	filesAmong,
	filesBelow,
	fitsZip,
	safeName,
	ZIP_MAX_BYTES,
	zipStore,
} from "@orbis/core/zip";
import { Zip } from "@orbis/server/extract";
import { MemRepo, removeTempDirs, tempDir } from "../support/helpers";

afterAll(removeTempDirs);
const bytes = (s: string) => new TextEncoder().encode(s);

function world() {
	const m = new MemRepo();
	let n = 0;
	const file = (name: string, parents: string[], size = 10) => {
		const id = m.add({ kind: "file", title: name, parents });
		m.change(id, (d) =>
			setFileMeta(d, {
				name,
				hash: String(++n).padStart(64, "0"),
				mime: "application/pdf",
				filetype: "pdf",
				size,
			}),
		);
		return id;
	};
	const customer = m.add({ title: "Etimex", pinned: "V" });
	const invoices = m.add({ title: "E-Rechnungen", parents: [customer] });
	const tests = m.add({ title: "Tests", parents: [customer] });
	const run = m.add({ title: "Lauf 29.10. / Postfach", parents: [tests] });
	return { m, file, customer, invoices, tests, run };
}
const paths = (m: MemRepo, id: string) => archivePaths(filesBelow(id, m.index())).sort();

test("files below an item, at any depth, with the titles on the way as folders", () => {
	const w = world();
	w.file("checklist.pdf", [w.customer]);
	w.file("0074022763.pdf", [w.invoices]);
	w.file("0074022749.pdf", [w.run]);
	w.m.add({ title: "Status", parents: [w.customer] }); // a note is not a file
	expect(paths(w.m, w.customer)).toEqual([
		"E-Rechnungen/0074022763.pdf",
		"Tests/Lauf 29.10. _ Postfach/0074022749.pdf",
		"checklist.pdf",
	]);
	expect(paths(w.m, w.tests)).toEqual(["Lauf 29.10. _ Postfach/0074022749.pdf"]);
	expect(paths(w.m, w.invoices)).toEqual(["0074022763.pdf"]);
});

test("a file with two places comes once, at its home; one in the trash or without content not at all", () => {
	const w = world();
	const twice = w.file("twice.pdf", [w.run, w.invoices]);
	w.m.change(twice, (d) => setMeta(d, { home: w.invoices }));
	const gone = w.file("gone.pdf", [w.invoices]);
	w.m.change(gone, (d) => setMeta(d, { deleted: true }));
	w.m.add({ kind: "file", title: "still-uploading.pdf", parents: [w.invoices] });
	expect(paths(w.m, w.customer)).toEqual(["E-Rechnungen/twice.pdf"]);
});

test("notes that lie below each other do not loop", () => {
	const w = world();
	w.m.add({ id: "loop-a", title: "A", parents: [w.tests] });
	w.m.add({ id: "loop-b", title: "B", parents: ["loop-a"] });
	w.file("a.pdf", ["loop-b"]);
	// A also below B, made last: the edge that closes the cycle is ignored (graph.ts), and with its
	// own timestamp that does not depend on both items being made in the same millisecond
	w.m.change("loop-a", (d) => addParent(d, "loop-b", undefined, Date.now() + 1000));
	expect(paths(w.m, w.tests)).toEqual(["A/B/a.pdf"]);
});

test("the same name twice in one folder gets a number, upper and lower case alike", () => {
	const w = world();
	w.file("Druckdaten.PDF", [w.invoices]);
	w.file("druckdaten.pdf", [w.invoices]);
	w.file("Druckdaten.PDF", [w.run]);
	w.file("README", [w.invoices]);
	w.file("README", [w.invoices]);
	const ix = w.m.index();
	expect(archivePaths(filesBelow(w.invoices, ix)).sort()).toEqual([
		"Druckdaten (2).PDF",
		"README",
		"README (2)",
		"druckdaten.pdf",
	]);
	// a list has no folders: all names side by side
	const flat = archivePaths(filesAmong(ix.live.filter((x) => x.title.endsWith("PDF"))));
	expect(flat.sort()).toEqual(["Druckdaten (2).PDF", "Druckdaten.PDF"]);
});

test("names every system can write", () => {
	expect(safeName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
	expect(safeName("Bericht. ")).toBe("Bericht");
	expect(safeName("..")).toBe("_");
	expect(safeName("", "file")).toBe("file");
	expect(safeName("Übersicht – März.pdf")).toBe("Übersicht – März.pdf");
});

test("too much for one archive", () => {
	const w = world();
	w.file("a.bin", [w.invoices], ZIP_MAX_BYTES - 5);
	w.file("b.bin", [w.invoices], 5);
	expect(fitsZip(filesBelow(w.customer, w.m.index()))).toBe(true);
	w.file("c.bin", [w.invoices], 1);
	expect(fitsZip(filesBelow(w.customer, w.m.index()))).toBe(false);
});

test("crc32 as ZIP wants it", () => {
	expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
	expect(crc32(new Uint8Array())).toBe(0);
});

test("the archive: read back by the server's ZIP reader and by unzip", async () => {
	const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);
	const entries = [
		{
			path: "E-Rechnungen/Rechnung Ärger.pdf",
			data: bytes("%PDF-1.7 one"),
			modified: Date.UTC(2026, 10, 6, 12),
		},
		{ path: "Tests/big.bin", data: big },
		{ path: "empty.txt", data: new Uint8Array() },
	];
	const path = join(tempDir("orbis-zip-"), "out.zip");
	await Bun.write(path, new Blob(zipStore(entries) as BlobPart[]));

	const zip = (await Zip.open(path))!;
	expect(zip.entries.map((e) => [e.name, e.usize, e.method])).toEqual([
		["E-Rechnungen/Rechnung Ärger.pdf", 12, 0],
		["Tests/big.bin", 300_000, 0],
		["empty.txt", 0, 0],
	]);
	expect(await zip.text("E-Rechnungen/Rechnung Ärger.pdf")).toBe("%PDF-1.7 one");
	expect(await zip.read("Tests/big.bin")).toEqual(big);

	// a program of its own checks every entry's CRC and the directory
	const unzip = Bun.which("unzip");
	if (unzip) {
		const test = Bun.spawnSync([unzip, "-t", path]);
		expect(test.stdout.toString()).toContain("No errors detected");
		expect(test.exitCode).toBe(0);
		const out = Bun.spawnSync([unzip, "-p", path, "Tests/big.bin"]);
		expect(new Uint8Array(out.stdout)).toEqual(big);
	}
});

test("an empty archive is still a ZIP", async () => {
	const path = join(tempDir("orbis-zip-"), "empty.zip");
	await Bun.write(path, new Blob(zipStore([]) as BlobPart[]));
	expect((await Zip.open(path))!.entries).toEqual([]);
});
