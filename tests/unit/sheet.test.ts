// The Excel viewer's reading (sheet/workbook.ts) and number formats (sheet/numfmt.ts): values as
// Excel shows them, sheets, styles, merges and frozen panes from a workbook built here.
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { zipStore } from "@orbis/core/zip";
import {
	builtinFormat,
	cellText,
	type FormatOptions,
	formatNumber,
	formatText,
	general,
} from "../../packages/ui/src/sheet/numfmt";
import {
	colName,
	parseRef,
	readWorkbook,
	shiftFormula,
} from "../../packages/ui/src/sheet/workbook";

const de: FormatOptions = { lang: "de" };
const en: FormatOptions = { lang: "en" };
const fmt = (v: number, code: string, opts = de) => formatNumber(v, code, opts).text;

describe("number formats", () => {
	test("General: like Excel, with the language's decimal mark", () => {
		expect(general(1234.5, "de")).toBe("1234,5");
		expect(general(1234.5, "en")).toBe("1234.5");
		expect(general(0.1 + 0.2, "en")).toBe("0.3");
		expect(general(123456789012, "en")).toBe("1.23457E+11");
		expect(general(-42, "de")).toBe("-42");
	});

	test("digits, grouping, decimals, percent, scaling", () => {
		expect(fmt(1234.567, "0")).toBe("1235");
		expect(fmt(1234.567, "0.00")).toBe("1234,57");
		expect(fmt(1234567.891, "#,##0.00")).toBe("1.234.567,89");
		expect(fmt(1234567.891, "#,##0.00", en)).toBe("1,234,567.89");
		expect(fmt(0, "#,##0")).toBe("0");
		expect(fmt(0.256, "0.0%")).toBe("25,6%");
		expect(fmt(5, "000")).toBe("005");
		expect(fmt(1.5, "0.##")).toBe("1,5");
		expect(fmt(1234567, '#,##0,"k"', en)).toBe("1,235k");
		expect(fmt(1.005, "0.00")).toBe("1,01");
		expect(fmt(-1234.5, "#,##0.00")).toBe("-1.234,50");
	});

	test("sections, colours, literals and currency", () => {
		expect(formatNumber(-5, "#,##0.00;[Red]-#,##0.00", de)).toEqual({
			text: "-5,00",
			color: "#ff0000",
		});
		expect(fmt(-5, "0;(0)")).toBe("(5)");
		expect(fmt(0, '0;-0;"–"')).toBe("–");
		expect(fmt(1234.5, '#,##0.00 "€"')).toBe("1.234,50 €");
		expect(fmt(1234.5, "[$€-407] #,##0.00")).toBe("€ 1.234,50");
		expect(fmt(12, '_-* #,##0.00 €_-;-* #,##0.00 €_-;_-* "-"?? €_-;_-@_-')).toBe(" 12,00 € ");
		expect(fmt(150, "[>100]0.0;0")).toBe("150,0");
		expect(fmt(50, "[>100]0.0;0")).toBe("50");
		expect(formatText("Text", '0;-0;0;"Wert: "@').text).toBe("Wert: Text");
	});

	test("exponents and fractions", () => {
		expect(fmt(12345, "0.00E+00", en)).toBe("1.23E+04");
		expect(fmt(0.00012, "0.0E+00", en)).toBe("1.2E-04");
		expect(fmt(1.5, "# ?/?", en)).toBe("1 1/2");
		expect(fmt(0.75, "?/?", en)).toBe("3/4");
		expect(fmt(2.3, "# ?/8", en)).toBe("2 2/8");
	});

	test("dates and times from serial numbers", () => {
		// 46023 = 2026-01-01
		expect(fmt(46023, builtinFormat(14, "de"))).toBe("01.01.2026");
		expect(fmt(46023, builtinFormat(14, "en"), en)).toBe("1/1/2026");
		expect(fmt(46023.75, "dd.mm.yyyy hh:mm")).toBe("01.01.2026 18:00");
		expect(fmt(46023, "dddd, d. mmmm yyyy")).toBe("Donnerstag, 1. Januar 2026");
		expect(fmt(46023, "d-mmm-yy", en)).toBe("1-Jan-26");
		expect(fmt(0.5, "h:mm AM/PM", en)).toBe("12:00 PM");
		expect(fmt(0.25 + 30 / 86400, "hh:mm:ss")).toBe("06:00:30");
		expect(fmt(1.5, "[h]:mm")).toBe("36:00");
		expect(fmt(1.5, "[h]")).toBe("36");
		expect(fmt(60, "dd.mm.yyyy")).toBe("29.02.1900");
		expect(fmt(0, "yyyy-mm-dd", { lang: "de", date1904: true })).toBe("1904-01-01");
		// rounds to the second shown
		expect(fmt(0.999999, "hh:mm:ss")).toBe("00:00:00");
	});

	test("booleans and errors", () => {
		expect(cellText({ t: "b", v: true }, "General", de).text).toBe("WAHR");
		expect(cellText({ t: "b", v: false }, "General", en).text).toBe("FALSE");
		expect(cellText({ t: "e", v: "#DIV/0!" }, "General", de).text).toBe("#DIV/0!");
	});
});

