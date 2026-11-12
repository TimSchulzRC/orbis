// Text from file contents (extract.ts): Office, text in several encodings, HTML, ZIP, PDF with an
// embedded invoice XML. The files are made in the test (support/fixtures.ts).
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { decodeText, extractText, htmlText, TEXT_MAX } from "@obtion/server/extract";
import { docx, pdfWithEmbedded, pptx, xlsx, zip } from "../support/fixtures";
import { removeTempDirs, tempDir } from "../support/helpers";

afterAll(removeTempDirs);
const dir = tempDir("obtion-extract-");
let n = 0;
async function text(name: string, data: Uint8Array | string) {
	const path = join(dir, `${++n}-${name}`);
	await Bun.write(path, data);
	return extractText(path, name);
}

test("Word: paragraphs, then a table row by row with tabs", async () => {
	const r = await text(
		"Concept.docx",
		docx(
			["Approval process", "Review &amp; booking"],
			[
				["Field", "Source"],
				["Date", "Header"],
			],
		),
	);
	expect(r.text).toBe("Approval process\nReview & booking\nField\tSource\nDate\tHeader");
});

test("Excel: every sheet with its name, rows tab-separated, shared strings and numbers", async () => {
	const r = await text(
		"List.xlsx",
		xlsx({
			Partner: [
				["Name", "Count"],
				["Example Ltd", 3],
				["", "empty before"],
			],
			Two: [["x"]],
		}),
	);
	expect(r.text).toBe(
		"Sheet: Partner\nName\tCount\nExample Ltd\t3\n\tempty before\n\nSheet: Two\nx",
	);
});

test("PowerPoint: one block per slide, in slide order", async () => {
	const slides = Array.from({ length: 11 }, (_, i) => [`Page ${i + 1}`]);
	const r = await text("Talk.pptx", pptx(slides));
	expect(r.text!.split("\n\n")[0]).toBe("Slide 1\nPage 1");
	expect(r.text!.split("\n\n")[10]).toBe("Slide 11\nPage 11");
});

test("ZIP and archives built on it: the list of entries", async () => {
	const r = await text("package.mappingzip", zip({ "map/a.xsl": "<x/>", "map/b.txt": "hello" }));
	expect(r.text).toBe("ZIP archive, 2 file(s):\nmap/a.xsl\t4\nmap/b.txt\t5");
});

test("PDF: page text, the embedded invoice XML listed and its text added", async () => {
	const xml =
		'<?xml version="1.0"?><rsm:CrossIndustryInvoice><ram:ID>RE-2026-0042</ram:ID></rsm:CrossIndustryInvoice>';
	const r = await text("invoice.pdf", pdfWithEmbedded("Invoice example", "factur-x.xml", xml));
	expect(r.pages).toBe(1);
	expect(r.text).toContain("Invoice example");
	expect(r.text).toContain(`Embedded files (1):\nfactur-x.xml\t${xml.length}`);
	expect(r.text).toContain(`--- factur-x.xml ---\n${xml}`);
}, 60_000); // pdf.js loads first

test("text and code files of any extension, in UTF-8, Windows-1252 and UTF-16", async () => {
	// umlauts on purpose: they tell the encodings apart
	expect(
		(await text("schema.xsd", '<xs:schema xmlns:xs="x"><xs:element name="Größe"/></xs:schema>'))
			.text,
	).toContain('name="Größe"');
	expect((await text("run.ps1", "Write-Host 'hi'\r\n")).text).toBe("Write-Host 'hi'");
	expect(
		(
			await text(
				"record.idoc",
				new Uint8Array([0x45, 0x44, 0x49, 0x20, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]),
			)
		).text,
	).toBe("EDI Müller");
	expect(await text("note.txt", new Uint8Array([0xff, 0xfe, 0x48, 0, 0xe4, 0]))).toEqual({
		text: "Hä",
	});
	expect((await text("plain.bicmd", "run step 1\n")).text).toBe("run step 1");
	// binaries give nothing
	expect(await text("lib.dll", new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0]))).toEqual({});
	expect(decodeText(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 65]))).toBeUndefined();
});

test("HTML only as text: no scripts, styles or tags", async () => {
	const r = await text(
		"page.html",
		"<html><head><title>T</title><style>p{}</style><script>alert(1)</script></head><body><h1>Header</h1><p>A &amp; B</p><table><tr><td>1</td><td>2</td></tr></table></body></html>",
	);
	expect(r.text).toBe("Header\nA & B\n1\t2");
	expect(htmlText('<p onclick="x()">a<br>b</p>').trim()).toBe("a\nb");
});

test("long text is cut at TEXT_MAX", async () => {
	const r = await text("big.csv", "a;b\n".repeat(TEXT_MAX));
	expect(r.text!.length).toBe(TEXT_MAX + 2);
	expect(r.text!.endsWith("\n…")).toBe(true);
});

test("a broken Office file or ZIP gives nothing instead of failing", async () => {
	expect(await text("broken.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toEqual({});
});

test("hostile or odd files stay small: far Excel columns, a cut UTF-8 character, OpenDocument paragraphs", async () => {
	// a cell reference far beyond Excel's columns allocates nothing
	const far = zip({
		"xl/workbook.xml":
			'<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
		"xl/_rels/workbook.xml.rels":
			'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
		"xl/worksheets/sheet1.xml":
			'<worksheet><sheetData><row r="1"><c r="ZZZZZZZ1" t="inlineStr"><is><t>x</t></is></c><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
	});
	expect((await text("far.xlsx", far)).text).toBe("Sheet: S\n1");
	// cells without a reference keep their place after an empty one
	const loose = zip({
		"xl/workbook.xml":
			'<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
		"xl/_rels/workbook.xml.rels":
			'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
		"xl/worksheets/sheet1.xml":
			"<worksheet><sheetData><row><c><v>1</v></c><c/><c><v>3</v></c></row></sheetData></worksheet>",
	});
	expect((await text("loose.xlsx", loose)).text).toBe("Sheet: S\n1\t\t3");
	// more than what is read, in UTF-8: a character cut at the end is no reason for Windows-1252
	const umlauts = await text("long.txt", "ä".repeat(600_000));
	expect(umlauts.text!.startsWith("ää")).toBe(true);
	const odt = zip({
		mimetype: "application/vnd.oasis.opendocument.text",
		"content.xml":
			"<office:document-content><office:body><office:text><text:p>First paragraph</text:p><text:p>Second <text:span>paragraph</text:span></text:p></office:text></office:body></office:document-content>",
	});
	expect((await text("letter.odt", odt)).text).toBe("First paragraph\nSecond paragraph");
});
