// Small files made in the test: ZIPs, Office documents, a PDF with an embedded invoice XML.
// Only what the text extraction reads; real programs write more parts.
import { deflateRawSync } from "node:zlib";

const enc = new TextEncoder();

/** A ZIP with the given entries (deflated). */
export function zip(entries: Record<string, string | Uint8Array>): Uint8Array {
	const locals: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(entries)) {
		const data = typeof content === "string" ? enc.encode(content) : content;
		const packed = new Uint8Array(deflateRawSync(data));
		const n = enc.encode(name);
		const crc = Bun.hash.crc32(data);
		const local = new Uint8Array(30 + n.length);
		const l = new DataView(local.buffer);
		l.setUint32(0, 0x04034b50, true);
		l.setUint16(4, 20, true);
		l.setUint16(6, 0x800, true);
		l.setUint16(8, 8, true);
		l.setUint32(14, crc, true);
		l.setUint32(18, packed.length, true);
		l.setUint32(22, data.length, true);
		l.setUint16(26, n.length, true);
		local.set(n, 30);
		const cd = new Uint8Array(46 + n.length);
		const c = new DataView(cd.buffer);
		c.setUint32(0, 0x02014b50, true);
		c.setUint16(4, 20, true);
		c.setUint16(6, 20, true);
		c.setUint16(8, 0x800, true);
		c.setUint16(10, 8, true);
		c.setUint32(16, crc, true);
		c.setUint32(20, packed.length, true);
		c.setUint32(24, data.length, true);
		c.setUint16(28, n.length, true);
		c.setUint32(42, offset, true);
		cd.set(n, 46);
		locals.push(local, packed);
		central.push(cd);
		offset += local.length + packed.length;
	}
	const cdSize = central.reduce((a, b) => a + b.length, 0);
	const end = new Uint8Array(22);
	const e = new DataView(end.buffer);
	e.setUint32(0, 0x06054b50, true);
	e.setUint16(8, central.length, true);
	e.setUint16(10, central.length, true);
	e.setUint32(12, cdSize, true);
	e.setUint32(16, offset, true);
	return concat([...locals, ...central, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
	let p = 0;
	for (const x of parts) out.set(x, p), (p += x.length);
	return out;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

/** A Word document: paragraphs, then a table (rows of cells). */
export function docx(paragraphs: string[], table: string[][] = []): Uint8Array {
	const rows = table
		.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/>${para(c)}</w:tc>`).join("")}</w:tr>`)
		.join("");
	const body = paragraphs.map(para).join("") + (rows ? `<w:tbl>${rows}</w:tbl>` : "");
	return zip({
		"[Content_Types].xml":
			'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
	});
}

/** An Excel workbook: sheets by name, rows of cells; text goes to the shared strings, numbers stay inline. */
export function xlsx(sheets: Record<string, (string | number)[][]>): Uint8Array {
	const strings: string[] = [];
	const si = (s: string) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1);
	const col = (i: number) => String.fromCharCode(65 + i);
	const parts: Record<string, string> = {};
	const names = Object.keys(sheets);
	names.forEach((name, n) => {
		const rows = sheets[name]!.map(
			(r, y) =>
				`<row r="${y + 1}">${r.map((v, x) => (v === "" ? "" : typeof v === "number" ? `<c r="${col(x)}${y + 1}"><v>${v}</v></c>` : `<c r="${col(x)}${y + 1}" t="s"><v>${si(v)}</v></c>`)).join("")}</row>`,
		).join("");
		parts[`xl/worksheets/sheet${n + 1}.xml`] =
			`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
	});
	return zip({
		"[Content_Types].xml": "<Types/>",
		"xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
		"xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
		...parts,
	});
}

/** A PowerPoint deck: each slide a list of text lines. */
export function pptx(slides: string[][]): Uint8Array {
	const parts: Record<string, string> = {};
	slides.forEach((lines, i) => {
		parts[`ppt/slides/slide${i + 1}.xml`] =
			`<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
	});
	return zip({
		"[Content_Types].xml": "<Types/>",
		"ppt/presentation.xml": "<p:presentation/>",
		...parts,
	});
}

/** A one-page PDF with the text `pageText` and `xml` embedded as `name` (as Factur-X does it). */
export function pdfWithEmbedded(pageText: string, name: string, xml: string): Uint8Array {
	const stream = `BT /F1 12 Tf 72 720 Td (${pageText}) Tj ET`;
	const objs = [
		`<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(${name}) 6 0 R] >> >> /AF [6 0 R] >>`,
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Type /Filespec /F (${name}) /UF (${name}) /AFRelationship /Data /EF << /F 7 0 R >> >>`,
		`<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${enc.encode(xml).length} >>\nstream\n${xml}\nendstream`,
	];
	let out = "%PDF-1.7\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(enc.encode(out).length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = enc.encode(out).length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return enc.encode(out);
}
