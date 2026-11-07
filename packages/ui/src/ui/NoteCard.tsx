// A note as a card: the inbox's entry and the quick note. Title and text are always editable, the text
// with the page's editor, so queries, embeds and links look as on the note's page. The card keeps the
// height it is given; a long note scrolls inside.
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Maximize2 } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { belowOf } from "@obtion/core/placement";
import { plainText } from "@obtion/core/search";
import { useItemHref, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { useBlobUrl } from "../files";
import { ItemIcon, RelTime, Tag, itemLook, kindLabel } from "./item-look";
import { cn } from "../lib/utils";
import { NoteEditor } from "./NoteEditor";
import { Markdown } from "./Markdown";
import { TitleField } from "./TitleField";

/** Characters of a file's text shown in place of a body. */
const FILE_TEXT_PREVIEW = 1200;

/** `meta`: after the kind, as the workspace. `autoFocus`: the caret into the title. `live`: the title commits as typed. */
export function NoteCard({ item, meta, autoFocus = false, live, scroller, className }: { item: Item; meta?: ReactNode; autoFocus?: boolean; live?: boolean; scroller?: RefObject<HTMLDivElement | null>; className?: string }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  const ix = useRepo().index();
  // in the inbox, a loose note is just a note
  const kind = kindLabel(itemLook(item, ix), t, { inboxAsNote: true });
  const children = belowOf(item.id, ix);
  const image = useBlobUrl(item.file?.filetype === "image" ? (item.file.display ?? item.file.hash) : item.file?.thumb, true);
  const own = useRef<HTMLDivElement>(null);
  const scroll = scroller ?? own;
  const [view, setView] = useState<EditorView | null>(null);
  const [overflows, setOverflows] = useState(false);
  const hasText = !item.file;
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
      <article className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
        <div className="relative min-h-0 flex-1">
          <div ref={scroll} className="h-full overflow-y-auto px-8 pb-7 pt-7 max-lg:px-5 max-lg:pb-5 max-lg:pt-5">
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
            {/* the card's title size, over the field's own */}
            <div className="mt-4 [&_textarea]:text-[28px]! [&_textarea]:leading-[34px]! [&_textarea]:tracking-[-0.015em]! max-lg:[&_textarea]:text-2xl!">
              <TitleField item={item} autoFocus={autoFocus} live={live} placeholder={item.file?.name} onEnter={hasText ? intoText : undefined} />
            </div>
            {hasText ? (
              <div className="mt-3 max-w-[68ch] text-[15px] leading-[1.65]">
                <NoteEditor item={item} onView={setView} minHeight="min-h-24" />
              </div>
            ) : item.body.trim() ? (
              // a file's own text, written on its page; else the text read from the file
              <div className="mt-4 max-w-[68ch] text-[15px] leading-[1.65]">
                <Markdown src={item.body} />
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
      </article>
    </div>
  );
}
