// Drawings outside the full-screen editor: opening one, and its picture as a block in a text (a click
// on it opens it full screen to draw). An open drawing is a step in the browser's history ("?d=<id>"
// on the note's address): Back closes it, Forward opens it again.

import type { Item } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { memo, useEffect, useRef, useState } from "react";
import { files as currentFiles } from "../files";
import { setParams, useRoute } from "../hooks";
import { tr, useT } from "../i18n";
import { repo as current } from "../repo";
import { notify } from "../ui/feedback";
import { escapeHtml } from "../ui/text";
import { onLibraryLink } from "./library-link";
import { drawingSvg, forgetDrawingSvg, loadExcalidraw, readLibrary, saveLibrary } from "./scene";

/**
 * The editor's code, fetched ahead (a note with a drawing shows, the pointer is on one) so opening
 * waits for nothing. No Suspense: React would hold its placeholder for at least 300 ms.
 */
type EditorModule = typeof import("./DrawingEditor");
let editorModule: Promise<EditorModule> | undefined;
let Editor: EditorModule["default"] | null = null;
export function loadEditor(): Promise<EditorModule> {
	return (editorModule ??= import("./DrawingEditor").then(
		(m) => ((Editor = m.default), m),
		(e) => {
			editorModule = undefined;
			throw e;
		},
	));
}

const OPEN = "d";
const openId = () => new URLSearchParams(location.hash.split("?")[1] ?? "").get(OPEN);

export function openDrawing(id: string) {
	// keys go to the drawing, not to the note's text the click came from
	if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	void loadEditor().catch(() => {});
	const [path, qs] = location.hash.replace(/^#/, "").split("?");
	const query = new URLSearchParams(qs ?? "");
	query.set(OPEN, id);
	location.hash = path + "?" + query;
	// opened from here: closing is going Back (a link or a reload opened it: the note replaces it)
	history.replaceState({ ...history.state, drawing: id }, "");
}

function closeDrawing() {
	const id = openId();
	if (id && history.state?.drawing === id) history.back();
	else setParams({ [OPEN]: null });
}

/** The open drawing takes a library itself (it shows it at once); returns the way to let go. */
let liveLibrary: ((blob: Blob) => Promise<void>) | null = null;
export function setLiveLibrary(fn: (blob: Blob) => Promise<void>) {
	liveLibrary = fn;
	return () => void (liveLibrary === fn && (liveLibrary = null));
}

/** Only libraries from Excalidraw's own collection come in this way. */
function libraryUrl(raw: string): URL | null {
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && url.hostname === "libraries.excalidraw.com" ? url : null;
	} catch {
		return null;
	}
}

onLibraryLink(async (raw) => {
	const url = libraryUrl(raw);
	if (!url) return notify(tr("drawing.libraryFailed"));
	try {
		const blob = await (await fetch(url)).blob();
		if (liveLibrary) return void (await liveLibrary(blob));
		// no drawing open (the link came to a tab of its own): into the library for the next one
		const { loadLibraryFromBlob, mergeLibraryItems } = await loadExcalidraw();
		saveLibrary(mergeLibraryItems(readLibrary(), await loadLibraryFromBlob(blob, "published")));
		notify(tr("drawing.libraryAdded"));
	} catch (e) {
		console.warn("library not added", e);
		notify(tr("drawing.libraryFailed"));
	}
});

/** Called with a drawing's id when its full screen closes: pictures held back meanwhile draw then. */
const closedListeners = new Set<(id: string) => void>();
function onDrawingClosed(fn: (id: string) => void) {
	closedListeners.add(fn);
	return () => void closedListeners.delete(fn);
}
const isOpen = (id: string) => openId() === id;

/** Shows the drawing the address names; the editor itself renders only when that changes. */
export const DrawingHost = memo(function DrawingHost() {
	const id = useRoute().query.get(OPEN);
	const [, loaded] = useState(0);
	useEffect(() => {
		if (id && !Editor)
			loadEditor().then(
				() => loaded((n) => n + 1),
				(e) => (console.warn("drawing editor not loaded", e), closeDrawing()),
			);
	}, [id]);
	const shown = useRef<string | null>(null);
	useEffect(() => {
		const was = shown.current;
		shown.current = id;
		if (was && was !== id) closedListeners.forEach((l) => l(was));
	}, [id]);
	if (!id) return null;
	if (!Editor) return <Loading />;
	return <Editor id={id} key={id} onClose={closeDrawing} />;
});

function Loading() {
	const { t } = useT();
	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-background text-sm text-muted-foreground">
			{t("drawing.loading")}
		</div>
	);
}

/** For texts (the editor and read-only Markdown): filled in by hydrateDrawings. */
export function drawingEmbedHTML(item: Item): string {
	return `<figure class="embed-drawing" data-drawing="${escapeHtml(item.id)}" data-v="${item.updated}"><div class="embed-drawing-svg" role="button" tabindex="0" aria-label="${escapeHtml(tr("drawing.edit"))}" title="${escapeHtml(tr("drawing.edit"))}">${item.drawing?.count ? "" : `<span class="embed-drawing-empty">${escapeHtml(tr("drawing.empty"))}</span>`}</div></figure>`;
}

/** Draws the drawings embedded in `root`; a click on one opens it to look at. */
export function hydrateDrawings(root: HTMLElement, repo: Repo = current, files = currentFiles) {
	const dark = document.documentElement.dataset.theme === "dark";
	// a drawing on the page: its editor is fetched while nothing else happens, so a tap opens it at once
	if (!editorModule && root.querySelector("[data-drawing]")) {
		const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200));
		idle(() => void loadEditor().catch(() => {}), { timeout: 3000 });
	}
	root.querySelectorAll<HTMLElement>("[data-drawing]").forEach((fig) => {
		if (fig.dataset.drawn) return;
		fig.dataset.drawn = "1";
		const id = fig.dataset.drawing!;
		const item = repo.get(id);
		const box = fig.querySelector<HTMLElement>(".embed-drawing-svg")!;
		const show = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			openDrawing(id);
		};
		box.addEventListener("click", show);
		box.addEventListener("pointerenter", () => void loadEditor().catch(() => {}), { once: true });
		box.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && show(e));
		if (!item?.drawing?.count) return;
		let waiting = false;
		const draw = (): void => {
			// drawn on full screen right now: once it closes, with what it has then
			if (isOpen(id)) {
				if (waiting) return;
				waiting = true;
				const stop = onDrawingClosed((closed) => {
					if (closed !== id) return;
					stop();
					waiting = false;
					if (fig.isConnected) draw();
				});
				return;
			}
			const now = repo.get(id);
			void drawingSvg(id, repo.getDoc(id), now?.updated ?? item.updated, dark, files).then(
				(svg) => {
					if (!svg) return;
					// full width; the height follows the drawing's proportions within the block's limits (styles.css)
					const [, , w, h] = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
					if (w && h) box.style.aspectRatio = `${w} / ${h}`;
					box.replaceChildren(svg);
				},
			);
		};
		draw();
		if (!item.drawing.files.length) return;
		// an image still uploading elsewhere: drawn again once it is here; a removed embed stops listening
		const stop = repo.onBlob((hash) => {
			if (!fig.isConnected) return void stop();
			if (!item.drawing!.files.includes(hash)) return;
			forgetDrawingSvg(id);
			draw();
		});
	});
}
