// Values without a property: what is left on an entry when its type or the property is gone.
// They are only shown and can be removed; new ones are not added by hand.
import type { FreeValue } from "@obtion/core/model";
import { fmtDate, fmtNumber } from "@obtion/core/i18n";
import { useT } from "../i18n";

export function FreeValueText({ value }: { value: FreeValue }) {
  const { lang } = useT();
  const v = value.v;
  if (value.k === "checkbox") return <span className="text-sm">{v ? "✓" : "–"}</span>;
  if (value.k === "number") return <span className="text-sm tabular-nums">{typeof v === "number" ? fmtNumber(lang, v) : String(v)}</span>;
  if (value.k === "date") return <span className="text-sm whitespace-nowrap">{String(v).split("/").map((d) => fmtDate(lang, d)).join(" – ")}</span>;
  if (value.k === "url" && /^https?:\/\//.test(String(v)))
    return (
      <a href={String(v)} target="_blank" rel="noopener" className="truncate text-sm text-link hover:underline">
        {String(v).replace(/^https?:\/\//, "")}
      </a>
    );
  return <span className="text-sm break-words">{String(v ?? "")}</span>;
}
