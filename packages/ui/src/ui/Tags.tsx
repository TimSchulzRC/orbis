// Tags of a page: their own thing, not a property. They sit in the badge row under the title,
// after type and status; "#" opens a field right there with the list of all tags under it.
import { useMemo, useState } from "react";
import { Check, Hash, Plus } from "lucide-react";
import { type Item, normalizeTag } from "@obtion/core/model";
import { repo } from "../repo";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { Tag } from "./item-look";
import { Button } from "./primitives";
import { cn } from "../lib/utils";

const SEP = /[\s,;]+/;
/** "a b, #c" → ["a", "b", "c"]: several at once, typed or pasted. */
const splitTags = (s: string) => s.split(SEP).map(normalizeTag).filter(Boolean);
/** The "+" and the opened field share it: one height, the icon in the same place. */
const BOX = "inline-flex h-6 items-center rounded-md border px-1 text-xs";
const setTag = (item: Item, tag: string, on: boolean) => repo.setMember(item.id, "tags", tag, on);

/**
 * The page's tags as chips, then "+" to add more (quiet while there are some). Opened, the "+"
 * turns into the "#" in front of the field – same box, same height, so the row does not move.
 */
export function PageTags({ item }: { item: Item }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      {item.tags.map((tag) => (
        <Tag key={tag} tag={tag} href={`#/search?q=${encodeURIComponent("#" + tag)}`} onRemove={() => setTag(item, tag, false)} />
      ))}
      {open ? (
        <TagPicker item={item} onClose={() => setOpen(false)} />
      ) : (
        <Button
          variant="plain"
          onClick={() => setOpen(true)}
          aria-label={t("tag.addMany")}
          title={t("tag.addMany")}
          className={cn(
            BOX,
            "tap-y border-transparent text-muted-foreground hover:bg-hover hover:text-fg",
            item.tags.length > 0 && "opacity-0 transition-opacity focus:opacity-100 group-hover/props:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          <Plus size={12} className="shrink-0" />
          {!item.tags.length && <span className="px-1">{t("item.tags")}</span>}
        </Button>
      )}
    </>
  );
}

/**
 * A field behind "#" with every tag under it to tick. Typing filters; Enter, space or comma adds
 * what was typed and the field stays for the next one; pasting "a, b c" adds all three; Backspace
 * on empty takes off the tag added last here; Esc or leaving closes. A click in the list toggles a tag and
 * keeps the list open, so several go in one pass.
 */
function TagPicker({ item, onClose }: { item: Item; onClose: () => void }) {
  const { t } = useT();
  const ix = useIndex();
  const [v, setV] = useState("");
  const [sel, setSel] = useState(0);
  // added in this pass, newest last (the page keeps its tags sorted, so its last is not the newest)
  const [added, setAdded] = useState<string[]>([]);
  const q = normalizeTag(v);
  const options = useMemo(() => {
    const counts = new Map(ix.tags().map((x) => [x.tag, x.count]));
    const all = [...counts].map(([tag, count]) => ({ tag, count, isNew: false }));
    const on = (tag: string) => Number(!q && item.tags.includes(tag));
    // nothing typed: the page's own first; typed: the exact match, then prefix matches; then by use
    const list = all
      .filter((x) => !q || x.tag.includes(q))
      .sort((a, b) => on(b.tag) - on(a.tag) || Number(b.tag === q) - Number(a.tag === q) || Number(b.tag.startsWith(q)) - Number(a.tag.startsWith(q)) || b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 12);
    if (q && !counts.has(q)) list.push({ tag: q, count: 0, isNew: true });
    return list;
  }, [ix, q, item.tags.join(" ")]);
  const active = Math.min(sel, options.length - 1);
  const add = (tags: string[]) => {
    for (const x of tags) setTag(item, x, true);
    setAdded((a) => [...a.filter((x) => !tags.includes(x)), ...tags]);
    setV("");
    setSel(0);
  };
  const toggle = (tag: string) => (item.tags.includes(tag) ? (setTag(item, tag, false), setV(""), setSel(0)) : add([tag]));
  return (
    <span className={cn(BOX, "relative border-line bg-surface")}>
      <Hash size={12} className="shrink-0 text-muted-foreground" aria-hidden />
      <input
        autoFocus
        value={v}
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls="tag-picker-list"
        aria-label={t("tag.addMany")}
        placeholder={t("tag.search")}
        onBlur={() => setTimeout(onClose, 150)}
        onChange={(e) => {
          const x = e.target.value;
          if (!SEP.test(x)) return void (setV(x), setSel(0));
          // a separator typed or pasted: everything before the last one becomes tags
          const parts = x.split(SEP);
          const rest = parts.pop() ?? "";
          add(parts.flatMap(splitTags));
          setV(rest);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel(Math.min(options.length - 1, active + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel(Math.max(0, active - 1)));
          else if (e.key === "Enter") {
            e.preventDefault();
            const o = options[active];
            // Enter adds (a tag the page has already just clears the field); a click toggles
            if (q && o) add(item.tags.includes(o.tag) ? [] : [o.tag]);
            else if (!q) e.currentTarget.blur();
          } else if (e.key === "Escape") e.currentTarget.blur();
          else if (e.key === "Backspace" && !v) {
            const last = added.findLast((x) => item.tags.includes(x));
            if (last) (setTag(item, last, false), setAdded((a) => a.filter((x) => x !== last)));
          }
        }}
        className="h-full w-44 min-w-0 bg-transparent px-1 text-xs outline-none placeholder:text-faint"
      />
      {options.length > 0 && (
        <span id="tag-picker-list" role="listbox" aria-multiselectable className="absolute left-0 top-full z-30 mt-1 flex w-60 flex-col overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-lg">
          {options.map((o, i) => {
            const on = item.tags.includes(o.tag);
            return (
              <Button
                variant="plain"
                key={o.tag + (o.isNew ? "+" : "")}
                role="option"
                aria-selected={on}
                onMouseEnter={() => setSel(i)}
                // keep the focus in the field: the list stays open for the next one
                onMouseDown={(e) => (e.preventDefault(), toggle(o.tag))}
                className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === active && "bg-selected")}
              >
                {o.isNew ? (
                  <Plus size={14} className="shrink-0 text-muted-foreground" />
                ) : (
                  <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border", on ? "border-fg bg-fg text-bg" : "border-line")}>{on && <Check size={11} />}</span>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {o.isNew && <>{t("tag.create")} </>}
                  <span className="text-muted-foreground">#</span>
                  {o.isNew ? <b>{o.tag}</b> : o.tag}
                </span>
                {!o.isNew && <span className="text-xs tabular-nums text-muted-foreground">{o.count}</span>}
              </Button>
            );
          })}
        </span>
      )}
    </span>
  );
}
