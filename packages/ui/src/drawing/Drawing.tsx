// Drawings outside the full-screen editor: opening one, and its picture as a block in a text (read
// only: a click opens it full screen to zoom and pan, "Bearbeiten" there to draw).
import { Suspense, lazy, memo, useEffect } from "react";
import type { Repo } from "@obtion/sync";
import type { Item } from "@obtion/core/model";
import { repo as current } from "../repo";
import { files as currentFiles } from "../files";
import { tr, useT } from "../i18n";
import { parseHash } from "../hooks";
import { createStore } from "../lib/store";
import { escapeHtml } from "../ui/text";
import { drawingSvg, forgetDrawingSvg } from "./scene";

const DrawingEditor = lazy(() => import("./DrawingEditor"));

const open = createStore<{ id: string; view: boolean } | null>(null);

/** `view`: to look at (zoom, pan); the editor's "Bearbeiten" switches to drawing. */
export function openDrawing(id: string, opts: { view?: boolean } = {}) {
  open.set({ id, view: !!opts.view });
}

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
      <DrawingEditor key={shown.id} id={shown.id} view={shown.view} onEdit={() => open.set({ ...shown, view: false })} onClose={close} />
    </Suspense>
  );
});

function Loading() {
  const { t } = useT();
  return <div className="fixed inset-0 z-50 grid place-items-center bg-background text-sm text-muted-foreground">{t("drawing.loading")}</div>;
}

/** For texts (the editor and read-only Markdown): filled in by hydrateDrawings. */
export function drawingEmbedHTML(item: Item, size?: number): string {
  return `<figure class="embed-drawing" data-drawing="${escapeHtml(item.id)}" data-v="${item.updated}"${size ? ` style="max-width:${size}px"` : ""}><div class="embed-drawing-svg" role="button" tabindex="0" aria-label="${escapeHtml(tr("drawing.view"))}">${item.drawing?.count ? "" : `<span class="embed-drawing-empty">${escapeHtml(tr("drawing.empty"))}</span>`}</div>${item.title ? `<figcaption>${escapeHtml(item.title)}</figcaption>` : ""}</figure>`;
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
      openDrawing(id, { view: !!repo.get(id)?.drawing?.count });
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
      void drawingSvg(id, repo.getDoc(id), now?.updated ?? item.updated, dark, files).then((svg) => svg && box.replaceChildren(svg));
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
