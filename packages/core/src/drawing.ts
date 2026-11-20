// A drawing is a block of a note, like a query block: in the note's text it is a fence that names
// it, its content is an Excalidraw scene kept in the same document:
//
//   ```excalidraw
//   <drawing id>
//   ```
//
//   drawings  Y.Map  drawingId -> Y.Map
//     elements  Y.Map  "elementId@clientId" -> element (Excalidraw's JSON, deleted ones too:
//                      isDeleted). Each device writes its own key: Yjs settles two writes to one key
//                      by client id, not by version, so the copies live side by side and reading
//                      takes the newest (isNewer). A write drops the copies it outdates.
//     files     Y.Map  fileId -> { hash, mimeType, created }  (images; the content is a blob)
//     state     Y.Map  name -> value  (the canvas: viewBackgroundColor, gridSize, gridModeEnabled)
//
// So edits from two devices merge per element (the newer `version` of an element wins). A scene
// whose fence left the text stays in the document: undo brings the block back with it.
//
// Core knows elements only as plain objects; the app hands them to Excalidraw as they are.
import * as Y from "yjs";

export const DRAWINGS = "drawings";

/** The fence's info string. */
export const DRAWING_INFO = "excalidraw";

/** The canvas settings kept with the drawing; everything else of Excalidraw's state stays on the device. */
export const DRAWING_STATE_KEYS = [
	"viewBackgroundColor",
	"gridSize",
	"gridStep",
	"gridModeEnabled",
] as const;

export interface SceneElement {
	id: string;
	type: string;
	version: number;
	versionNonce: number;
	index?: string | null;
	isDeleted?: boolean;
	[key: string]: unknown;
}

export interface DrawingFile {
	hash: string;
	mimeType: string;
	created: number;
}

/** What the rest of the app needs to know about one drawing: search, the mirror, which blobs to keep. */
export interface DrawingInfo {
	/** The text of its text elements and frame names, in drawing order. */
	text: string;
	/** Blob hashes of embedded images. */
	files: string[];
	/** Elements not deleted. */
	count: number;
	/** Changes whenever what the drawing shows changes: a preview drawn for it stays valid until then. */
	version: string;
}

export interface Scene {
	elements: SceneElement[];
	files: Record<string, DrawingFile>;
	state: Record<string, unknown>;
}

// ---- the block in the text ----

/** ```excalidraw, the id on the next line, the closing fence. */
const FENCE = /^```excalidraw[ \t]*\n[ \t]*([A-Za-z0-9_-]+)[ \t]*\n```[ \t]*$/gm;

export interface DrawingBlock {
	from: number;
	to: number;
	id: string;
}

/** The drawing blocks of a text, in text order. */
export function findDrawings(body: string): DrawingBlock[] {
	if (!body.includes("```excalidraw")) return [];
	return [...body.matchAll(FENCE)].map((m) => ({
		from: m.index!,
		to: m.index! + m[0].length,
		id: m[1]!,
	}));
}

export function drawingFence(id: string): string {
	return `\`\`\`${DRAWING_INFO}\n${id}\n\`\`\``;
}

/** Replaces each drawing block of the text with what `fn` returns for it. */
export function replaceDrawings(body: string, fn: (b: DrawingBlock) => string): string {
	const blocks = findDrawings(body);
	if (!blocks.length) return body;
	let out = "";
	let pos = 0;
	for (const b of blocks) {
		out += body.slice(pos, b.from) + fn(b);
		pos = b.to;
	}
	return out + body.slice(pos);
}

// ---- the scene in the document ----

interface Maps {
	elements: Y.Map<unknown>;
	files: Y.Map<DrawingFile>;
	state: Y.Map<unknown>;
}

/** The drawing's maps; `create` (writers only) adds them when the drawing is new. */
export function drawingMaps(doc: Y.Doc, id: string, create = false): Maps | undefined {
	const all = doc.getMap<unknown>(DRAWINGS);
	let d = all.get(id);
	if (!(d instanceof Y.Map)) {
		if (!create) return undefined;
		d = new Y.Map<unknown>();
		all.set(id, d);
	}
	const map = d as Y.Map<unknown>;
	const sub = <T>(name: string) => {
		const m = map.get(name);
		if (m instanceof Y.Map) return m as Y.Map<T>;
		if (!create) return;
		const fresh = new Y.Map<T>();
		map.set(name, fresh);
		return fresh;
	};
	const elements = sub<unknown>("elements");
	const files = sub<DrawingFile>("files");
	const state = sub<unknown>("state");
	// all three come in one transaction (addDrawing), so a missing one means a malformed document
	return elements && files && state ? { elements, files, state } : undefined;
}

/** Starts an empty drawing in the note; call inside doc.transact, then put drawingFence(id) into the text. */
export function addDrawing(doc: Y.Doc, id: string) {
	drawingMaps(doc, id, true);
}

function isElement(v: unknown): v is SceneElement {
	return (
		!!v &&
		typeof v === "object" &&
		typeof (v as SceneElement).id === "string" &&
		typeof (v as SceneElement).type === "string"
	);
}