describe("references and formulas", () => {
	test("cell references both ways", () => {
		expect(parseRef("A1")).toEqual({ r: 0, c: 0 });
		expect(parseRef("$AB$12")).toEqual({ r: 11, c: 27 });
		expect(colName(0)).toBe("A");
		expect(colName(27)).toBe("AB");
		expect(colName(16383)).toBe("XFD");
	});

	test("a shared formula moves its relative references", () => {
		expect(shiftFormula("SUM(A1:B2)*$C$1", 2, 1)).toBe("SUM(B3:C4)*$C$1");
		expect(shiftFormula('IF(A1>0,"A1",Sheet2!B1)', 1, 0)).toBe('IF(A2>0,"A1",Sheet2!B2)');
		expect(shiftFormula("LOG10(A1)", 1, 0)).toBe("LOG10(A2)");
		expect(shiftFormula("Q1!A1+Table1[Q1]", 1, 0)).toBe("Q1!A2+Table1[Q1]");
		expect(shiftFormula("SUM(Q1:Q2!A1)", 1, 0)).toBe("SUM(Q1:Q2!A2)");
	});
});

const enc = new TextEncoder();

/** A small workbook: two sheets (one hidden), shared strings, styles, a merge, a frozen row. */
function workbook(compress: boolean): Uint8Array {
	const files: Record<string, string> = {
		"[Content_Types].xml": "<Types/>",
		"_rels/.rels":
			'<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
		"xl/workbook.xml":
			'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="1"/></bookViews><sheets><sheet name="Umsatz &amp; Kosten" sheetId="1" r:id="rId1"/><sheet name="Notizen" sheetId="2" r:id="rId2"/><sheet name="Intern" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>',
		"xl/_rels/workbook.xml.rels":
			'<Relationships><Relationship Id="rId1" Type=".../worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type=".../worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type=".../worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type=".../styles" Target="styles.xml"/><Relationship Id="rId5" Type=".../sharedStrings" Target="sharedStrings.xml"/></Relationships>',
		"xl/sharedStrings.xml":
			'<sst><si><t>Kunde</t></si><si><r><rPr><b/></rPr><t>Bet</t></r><r><t xml:space="preserve">rag</t></r></si><si><t>Zeile_x000A_zwei</t><rPh><t>x</t></rPh></si></sst>',
		"xl/styles.xml":
			'<styleSheet><numFmts><numFmt numFmtId="164" formatCode="#,##0.00 &quot;€&quot;"/></numFmts><fonts><font><sz val="11"/></font><font><b/><sz val="14"/><color rgb="FFFFFFFF"/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5"/></patternFill></fill></fills><cellXfs><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="164" fontId="0" fillId="0"/><xf numFmtId="14" fontId="1" fillId="2" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf></cellXfs></styleSheet>',
		"xl/worksheets/sheet1.xml":
			'<worksheet><sheetViews><sheetView><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="20" customWidth="1"/><col min="3" max="3" hidden="1"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2" ht="30" customHeight="1"><c r="A2" t="inlineStr"><is><t>Müller &lt;GmbH&gt;</t></is></c><c r="B2" s="1"><v>1234.5</v></c><c r="C2" s="2"><v>46023</v></c></row><row r="3"><c r="B3" s="1"><f>SUM(B2:B2)</f><v>1234.5</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="e"><v>#N/A</v></c><c r="F3"><f t="shared" ref="F3:F4" si="0">B3*2</f><v>2469</v></c></row><row r="4"><c r="F4"><f t="shared" si="0"/><v>0</v></c></row><row r="6"><c r="A6" t="s"><v>2</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="D5:E7"/></mergeCells></worksheet>',
		"xl/worksheets/sheet2.xml": "<worksheet><sheetData/></worksheet>",
		"xl/worksheets/sheet3.xml":
			"<worksheet><sheetData><row><c><v>1</v></c><c><v>2</v></c></row></sheetData></worksheet>",
	};
	const entries = Object.entries(files).map(([path, text]) => ({ path, data: enc.encode(text) }));
	const parts = zipStore(entries);
	let bytes: Uint8Array = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		bytes.set(p, at);
		at += p.length;
	}
	if (compress) bytes = deflated(entries);
	return bytes;
}

