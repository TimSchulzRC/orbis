import { Button as ShadcnButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useMemo, useState } from "react";
import { useRepo } from "../hooks";
import { normalizeTag } from "@obtion/core/model";
import { cx, AddButton } from "./bits";
import { tr } from "../i18n";

/** Small "+ tag" input with keyboard-selectable suggestions from existing tags. */
/** `start`: open as a field right away (e.g. "+ Eigenschaft › Tag"); `onCancel`: it closed empty. */
export function TagInput({ onAdd, exclude = [], start, onCancel }: { onAdd: (t: string) => void; exclude?: string[]; start?: boolean; onCancel?: () => void }) {
  const repo = useRepo();
  const [editing, setEditing] = useState(!!start);
  const [v, setV] = useState("");
  const [sel, setSel] = useState(0);
  const q = normalizeTag(v);
  const suggestions = useMemo(() => {
    if (!editing || !q) return [];
    const all = repo.index().tags().filter((t) => !exclude.includes(t.tag) && (!q || t.tag.includes(q)));
    // Prefix matches first, then by usage.
    return all.sort((a, b) => Number(b.tag.startsWith(q)) - Number(a.tag.startsWith(q)) || b.count - a.count).slice(0, 8);
  }, [q, editing]);
  // Option list: existing tags, plus "create" for a new one when typed text isn't an exact match.
  const options = [...suggestions.map((s) => ({ tag: s.tag, count: s.count as number | null }))];
  if (q && !suggestions.some((s) => s.tag === q)) options.push({ tag: q, count: null });
  const add = (t?: string) => {
    const tag = normalizeTag(t ?? "");
    if (tag) onAdd(tag);
    setV("");
    setSel(0);
  };
  if (!editing)
    return (
      <AddButton onClick={() => setEditing(true)}>{tr("tag.add")}</AddButton>
    );
  return (
    <span className="relative inline-block">
      <Input
        autoFocus
        value={v}
        onChange={(e) => (setV(e.target.value), setSel(0))}
        onBlur={() => setTimeout(() => (setEditing(false), setV(""), onCancel?.()), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(options.length - 1, s + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
          else if (e.key === "Enter" || e.key === "Tab") {
            if (!q) {
              if (e.key === "Enter") (e.preventDefault(), setEditing(false));
              return;
            }
            e.preventDefault();
            add(options[sel]?.tag ?? q);
          } else if (e.key === "," || e.key === " ") {
            e.preventDefault();
            add(q);
          } else if (e.key === "Escape") setEditing(false);
          else if (e.key === "Backspace" && !v) setEditing(false);
        }}
        placeholder={tr("tag.placeholder")}
        aria-label={tr("tag.add")}
        className="w-28 rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs outline-none"
      />
      {options.length > 0 && (
        <span className="absolute left-0 top-full z-30 mt-1 flex w-52 flex-col overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-lg" role="listbox">
          {options.map((s, i) => (
            <ShadcnButton variant="plain" size="none"
              key={s.tag + (s.count === null ? "+" : "")}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                add(s.tag);
              }}
              className={cx("flex justify-between rounded-md px-2 py-1 text-left text-xs", i === sel && "bg-selected")}
            >
              <span>{s.count === null ? <>{tr("tag.create")} <b>#{s.tag}</b></> : `#${s.tag}`}</span>
              {s.count !== null && <span className="text-muted-foreground">{s.count}</span>}
            </ShadcnButton>
          ))}
        </span>
      )}
    </span>
  );
}
