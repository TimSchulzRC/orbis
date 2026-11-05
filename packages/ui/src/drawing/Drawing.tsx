// Drawings outside the full-screen editor: opening and creating them, the preview on their page
// and in texts (read only: a click opens it full screen to zoom and pan, "Bearbeiten" to draw).
import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState } from "react";
import type { Repo } from "@obtion/sync";
import type { Item, ItemInit } from "@obtion/core/model";
import { repo as current } from "../repo";
import { files as currentFiles } from "../files";
import { itemPath, leavePage, openItem, spaceHref, useFiles, useRepo } from "../hooks";
import { tr, useT } from "../i18n";
import { useTheme } from "../theme";
import { createStore } from "../lib/store";
import { cn } from "../lib/utils";
import { escapeHtml } from "../ui/text";
import { drawingSvg, forgetDrawingSvg } from "./scene";

const DrawingEditor = lazy(() => import("./DrawingEditor"));

interface Open {
  id: string;
  view: boolean;
  /** created for this: closed empty and without a title, it goes again */
  isNew?: boolean;
}
const open = createStore<Open | null>(null);

/** `view`: to look at (zoom, pan); the editor's "Bearbeiten" switches to drawing. */
export function openDrawing(id: string, opts: { view?: boolean; isNew?: boolean } = {}) {
  open.set({ id, view: !!opts.view, isNew: opts.isNew });
}

/** A new drawing, its page and the editor over it. Below `parents`, like "Neu darunter". */
export function createDrawing(init: Omit<ItemInit, "kind"> = {}, repo: Repo = current, space?: string): string {
  const id = repo.create({ ...init, kind: "zeichnung", title: init.title ?? "" });
  openItem(id, { space });
  openDrawing(id, { isNew: true });
  return id;
}

function isBlank(item: Item | undefined, repo: Repo): boolean {
  return !!item && !item.title.trim() && !item.drawing?.count && !item.tags.length && !repo.index().childrenOf(item.id).length && !repo.index().backlinks(item.id).length;
}

/** Called with a drawing's id when its full screen closes: previews held back meanwhile draw then. */
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
    const from = location.hash;
    const onHash = () => location.hash !== from && open.set(null);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [shown?.id]);
  if (!shown) return null;
  const close = () => {
    open.set(null);
    closedListeners.forEach((l) => l(shown.id));
    // discarded like an empty new note, after the editor wrote its last change
    if (shown.isNew)
      setTimeout(() => {
        const item = current.get(shown.id);
        if (isBlank(item, current) && !item!.deleted) {
          current.remove(shown.id);
          if (location.hash.includes(itemPath(shown.id))) leavePage();
        }
      }, 50);
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

/** The drawing as an image; empty, a hint to start drawing. */
export function DrawingPreview({ item, className, onOpen }: { item: Item; className?: string; onOpen: () => void }) {
  const repo = useRepo();
  const files = useFiles();
  const { t } = useT();
  const dark = useTheme().resolved === "dark";
  const doc = useMemo(() => repo.getDoc(item.id), [repo, item.id]);
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "empty" | "shown">(item.drawing?.count ? "loading" : "empty");
  // drawn on full screen: the preview waits until it closes instead of redrawing on every change
  const editing = open.use()?.id === item.id;
  // an image that arrives later (still uploading elsewhere) draws the preview again
  const [blobs, setBlobs] = useState(0);
  useEffect(() => {
    const stop = repo.onBlob((hash) => {
      if (!item.drawing?.files.includes(hash)) return;
      forgetDrawingSvg(item.id);
      setBlobs((n) => n + 1);
    });
    return () => void stop();
  }, [repo, item.drawing?.files.join()]);
  useEffect(() => {
    if (editing) return;
    if (!item.drawing?.count) {
      box.current?.replaceChildren();
      setState("empty");
      return;
    }
    let live = true;
    void drawingSvg(item.id, doc, item.updated, dark, files).then((svg) => {
      if (!live || !box.current) return;
      box.current.replaceChildren(...(svg ? [svg] : []));
      setState(svg ? "shown" : "empty");
    });
    return () => void (live = false);
  }, [item.id, item.updated, dark, doc, files, blobs, editing]);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("drawing-preview group relative block w-full overflow-hidden rounded-xl border border-line bg-surface text-left", state === "shown" ? "cursor-zoom-in" : "cursor-pointer", className)}
      aria-label={t(state === "empty" ? "drawing.start" : "drawing.view")}
    >
      <div ref={box} className="drawing-svg" />
      {state !== "shown" && <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">{state === "empty" ? t("drawing.start") : t("drawing.loading")}</div>}
    </button>
  );
}

/** For texts (the editor and read-only Markdown): filled in by hydrateDrawings. */
export function drawingEmbedHTML(item: Item, size?: number, space?: string): string {
  const href = spaceHref(space, itemPath(item.id));
  return `<figure class="embed-drawing" data-drawing="${escapeHtml(item.id)}" data-v="${item.updated}"${size ? ` style="max-width:${size}px"` : ""}><div class="embed-drawing-svg" role="button" tabindex="0" aria-label="${escapeHtml(tr("drawing.view"))}">${item.drawing?.count ? "" : `<span class="embed-drawing-empty">${escapeHtml(tr("drawing.empty"))}</span>`}</div><figcaption><a href="${href}">${escapeHtml(item.title || tr("drawing.untitled"))}</a></figcaption></figure>`;
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
