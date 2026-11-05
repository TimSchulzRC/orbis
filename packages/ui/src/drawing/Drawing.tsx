// Drawings outside the full-screen editor: opening one, and its picture as a block in a text (a click
// on it opens it full screen to draw).
import { Suspense, lazy, memo, useEffect } from "react";
import type { Repo } from "@obtion/sync";
import type { Item } from "@obtion/core/model";
import { repo as current } from "../repo";
import { files as currentFiles } from "../files";
import { tr, useT } from "../i18n";
import { parseHash } from "../hooks";
import { createStore } from "../lib/store";
import { escapeHtml } from "../ui/text";
import { drawingSvg, forgetDrawingSvg, loadExcalidraw, readLibrary, saveLibrary } from "./scene";
import { onLibraryLink } from "./library-link";
import { notify } from "../ui/feedback";

const DrawingEditor = lazy(() => import("./DrawingEditor"));

const open = createStore<{ id: string } | null>(null);

export function openDrawing(id: string) {
  // keys go to the drawing, not to the note's text the click came from
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  open.set({ id });
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
const isOpen = (id: string) => open.get()?.id === id;

/** Without props, so the app's renders don't reach the editor; it follows only what opens. */
export const DrawingHost = memo(function DrawingHost() {
  const shown = open.use();
  // another page closes it (Back, a link in the drawing)
  useEffect(() => {
    if (!shown) return;
    // the page, not the whole address: the app rewrites that once a page opened (workspace, title)
    const page = () => parseHash().rest.split("?")[0]!.split("/").slice(0, 3).join("/");
    const from = page();
    const onHash = () => page() !== from && open.set(null);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [shown?.id]);
  if (!shown) return null;
  const close = () => {
    open.set(null);
    closedListeners.forEach((l) => l(shown.id));
  };
  return (
    <Suspense fallback={<Loading />}>
      <DrawingEditor key={shown.id} id={shown.id} onClose={close} />
    </Suspense>
  );
});

function Loading() {
  const { t } = useT();
  return <div className="fixed inset-0 z-50 grid place-items-center bg-background text-sm text-muted-foreground">{t("drawing.loading")}</div>;
}

/** For texts (the editor and read-only Markdown): filled in by hydrateDrawings. */
export function drawingEmbedHTML(item: Item): string {
  return `<figure class="embed-drawing" data-drawing="${escapeHtml(item.id)}" data-v="${item.updated}"><div class="embed-drawing-svg" role="button" tabindex="0" aria-label="${escapeHtml(tr("drawing.edit"))}">${item.drawing?.count ? "" : `<span class="embed-drawing-empty">${escapeHtml(tr("drawing.empty"))}</span>`}</div></figure>`;
}

/** Draws the drawings embedded in `root`; a click on one opens it to look at. */
export function hydrateDrawings(root: HTMLElement, repo: Repo = current, files = currentFiles) {
  const dark = document.documentElement.dataset.theme === "dark";
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
      void drawingSvg(id, repo.getDoc(id), now?.updated ?? item.updated, dark, files).then((svg) => {
        if (!svg) return;
        // full width; the height follows the drawing's proportions within the block's limits (styles.css)
        const [, , w, h] = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
        if (w && h) box.style.aspectRatio = `${w} / ${h}`;
        box.replaceChildren(svg);
      });
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
