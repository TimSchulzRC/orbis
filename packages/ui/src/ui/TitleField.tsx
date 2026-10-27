import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Item } from "@obtion/core/model";
import { repo } from "../repo";
import { useT } from "../i18n";

/** Multi-line title that wraps instead of clipping; Enter commits. */
export function TitleField({ item, autoFocus, placeholder }: { item: Item; autoFocus: boolean; placeholder?: string }) {
  const { t } = useT();
  const [v, setV] = useState(item.title);
  const focused = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focused.current) setV(item.title);
  }, [item.title]);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [v]);
  const latest = useRef(v);
  latest.current = v;
  const commit = () => {
    focused.current = false;
    const x = latest.current.replace(/\s+/g, " ").trim();
    if (x !== (repo.get(item.id)?.title ?? "")) repo.setTitle(item.id, x);
  };
  useEffect(() => () => void (focused.current && commit()), []);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={v}
      autoFocus={autoFocus}
      aria-label={t("item.title")}
      placeholder={placeholder ?? t("untitled")}
      onFocus={() => (focused.current = true)}
      onBlur={commit}
      onChange={(e) => setV(e.target.value.replace(/\n/g, " "))}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.preventDefault(), (e.target as HTMLTextAreaElement).blur());
        if (e.key === "Escape") (setV(item.title), setTimeout(() => (e.target as HTMLTextAreaElement).blur()));
      }}
      data-large
      className="field page-title block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-faint"
    />
  );
}