/** The same entries as a ZIP with deflated data, as Excel writes it. */
function deflated(entries: { path: string; data: Uint8Array }[]): Uint8Array {
	const out: number[] = [];
	const dir: number[] = [];
	const u16 = (a: number[], n: number) => a.push(n & 255, (n >> 8) & 255);
	const u32 = (a: number[], n: number) =>
		a.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
	for (const e of entries) {
		const name = enc.encode(e.path);
		const data = deflateRawSync(e.data);
		const offset = out.length;
		u32(out, 0x04034b50);
		u16(out, 20);
		u16(out, 0x800);
		u16(out, 8);
		u32(out, 0);
		u32(out, 0); // crc: not checked
		u32(out, data.length);
		u32(out, e.data.length);
		u16(out, name.length);
		u16(out, 0);
		out.push(...name, ...data);
		u32(dir, 0x02014b50);
		u16(dir, 20);
		u16(dir, 20);
		u16(dir, 0x800);
		u16(dir, 8);
		u32(dir, 0);
		u32(dir, 0);
		u32(dir, data.length);
		u32(dir, e.data.length);
		u16(dir, name.length);
		u16(dir, 0);
		u16(dir, 0);
		u16(dir, 0);
		u16(dir, 0);
		u32(dir, 0);
		u32(dir, offset);
		dir.push(...name);
	}
	const dirAt = out.length;
	out.push(...dir);
	u32(out, 0x06054b50);
	u16(out, 0);
	u16(out, 0);
	u16(out, entries.length);
	u16(out, entries.length);
	u32(out, dir.length);
	u32(out, dirAt);
	u16(out, 0);
	return new Uint8Array(out);
}

describe("reading a workbook", () => {
	for (const compress of [false, true]) {
		test(`sheets, values, styles and layout (${compress ? "deflated" : "stored"})`, async () => {
			const book = (await readWorkbook(workbook(compress), (id) => builtinFormat(id, "de")))!;
			expect(book.sheets.map((s) => [s.name, s.hidden])).toEqual([
				["Umsatz & Kosten", false],
				["Notizen", false],
				["Intern", true],
			]);
			expect(book.active).toBe(1);
			const s = (await book.sheet(0))!;
			const text = (r: number, c: number) => {
				const cell = s.cells[r]?.[c];
				return cell ? cellText(cell, book.styles[cell.s]!.fmt, de).text : undefined;
			};
			expect(text(0, 0)).toBe("Kunde");
			expect(text(0, 1)).toBe("Betrag"); // rich text runs joined
			expect(text(1, 0)).toBe("Müller <GmbH>");
			expect(text(1, 1)).toBe("1.234,50 €");
			expect(text(1, 2)).toBe("01.01.2026");
			expect(text(2, 3)).toBe("WAHR");
			expect(text(2, 4)).toBe("#N/A");
			expect(text(5, 0)).toBe("Zeile\nzwei"); // escaped line break, no phonetic run
			expect(s.cells[2]?.[1]?.f).toBe("SUM(B2:B2)");
			expect(s.cells[3]?.[5]?.f).toBe("B4*2"); // the shared formula, moved a row down
			const header = book.styles[s.cells[1]![2]!.s]!;
			expect(header).toMatchObject({
				bold: true,
				size: 14,
				color: "#ffffff",
				align: "center",
				wrap: true,
			});
			expect(header.fill).toMatch(/^#[0-9a-f]{6}$/);
			expect(s.frozen).toEqual({ rows: 1, cols: 0 });
			expect(s.merges).toEqual([{ r1: 4, c1: 3, r2: 6, c2: 4 }]);
			expect(s.widths.get(0)).toBe(140);
			expect(s.widths.get(2)).toBe(0);
			expect(s.heights.get(1)).toBe(40);
			expect(s.defaultHeight).toBe(20);
			expect([s.rows, s.cols]).toEqual([6, 6]);
			expect((await book.sheet(1))?.rows).toBe(0);
			// cells without reference follow each other
			const hidden = (await book.sheet(2))!;
			expect(hidden.cells[0]?.map((c) => c && c.t === "n" && c.v)).toEqual([1, 2]);
		});
	}

	test("a worksheet that can't be read: undefined, so the page falls back to the text", async () => {
		const files = {
			"xl/workbook.xml":
				'<workbook><sheets><sheet name="Weg" sheetId="1" r:id="rId1"/><sheet name="Ohne" sheetId="2" r:id="rId9"/><sheet name="Fremd" sheetId="3" r:id="rId3"/></sheets></workbook>',
			"xl/_rels/workbook.xml.rels":
				'<Relationships><Relationship Id="rId1" Type="w" Target="worksheets/gone.xml"/><Relationship Id="rId3" Type="w" Target="worksheets/other.xml"/></Relationships>',
			"xl/worksheets/other.xml": "<styleSheet/>",
		};
		const parts = zipStore(
			Object.entries(files).map(([path, text]) => ({ path, data: enc.encode(text) })),
		);
		const bytes = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
		const book = (await readWorkbook(bytes, () => "General"))!;
		expect(book.sheets.map((s) => s.name)).toEqual(["Weg", "Ohne", "Fremd"]);
		expect(await book.sheet(0)).toBeUndefined(); // the part is missing
		expect(await book.sheet(1)).toBeUndefined(); // no relationship
		expect(await book.sheet(2)).toBeUndefined(); // not a worksheet
	});

	test("not a workbook: undefined", async () => {
		expect(await readWorkbook(enc.encode("hello"), () => "General")).toBeUndefined();
		const zip = zipStore([{ path: "a.txt", data: enc.encode("x") }]);
		const bytes = new Uint8Array(zip.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of zip) {
			bytes.set(p, at);
			at += p.length;
		}
		expect(await readWorkbook(bytes, () => "General")).toBeUndefined();
	});
});
