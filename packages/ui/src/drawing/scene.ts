// Between a drawing in its note's document and Excalidraw: images, the lazily loaded library and the preview.

import type { BinaryFileData, LibraryItems } from "@excalidraw/excalidraw/types";
import { type DrawingFile, readScene } from "@obtion/core/drawing";
import type * as Y from "yjs";
import type { DeviceFiles } from "../files";
import { KEYS } from "../ui/storage";

/** Excalidraw's code and styles are big, so they load only when a drawing is shown. */
let loading: Promise<typeof import("@excalidraw/excalidraw")> | undefined;
export function loadExcalidraw() {
	// fonts come from this app (copied by the build), so drawings also work offline
	(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH ??= "/excalidraw/";
	loading ??= import("@excalidraw/excalidraw");
	return loading;
}

/** The library belongs to the person, not the drawing: kept on this device like on excalidraw.com. */
export function readLibrary(): LibraryItems {
	try {
		const items = JSON.parse(
			localStorage.getItem(KEYS.drawingLibrary) ?? "null",
		) as LibraryItems | null;
		return Array.isArray(items) ? items : [];
	} catch {
		return [];
	}
}
export function saveLibrary(items: LibraryItems) {
	localStorage.setItem(KEYS.drawingLibrary, JSON.stringify(items));
}

export function blobToDataURL(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(r.result as string);
		r.onerror = () => reject(r.error);
		r.readAsDataURL(blob);
	});
}

export async function dataURLToBlob(url: string): Promise<Blob> {
	return (await fetch(url)).blob();
}

/** Images whose content is on this device or the server; the others stay out (Excalidraw shows a placeholder). */
export async function loadImages(
	entries: Record<string, DrawingFile>,
	files: DeviceFiles,
): Promise<BinaryFileData[]> {
	const out = await Promise.all(
		Object.entries(entries).map(async ([id, f]) => {
			const url = await files.url(f.hash, { keep: true });
			if (!url) return;
			const dataURL = await blobToDataURL(
				new Blob([await (await fetch(url)).blob()], { type: f.mimeType }),
			);
			return { id, mimeType: f.mimeType, dataURL, created: f.created } as BinaryFileData;
		}),
	);
	return out.filter((x): x is BinaryFileData => !!x);
}

const EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/avif": "avif",
	"image/bmp": "bmp",
};
export const imageName = (mime: string) => `drawing-image.${EXT[mime] ?? "bin"}`;

/**
 * The drawing as SVG, the way Excalidraw exports it. Cached per drawing version and theme, so a
 * page full of embeds draws each one once.
 */
const svgs = new Map<string, Promise<SVGSVGElement | null>>();
export function drawingSvg(
	note: string,
	drawing: string,
	doc: Y.Doc,
	version: string,
	dark: boolean,
	files: DeviceFiles,
): Promise<SVGSVGElement | null> {
	const id = `${note}.${drawing}`;
	const key = `${id}:${version}:${dark ? 1 : 0}`;
	let hit = svgs.get(key);
	if (!hit) {
		hit = renderSvg(doc, drawing, dark, files).then(
			({ svg, complete }) => {
				// an image not here yet: drawn again next time
				if (!complete && svgs.get(key) === hit) svgs.delete(key);
				return svg;
			},
			(e) => {
				console.warn("drawing preview failed", e);
				if (svgs.get(key) === hit) svgs.delete(key);
				return null;
			},
		);
		svgs.set(key, hit);
		// keep only the newest version of each drawing
		for (const k of svgs.keys())
			if (k.startsWith(`${id}:`) && !k.startsWith(`${id}:${version}:`)) svgs.delete(k);
	}
	return hit.then((svg) => (svg ? (svg.cloneNode(true) as SVGSVGElement) : null));
}

/** An image arrived: the next drawingSvg draws afresh, also while an earlier render is still running. */
export function forgetDrawingSvg(note: string, drawing: string) {
	for (const k of svgs.keys()) if (k.startsWith(`${note}.${drawing}:`)) svgs.delete(k);
}

async function renderSvg(
	doc: Y.Doc,
	drawing: string,
	dark: boolean,
	files: DeviceFiles,
): Promise<{ svg: SVGSVGElement | null; complete: boolean }> {
	const scene = readScene(doc, drawing);
	const elements = scene.elements.filter((e) => !e.isDeleted);
	if (!elements.length) return { svg: null, complete: true };
	const { exportToSvg } = await loadExcalidraw();
	const wanted = new Set(
		elements.flatMap((e) => (e.type === "image" && typeof e.fileId === "string" ? [e.fileId] : [])),
	);
	const images = wanted.size
		? await loadImages(
				Object.fromEntries(Object.entries(scene.files).filter(([id]) => wanted.has(id))),
				files,
			)
		: [];
	const svg = await exportToSvg({
		elements: elements as never,
		appState: {
			exportBackground: false,
			viewBackgroundColor: (scene.state.viewBackgroundColor as string) ?? "#ffffff",
			exportWithDarkMode: dark,
			exportEmbedScene: false,
		},
		files: Object.fromEntries(images.map((f) => [f.id, f])),
		exportPadding: 16,
	});
	// sized by its block (styles.css)
	svg.removeAttribute("width");
	svg.removeAttribute("height");
	return { svg, complete: images.length >= wanted.size };
}
