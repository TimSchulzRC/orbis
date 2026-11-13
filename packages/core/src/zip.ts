// Several files as one ZIP to save: which files, under which names, and the archive's bytes.
// Stored, not compressed: PDFs, images and Office files are compressed already. No ZIP64, so an
// archive stays under ZIP_MAX_BYTES and ZIP_MAX_ENTRIES (fitsZip).

import type { Index } from "./graph";
import type { Item } from "./model";

export const ZIP_MAX_BYTES = 1024 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 10_000;

/** A file for the archive: the item and the folders it lies in there. */
export interface ArchiveFile {
	item: Item;
	folders: string[];
}

/**
 * Every file below `id`, at any depth, with the titles on the way down as its folders. A file
 * with several places below `id` comes once, at its home if that lies below `id`.
 */
export function filesBelow(id: string, ix: Index): ArchiveFile[] {
	const out = new Map<string, ArchiveFile>();
	const seen = new Set([id]);
	const walk = (parent: string, folders: string[]) => {
		for (const child of ix.items(ix.childrenOf(parent))) {
			if (child.deleted) continue;
			if (child.kind === "file") {
				if (!child.file?.hash) continue; // no content yet
				if (!out.has(child.id) || ix.home(child.id) === parent)
					out.set(child.id, { item: child, folders });
			} else if (!seen.has(child.id)) {
				seen.add(child.id);
				walk(child.id, [...folders, child.title]);
			}
		}
	};
	walk(id, []);
	return [...out.values()];
}

/** The files among `items`, without folders: what a list shows. */
export function filesAmong(items: Item[]): ArchiveFile[] {
	return items
		.filter((x) => x.kind === "file" && x.file?.hash && !x.deleted)
		.map((item) => ({ item, folders: [] }));
}

/** May these files go into one archive? */
export function fitsZip(files: ArchiveFile[]): boolean {
	return (
		files.length <= ZIP_MAX_ENTRIES &&
		files.reduce((n, f) => n + (f.item.file?.size ?? 0), 0) <= ZIP_MAX_BYTES
	);
}

/** A name every system can write: no path or control characters, no dots or spaces at the end. */
export function safeName(name: string, fallback = "_"): string {
	const cleaned = name
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
		.replace(/[. ]+$/, "")
		.trim();
	return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

/**
 * The path of each file in the archive, in the order given. Two files with the same path (upper
 * and lower case count as the same) are told apart by a number before the extension.
 */
export function archivePaths(files: ArchiveFile[]): string[] {
	const taken = new Set<string>();
	return files.map(({ item, folders }) => {
		const dir = folders.map((f) => `${safeName(f)}/`).join("");
		const name = safeName(item.file?.name || item.title, "file");
		let path = dir + name;
		for (let n = 2; taken.has(path.toLowerCase()); n++)
			path = dir + name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
		taken.add(path.toLowerCase());
		return path;
	});
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
	path: string;
	data: Uint8Array;
	/** When the file was last changed (ms); the archive keeps it in local time. */
	modified?: number;
}

/** MS-DOS date and time, as ZIP keeps them: local time, two-second steps, from 1980. */
function dosTime(ms: number): { date: number; time: number } {
	const d = new Date(ms);
	const year = Math.max(1980, Math.min(2107, d.getFullYear()));
	return {
		date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
		time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
	};
}

/**
 * A ZIP archive of the entries, as the parts of one file (for `new Blob(parts)`): the contents
 * are passed through, not copied.
 */
export function zipStore(entries: ZipEntry[]): Uint8Array[] {
	const parts: Uint8Array[] = [];
	const directory: Uint8Array[] = [];
	const encoder = new TextEncoder();
	let offset = 0;
	for (const e of entries) {
		const name = encoder.encode(e.path);
		const crc = crc32(e.data);
		const { date, time } = dosTime(e.modified ?? Date.now());
		// what the local header and the directory entry share, from "version needed" on
		const shared = new DataView(new ArrayBuffer(26));
		shared.setUint16(0, 20, true); // version needed: 2.0
		shared.setUint16(2, 0x0800, true); // names are UTF-8
		shared.setUint16(4, 0, true); // stored
		shared.setUint16(6, time, true);
		shared.setUint16(8, date, true);
		shared.setUint32(10, crc, true);
		shared.setUint32(14, e.data.length, true);
		shared.setUint32(18, e.data.length, true);
		shared.setUint16(22, name.length, true);
		shared.setUint16(24, 0, true); // no extra field
		const common = new Uint8Array(shared.buffer);

		const local = new Uint8Array(30 + name.length);
		new DataView(local.buffer).setUint32(0, 0x04034b50, true);
		local.set(common, 4);
		local.set(name, 30);
		parts.push(local, e.data);

		const central = new Uint8Array(46 + name.length);
		const c = new DataView(central.buffer);
		c.setUint32(0, 0x02014b50, true);
		c.setUint16(4, 20, true); // made by: 2.0
		central.set(common, 6);
		c.setUint32(42, offset, true); // comment, disk, attributes stay 0
		central.set(name, 46);
		directory.push(central);

		offset += local.length + e.data.length;
	}
	const size = directory.reduce((n, d) => n + d.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, size, true);
	end.setUint32(16, offset, true);
	return [...parts, ...directory, new Uint8Array(end.buffer)];
}
