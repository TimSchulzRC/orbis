// A drawing is an item of its own kind whose content is an Excalidraw scene instead of
// Markdown. It is placed, linked and nested like a note. The scene lives in three maps of its
// document, so edits from two devices merge per element (the newer `version` of an element wins):
//
//   drawing       Y.Map  "elementId@clientId" -> element (Excalidraw's JSON, deleted ones too:
//                        isDeleted). Each device writes its own key: Yjs settles two writes to one key
//                        by client id, not by version, so the copies live side by side and reading
//                        takes the newest (isNewer). A write drops the copies it outdates.
//   drawingFiles  Y.Map  fileId -> { hash, mimeType, created }  (images; the content is a blob)
//   drawingState  Y.Map  name -> value  (the canvas: viewBackgroundColor, gridSize, gridModeEnabled)
//
// Core knows elements only as plain objects; the app hands them to Excalidraw as they are.
import * as Y from "yjs";

export const DRAWING = "drawing";
export const DRAWING_FILES = "drawingFiles";
export const DRAWING_STATE = "drawingState";

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

/** What the rest of the app needs to know about a drawing: search, the mirror, which blobs to keep. */
export interface DrawingInfo {
	/** The text of its text elements and frame names, in drawing order. */
	text: string;
	/** Blob hashes of embedded images. */
	files: string[];
	/** Elements not deleted. */
	count: number;
}

export interface Scene {
	elements: SceneElement[];
	files: Record<string, DrawingFile>;
	state: Record<string, unknown>;
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
function copies(doc: Y.Doc): Map<string, { key: string; el: SceneElement }[]> {
	const out = new Map<string, { key: string; el: SceneElement }[]>();
	for (const [key, v] of doc.getMap<unknown>(DRAWING)) {
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

export function readElements(doc: Y.Doc): SceneElement[] {
	return [...copies(doc).values()].map(newest).sort(byIndex);
}

export function readScene(doc: Y.Doc): Scene {
	const files: Record<string, DrawingFile> = {};
	for (const [id, f] of doc.getMap<DrawingFile>(DRAWING_FILES))
		if (f && typeof f.hash === "string") files[id] = f;
	return { elements: readElements(doc), files, state: doc.getMap<unknown>(DRAWING_STATE).toJSON() };
}

export function drawingInfo(doc: Y.Doc): DrawingInfo {
	const text: string[] = [];
	let count = 0;
	for (const el of readElements(doc)) {
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
	const files = [...doc.getMap<DrawingFile>(DRAWING_FILES).values()]
		.map((f) => f?.hash)
		.filter((h): h is string => typeof h === "string");
	return { text: text.join("\n"), files, count };
}

// Writers: call inside doc.transact.

/**
 * Stores the elements that are newer than the stored ones (see isNewer), so an older copy from a
 * device that has not caught up never wins. Elements missing from `elements` stay: Excalidraw marks
 * removed ones isDeleted instead of dropping them. Returns how many it wrote.
 */
export function writeElements(doc: Y.Doc, elements: readonly SceneElement[]): number {
	const map = doc.getMap<unknown>(DRAWING);
	const stored = copies(doc);
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

export function setDrawingFile(doc: Y.Doc, id: string, file: DrawingFile) {
	const map = doc.getMap<DrawingFile>(DRAWING_FILES);
	if (map.get(id)?.hash !== file.hash) map.set(id, file);
}

/** Only the keys in DRAWING_STATE_KEYS; unchanged values are not written again. True if one changed. */
export function setDrawingState(doc: Y.Doc, state: Record<string, unknown>): boolean {
	const map = doc.getMap<unknown>(DRAWING_STATE);
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
