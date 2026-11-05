// A note as a card: the inbox's entry and the quick note. Its text is the page's editor, read-only
// until edited, so queries, embeds and links look as on the note's page. The card keeps the height
// it is given; a long note scrolls inside.
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Check, Maximize2, Pencil } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { belowOf } from "@obtion/core/placement";
import { plainText } from "@obtion/core/search";
import { useItemHref, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { useBlobUrl } from "../files";
import { Button, Kbd } from "./primitives";
import { ItemIcon, RelTime, Tag, itemLook, kindLabel } from "./item-look";
import { cn } from "../lib/utils";
import { NoteEditor } from "./NoteEditor";
import { TitleField } from "./TitleField";

/** Where the card was clicked to edit it (`title`: the caret offset in the title); null from a button: the caret at the text's end. */
export type Edit = { x?: number; y?: number; title?: number } | null;

/** Characters of a file's text shown in place of a body. */
const FILE_TEXT_PREVIEW = 1200;

/**
 * `editing`: null while it is read; a click on it then asks `onEdit`. `onDone`: the button in its
 * corner while editing ("Fertig", `doneKey` its key). `onOutside`: a click outside the card while
 * editing, but not into what the editor opened (a menu, a picture). `meta`: after the kind, as the
 * workspace.
 */
export function NoteCard({ item, meta, editing, onEdit, onDone, onOutside, doneKey, scroller, className }: { item: Item; meta?: ReactNode; editing: { at: Edit } | null; onEdit?: (at: Edit) => void; onDone: () => void; onOutside?: () => void; doneKey?: string; scroller?: RefObject<HTMLDivElement | null>; className?: string }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  const ix = useRepo().index();
  // in the inbox, a loose note is just a note
  const kind = kindLabel(itemLook(item, ix), t, { inboxAsNote: true });
  const children = belowOf(item.id, ix);
  const image = useBlobUrl(item.file?.filetype === "bild" ? (item.file.display ?? item.file.hash) : item.file?.thumb, true);
  const own = useRef<HTMLDivElement>(null);
  const scroll = scroller ?? own;
  const self = useRef<HTMLElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [overflows, setOverflows] = useState(false);
  const hasText = !item.file;

  useEffect(() => {
    if (!editing || !onOutside) return;
    const onPointer = (e: PointerEvent) => {
      const el = e.target as Element;
      if (!self.current?.contains(el) && !el.closest?.(".cm-menu, .cm-tooltip, [role=dialog]:not([data-shelf-panel]):not([data-quick-note]), [data-radix-popper-content-wrapper]")) onOutside();
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [!!editing, onOutside]);

  // once per editing: the caret into the title where it was clicked (a file has only its title), else into the text
  const placed = useRef(false);
  useEffect(() => {
    if (!editing) return void (placed.current = false);
    if (placed.current) return;
    const at = editing.at;
    if (!hasText || at?.title !== undefined) {
      const el = scroll.current?.querySelector("textarea");
      if (!el) return;
      const caret = Math.min(at?.title ?? Infinity, el.value.length);
      el.focus();
      el.setSelectionRange(caret, caret);
      placed.current = true;
      return;
    }
    if (!view) return;
    placed.current = true;
    view.focus();
    // after the editor's first measure: before it, its heights are guesses
    requestAnimationFrame(() => view.dom.isConnected && view.dispatch({ selection: { anchor: (at?.x !== undefined && view.posAtCoords({ x: at.x, y: at.y ?? 0 }, false)) || view.state.doc.length } }));
  }, [editing, view]);
  // Enter in the title goes on to the text, at its start
  const intoText = () => view && (view.focus(), view.dispatch({ selection: { anchor: 0 } }));

  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    el.addEventListener("scroll", measure, { passive: true });
    return () => (observer.disconnect(), el.removeEventListener("scroll", measure));
  }, []);

  return (
    <div className={cn("min-h-[180px]", className)}>
      <article
        ref={self}
        className={cn("relative flex h-full flex-col overflow-hidden rounded-2xl border bg-surface shadow-sm", editing ? "border-focus/55 ring-4 ring-focus/12" : "cursor-text border-line")}
        onClick={(e) => {
          const el = e.target as HTMLElement;
          if (editing || !onEdit || el.closest("a, button, img, .cm-queryblock") || getSelection()?.toString()) return;
          const caret = document.caretPositionFromPoint?.(e.clientX, e.clientY)?.offset ?? document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset; // Safari has only the latter
          onEdit({ x: e.clientX, y: e.clientY, title: el.closest("h2") ? (caret ?? Infinity) : undefined });
        }}
      >
        <div className="relative min-h-0 flex-1">
          <div ref={scroll} className="h-full overflow-y-auto px-8 pb-3 pt-7 max-lg:px-5 max-lg:pt-5">
            <div className="flex items-start gap-2 text-[13px] text-muted-foreground">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-fg">
                  <ItemIcon item={item} size={13} /> {kind}
                </span>
                {meta}
                <span>
                  {t("triage.captured")} <RelTime ts={item.created} />
                </span>
              </div>
              <a href={hrefOf(item.id)} className="tap -mr-1.5 -mt-1 shrink-0 rounded-md p-1.5 hover:bg-hover hover:text-fg" aria-label={t("review.open")} title={t("review.open")}>
                <Maximize2 size={15} />
              </a>
            </div>
            {editing ? (
              // as large as the title it replaces (over the page title's own size), so nothing below moves
              <div className="mt-4 [&_textarea]:text-[28px]! [&_textarea]:leading-[34px]! [&_textarea]:tracking-[-0.015em]! max-lg:[&_textarea]:text-2xl!">
                <TitleField item={item} autoFocus={false} placeholder={item.file?.name} onEnter={hasText ? intoText : undefined} />
              </div>
            ) : (
              <h2 className="mt-4 text-[28px] font-bold leading-[34px] tracking-[-0.015em] max-lg:text-2xl">{titleOf(item, t)}</h2>
            )}
            {hasText ? (
              <div className="mt-3 max-w-[68ch] text-[15px] leading-[1.65]">
                <NoteEditor item={item} readOnly={!editing} onView={setView} minHeight={editing ? "min-h-24" : "min-h-6"} />
              </div>
            ) : item.file?.text ? (
              <p className="mt-4 max-w-[68ch] text-[15px] leading-[1.65] text-muted-foreground">{plainText(item.file.text).slice(0, FILE_TEXT_PREVIEW)}</p>
            ) : null}
            {image && <img src={image} alt={item.title} className="mt-4 max-h-[50vh] w-auto rounded-lg border border-line" />}
            {item.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {item.tags.map((tag) => (
                  <Tag key={tag} tag={tag} />
                ))}
              </div>
            )}
            {children.length > 0 && (
              <div className="mt-5 border-t border-line pt-4">
                <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{t("below.title")}</p>
                <ul className="space-y-1 text-sm">
                  {children.map((child) => (
                    <li key={child.id} className="flex items-center gap-2">
                      <ItemIcon item={child} size={14} /> <a href={hrefOf(child.id)} className="truncate hover:underline">{titleOf(child, t)}</a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {overflows && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent" aria-hidden />}
        </div>
        {/* as far from the corner as "Öffnen" above (its box: the padding less its -1.5 margins) */}
        <div className="flex shrink-0 justify-end pb-6 pl-8 pr-6.5 pt-1 max-lg:pb-4 max-lg:pl-5 max-lg:pr-3.5">
          {(editing || onEdit) && (
            <Button
              variant="plain"
              onClick={() => (editing ? onDone() : onEdit?.(null))}
              className={cn(
                "tap inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium",
                editing ? "border-focus/40 bg-focus/10 text-focus hover:bg-focus/16" : "border-transparent text-muted-foreground hover:bg-hover hover:text-fg",
              )}
            >
              {editing ? <Check size={15} /> : <Pencil size={14} />} {t(editing ? "review.editDone" : "review.edit")}
              {editing && doneKey && <Kbd>{doneKey}</Kbd>}
            </Button>
          )}
        </div>
      </article>
    </div>
  );
}
