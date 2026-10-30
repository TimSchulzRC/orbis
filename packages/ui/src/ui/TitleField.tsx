import { Textarea } from "../components/ui/textarea";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Item } from "@obtion/core/model";
import { useFocusDraft, useRepo } from "../hooks";
import { useT } from "../i18n";

/** Multi-line title that wraps instead of clipping; Enter commits. */
export function TitleField({ item, autoFocus, placeholder }: { item: Item; autoFocus: boolean; placeholder?: string }) {
  const { t } = useT();
  // the workspace of this part of the page (the tray's panel shows entries of several)
  const repo = useRepo();
  const { draft: v, setDraft: setV, focused, onKeyDown } = useFocusDraft(item.title);
  const ref = useRef<HTMLTextAreaElement>(null);
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
    <Textarea
      variant="inline"
      ref={ref}
      rows={1}
      value={v}
      autoFocus={autoFocus}
      aria-label={t("item.title")}
      placeholder={placeholder ?? t("untitled")}
      onFocus={() => (focused.current = true)}
      onBlur={commit}
      onChange={(e) => setV(e.target.value.replace(/\n/g, " "))}
      onKeyDown={onKeyDown}
      data-large
      className="field page-title block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-faint focus-visible:ring-0"
    />
  );
}