/** Excalidraw's order: by fractional index, then by id so every device sorts the same. */
export function byIndex(a: SceneElement, b: SceneElement): number {
	const x = a.index ?? "";
	const y = b.index ?? "";
	return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every stored copy of each element, by element id. */
function copies(map: Y.Map<unknown>): Map<string, { key: string; el: SceneElement }[]> {
	const out = new Map<string, { key: string; el: SceneElement }[]>();
	for (const [key, v] of map) {
		const el = v instanceof Y.AbstractType ? v.toJSON() : v;
		if (!isElement(el)) continue;
		const list = out.get(el.id);
		if (list) list.push({ key, el });
		else out.set(el.id, [{ key, el }]);
	}
	return out;
}

const newest = (list: { el: SceneElement }[]) =>
	list.reduce((a, b) => (isNewer(b.el, a.el) ? b : a)).el;

function elementsOf(map: Y.Map<unknown>): SceneElement[] {
	return [...copies(map).values()].map(newest).sort(byIndex);
}

export function readElements(doc: Y.Doc, id: string): SceneElement[] {
	const maps = drawingMaps(doc, id);
	return maps ? elementsOf(maps.elements) : [];
}

function filesOf(map: Y.Map<DrawingFile>): Record<string, DrawingFile> {
	const files: Record<string, DrawingFile> = {};
	for (const [fid, f] of map) if (f && typeof f.hash === "string") files[fid] = f;
	return files;
}

export function readScene(doc: Y.Doc, id: string): Scene {
	const maps = drawingMaps(doc, id);
	if (!maps) return { elements: [], files: {}, state: {} };
	return {
		elements: elementsOf(maps.elements),
		files: filesOf(maps.files),
		state: maps.state.toJSON(),
	};
}

/** The drawings kept in a note, by id; undefined when it has none. */
export function drawingsInfo(doc: Y.Doc): Record<string, DrawingInfo> | undefined {
	const all = doc.getMap<unknown>(DRAWINGS);
	if (!all.size) return undefined;
	const out: Record<string, DrawingInfo> = {};
	for (const id of all.keys()) {
		const maps = drawingMaps(doc, id);
		if (maps) out[id] = info(maps);
	}
	return out;
}

function info(maps: Maps): DrawingInfo {
	const text: string[] = [];
	let count = 0;
	let versions = 0;
	for (const el of elementsOf(maps.elements)) {
		versions += el.version;
		if (el.isDeleted) continue;
		count++;
		const t =
			el.type === "text"
				? (el.originalText ?? el.text)
				: el.type === "frame" || el.type === "magicframe"
					? el.name
					: undefined;
		if (typeof t === "string" && t.trim()) text.push(t.trim());
	}
	const files = Object.values(filesOf(maps.files)).map((f) => f.hash);
	const state = maps.state.toJSON();
	return {
		text: text.join("\n"),
		files,
		count,
		version: `${versions}:${files.length}:${JSON.stringify(state)}`,
	};
}

/** Blob hashes of the images in all of a note's drawings. */
export function drawingImages(drawings: Record<string, DrawingInfo> | undefined): string[] {
	return drawings ? Object.values(drawings).flatMap((d) => d.files) : [];
}

// Writers: call inside doc.transact.

/**
 * Stores the elements that are newer than the stored ones (see isNewer), so an older copy from a
 * device that has not caught up never wins. Elements missing from `elements` stay: Excalidraw marks
 * removed ones isDeleted instead of dropping them. Returns how many it wrote.
 */
export function writeElements(doc: Y.Doc, id: string, elements: readonly SceneElement[]): number {
	const map = drawingMaps(doc, id, true)!.elements;
	const stored = copies(map);
	const own = `@${doc.clientID}`;
	let n = 0;
	for (const el of elements) {
		const list = stored.get(el.id) ?? [];
		if (list.length && !isNewer(el, newest(list))) continue;
		// only plain JSON goes into the document; the copies this one outdates go
		map.set(el.id + own, JSON.parse(JSON.stringify(el)));
		for (const c of list) if (c.key !== el.id + own) map.delete(c.key);
		n++;
	}
	return n;
}

export function setDrawingFile(doc: Y.Doc, id: string, fileId: string, file: DrawingFile) {
	const map = drawingMaps(doc, id, true)!.files;
	if (map.get(fileId)?.hash !== file.hash) map.set(fileId, file);
}

/** Only the keys in DRAWING_STATE_KEYS; unchanged values are not written again. True if one changed. */
export function setDrawingState(doc: Y.Doc, id: string, state: Record<string, unknown>): boolean {
	const map = drawingMaps(doc, id, true)!.state;
	let changed = false;
	for (const k of DRAWING_STATE_KEYS) {
		const v = state[k];
		if (v === undefined) continue;
		if (JSON.stringify(map.get(k)) === JSON.stringify(v)) continue;
		map.set(k, v === null ? null : JSON.parse(JSON.stringify(v)));
		changed = true;
	}
	return changed;
}

/** Is a version of `remote` newer than `local`? Excalidraw's rule: higher version, on a tie the lower nonce. */
export function isNewer(remote: SceneElement, local: SceneElement | undefined): boolean {
	if (!local) return true;
	return (
		remote.version > local.version ||
		(remote.version === local.version && remote.versionNonce < local.versionNonce)
	);
}

/** The scene as an .excalidraw file (images left out: they are blobs of their own). */
export function excalidrawFile(scene: Scene): string {
	return JSON.stringify(
		{
			type: "excalidraw",
			version: 2,
			source: "obtion",
			elements: scene.elements.filter((e) => !e.isDeleted),
			appState: { viewBackgroundColor: "#ffffff", ...scene.state },
			files: {},
		},
		null,
		2,
	);
}
