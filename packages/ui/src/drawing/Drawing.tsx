// Drawings outside the full-screen editor: opening one, and its picture as a block in a note's text (a
// click on it opens it full screen to draw). An open drawing is a step in the browser's history
// ("?d=<note>.<drawing>" on the page's address, "@<workspace>" when the note is of another one than
// the open workspace): Back closes it, Forward opens it again.

import type { DrawingInfo } from "@obtion/core/drawing";
import type { Repo } from "@obtion/sync";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { replica, spaceById } from "../accounts";
import { files as currentFiles } from "../files";
import { setParams, useRoute } from "../hooks";
import { tr, useT } from "../i18n";
import { repo as current } from "../repo";
import { ScopeContext } from "../scope";
import { notify } from "../ui/feedback";
import { escapeHtml } from "../ui/text";
import { onLibraryLink } from "./library-link";
import { getLiveLibrary } from "./live-library";
import { drawingSvg, forgetDrawingSvg, loadExcalidraw, readLibrary, saveLibrary } from "./scene";

/**
 * The editor's code, fetched ahead (a note with a drawing shows, the pointer is on one) so opening
 * waits for nothing. No Suspense: React would hold its placeholder for at least 300 ms.
 */
type EditorModule = typeof import("./DrawingEditor");
let editorModule: Promise<EditorModule> | undefined;
let Editor: EditorModule["default"] | null = null;
export function loadEditor(): Promise<EditorModule> {
	editorModule ??= import("./DrawingEditor").then(
		(m) => {
			Editor = m.default;
			return m;
		},
		(e) => {
			editorModule = undefined;
			throw e;
		},
	);
	return editorModule;
}

// fetching ahead may fail quietly: opening the drawing tries again and reports it
const ignoreLoadError = () => undefined;

const OPEN = "d";
const openId = () => new URLSearchParams(location.hash.split("?")[1] ?? "").get(OPEN);

/** A drawing is known by its note, its id within that note and the note's workspace. */
const key = (note: string, id: string, space?: string) =>
	`${note}.${id}${space ? `@${space}` : ""}`;
function parseKey(raw: string | null): { note: string; id: string; space?: string } | null {
	const [k, space] = raw?.split("@") ?? [];
	const [note, id] = k?.split(".") ?? [];
	return note && id ? { note, id, space: space || undefined } : null;
}

export function openDrawing(note: string, drawing: string, space?: string) {
	const id = key(note, drawing, space);
	// keys go to the drawing, not to the note's text the click came from
	if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	void loadEditor().catch(ignoreLoadError);
	const [path, qs] = location.hash.replace(/^#/, "").split("?");
	const query = new URLSearchParams(qs ?? "");
	query.set(OPEN, id);
	location.hash = `${path}?${query}`;
	// opened from here: closing is going Back (a link or a reload opened it: the note replaces it)
	history.replaceState({ ...history.state, drawing: id }, "");
}

function closeDrawing() {
	const id = openId();
	if (id && history.state?.drawing === id) history.back();
	else setParams({ [OPEN]: null });
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
		const liveLibrary = getLiveLibrary();
		if (liveLibrary) {
			await liveLibrary(blob);
			return;
		}
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
	const open = parseKey(id);
	const [, loaded] = useState(0);
	useEffect(() => {
		if (id && !Editor)
			loadEditor().then(
				() => loaded((n) => n + 1),
				(e) => {
					console.warn("drawing editor not loaded", e);
					closeDrawing();
				},
			);
	}, [id]);
	const shown = useRef<string | null>(null);
	useEffect(() => {
		const was = shown.current;
		shown.current = id;
		if (was && was !== id) for (const l of closedListeners) l(was);
	}, [id]);
	// the note's workspace, which need not be the open one (the inbox, the review); one no longer
	// on this device shows nothing
	const gone = !!open?.space && !spaceById(open.space);
	const scope = useMemo(
		() => (open?.space && !gone ? { id: open.space, ...replica(open.space) } : null),
		[open?.space, gone],
	);
	// before its replica has read this device's data, the note's document would start out empty
	const repo = scope?.repo ?? current;
	const ready = useSyncExternalStore(repo.subscribe, () => repo.status.loaded);
	if (!open || gone) return null;
	if (!Editor || !ready) return <Loading />;
	const editor = <Editor id={open.id} key={id} note={open.note} onClose={closeDrawing} />;
	return scope ? <ScopeContext.Provider value={scope}>{editor}</ScopeContext.Provider> : editor;
});

function Loading() {
	const { t } = useT();
	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-background text-sm text-muted-foreground">
			{t("drawing.loading")}
		</div>
	);
}

/** The block of a drawing in a note's text (the editor and read-only Markdown): filled in by hydrateDrawings. */
export function drawingEmbedHTML(
	note: string,
	id: string,
	info: DrawingInfo | undefined,
	space?: string,
): string {
	return `<figure class="embed-drawing"${space ? ` data-space="${escapeHtml(space)}"` : ""} data-note="${escapeHtml(note)}" data-drawing="${escapeHtml(id)}" data-v="${escapeHtml(info?.version ?? "")}"><div class="embed-drawing-svg" role="button" tabindex="0" aria-label="${escapeHtml(tr("drawing.edit"))}" title="${escapeHtml(tr("drawing.edit"))}">${info?.count ? "" : `<span class="embed-drawing-empty">${escapeHtml(tr("drawing.empty"))}</span>`}</div></figure>`;
}

/** Draws the drawings embedded in `root`; a click on one opens it to look at. */
export function hydrateDrawings(root: HTMLElement, repo: Repo = current, files = currentFiles) {
	const dark = document.documentElement.dataset.theme === "dark";
	// a drawing on the page: its editor is fetched while nothing else happens, so a tap opens it at once
	if (!editorModule && root.querySelector("[data-drawing]")) {
		const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200));
		idle(() => void loadEditor().catch(ignoreLoadError), { timeout: 3000 });
	}
	for (const fig of root.querySelectorAll<HTMLElement>("[data-drawing]"))
		hydrateDrawing(fig, repo, files, dark);
}

function hydrateDrawing(
	fig: HTMLElement,
	given: Repo,
	givenFiles: typeof currentFiles,
	dark: boolean,
) {
	if (fig.dataset.drawn) return;
	fig.dataset.drawn = "1";
	const space = fig.dataset.space;
	const { repo, files } = space ? replica(space) : { repo: given, files: givenFiles };
	const note = fig.dataset.note!;
	const id = key(note, fig.dataset.drawing!, space);
	const infoOf = () => repo.get(note)?.drawings?.[fig.dataset.drawing!];
	const info = infoOf();
	const box = fig.querySelector<HTMLElement>(".embed-drawing-svg")!;
	const show = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
		openDrawing(note, fig.dataset.drawing!, space);
	};
	box.addEventListener("click", show);
	box.addEventListener("pointerenter", () => void loadEditor().catch(ignoreLoadError), {
		once: true,
	});
	box.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && show(e));
	if (!info?.count) return;
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
		const version = infoOf()?.version ?? info.version;
		void drawingSvg(note, fig.dataset.drawing!, repo.getDoc(note), version, dark, files).then(
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
	if (!info.files.length) return;
	// an image still uploading elsewhere: drawn again once it is here; a removed block stops listening
	const stop = repo.onBlob((hash) => {
		if (!fig.isConnected) return void stop();
		if (!(infoOf() ?? info).files.includes(hash)) return;
		forgetDrawingSvg(note, fig.dataset.drawing!);
		draw();
	});
}
