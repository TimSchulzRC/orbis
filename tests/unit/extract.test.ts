// Text from file contents (extract.ts): Office, text in several encodings, HTML, ZIP, PDF with an
// embedded invoice XML. The files are made in the test (support/fixtures.ts).
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { TEXT_MAX, decodeText, extractText, htmlText } from "@obtion/server/extract";
import { tempDir, removeTempDirs } from "../support/helpers";
import { docx, pdfWithEmbedded, pptx, xlsx, zip } from "../support/fixtures";

afterAll(removeTempDirs);
const dir = tempDir("obtion-extract-");
let n = 0;
async function text(name: string, data: Uint8Array | string) {
  const path = join(dir, `${++n}-${name}`);
  await Bun.write(path, data);
  return extractText(path, name);
}

test("Word: paragraphs, then a table row by row with tabs", async () => {
  const r = await text("Konzept.docx", docx(["Ablauf der Freigabe", "Prüfung &amp; Buchung"], [["Feld", "Quelle"], ["Datum", "Kopf"]]));
  expect(r.text).toBe("Ablauf der Freigabe\nPrüfung & Buchung\nFeld\tQuelle\nDatum\tKopf");
});

test("Excel: every sheet with its name, rows tab-separated, shared strings and numbers", async () => {
  const r = await text("Liste.xlsx", xlsx({ Partner: [["Name", "Anzahl"], ["Beispiel AG", 3], ["", "leer davor"]], Zwei: [["x"]] }));
  expect(r.text).toBe("Sheet: Partner\nName\tAnzahl\nBeispiel AG\t3\n\tleer davor\n\nSheet: Zwei\nx");
});

test("PowerPoint: one block per slide, in slide order", async () => {
  const slides = Array.from({ length: 11 }, (_, i) => [`Folie ${i + 1}`]);
  const r = await text("Vortrag.pptx", pptx(slides));
  expect(r.text!.split("\n\n")[0]).toBe("Slide 1\nFolie 1");
  expect(r.text!.split("\n\n")[10]).toBe("Slide 11\nFolie 11");
});

test("ZIP and archives built on it: the list of entries", async () => {
  const r = await text("paket.mappingzip", zip({ "map/a.xsl": "<x/>", "map/b.txt": "hallo" }));
  expect(r.text).toBe("ZIP archive, 2 file(s):\nmap/a.xsl\t4\nmap/b.txt\t5");
});

test("PDF: page text, the embedded invoice XML listed and its text added", async () => {
  const xml = '<?xml version="1.0"?><rsm:CrossIndustryInvoice><ram:ID>RE-2026-0042</ram:ID></rsm:CrossIndustryInvoice>';
  const r = await text("rechnung.pdf", pdfWithEmbedded("Rechnung Beispiel", "factur-x.xml", xml));
  expect(r.pages).toBe(1);
  expect(r.text).toContain("Rechnung Beispiel");
  expect(r.text).toContain(`Embedded files (1):\nfactur-x.xml\t${xml.length}`);
  expect(r.text).toContain(`--- factur-x.xml ---\n${xml}`);
}, 60_000); // pdf.js loads first

test("text and code files of any extension, in UTF-8, Windows-1252 and UTF-16", async () => {
  expect((await text("schema.xsd", '<xs:schema xmlns:xs="x"><xs:element name="Größe"/></xs:schema>')).text).toContain('name="Größe"');
  expect((await text("lauf.ps1", "Write-Host 'hi'\r\n")).text).toBe("Write-Host 'hi'");
  expect((await text("satz.idoc", new Uint8Array([0x45, 0x44, 0x49, 0x20, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]))).text).toBe("EDI Müller");
  expect((await text("notiz.txt", new Uint8Array([0xff, 0xfe, 0x48, 0, 0xe4, 0])))).toEqual({ text: "Hä" });
  expect((await text("ohne.bicmd", "run step 1\n")).text).toBe("run step 1");
  // binaries give nothing
  expect(await text("lib.dll", new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0]))).toEqual({});
  expect(decodeText(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 65]))).toBeUndefined();
});

test("HTML only as text: no scripts, styles or tags", async () => {
  const r = await text("seite.html", "<html><head><title>T</title><style>p{}</style><script>alert(1)</script></head><body><h1>Kopf</h1><p>A &amp; B</p><table><tr><td>1</td><td>2</td></tr></table></body></html>");
  expect(r.text).toBe("Kopf\nA & B\n1\t2");
  expect(htmlText("<p onclick=\"x()\">a<br>b</p>").trim()).toBe("a\nb");
});

test("long text is cut at TEXT_MAX", async () => {
  const r = await text("gross.csv", "a;b\n".repeat(TEXT_MAX));
  expect(r.text!.length).toBe(TEXT_MAX + 2);
  expect(r.text!.endsWith("\n…")).toBe(true);
});

test("a broken Office file or ZIP gives nothing instead of failing", async () => {
  expect(await text("kaputt.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toEqual({});
});

test("hostile or odd files stay small: far Excel columns, a cut UTF-8 character, OpenDocument paragraphs", async () => {
  // a cell reference far beyond Excel's columns allocates nothing
  const far = zip({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="ZZZZZZZ1" t="inlineStr"><is><t>x</t></is></c><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
  });
  expect((await text("weit.xlsx", far)).text).toBe("Sheet: S\n1");
  // more than what is read, in UTF-8: a character cut at the end is no reason for Windows-1252
  const umlauts = await text("lang.txt", "ä".repeat(600_000));
  expect(umlauts.text!.startsWith("ää")).toBe(true);
  const odt = zip({ mimetype: "application/vnd.oasis.opendocument.text", "content.xml": '<office:document-content><office:body><office:text><text:p>Erster Absatz</text:p><text:p>Zweiter <text:span>Absatz</text:span></text:p></office:text></office:body></office:document-content>' });
  expect((await text("brief.odt", odt)).text).toBe("Erster Absatz\nZweiter Absatz");
});
