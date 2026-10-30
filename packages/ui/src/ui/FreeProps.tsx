// Free properties: a name and a value on one entry, without a type that defines them.
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { useState } from "react";
import { type FreeKind, type FreeValue, type Item, FREE_KINDS, todayISO } from "@obtion/core/model";
import { numberText, parseNumber } from "@obtion/core/input";
import { repo } from "../repo";
import { useT } from "../i18n";
import { DateField, InlineText } from "./fields";
import { Button } from "./primitives";

export function FreeField({ value, onChange, name, options }: { value: FreeValue; onChange: (v: FreeValue | null) => void; name: string; options?: string[] }) {
  const { t, lang } = useT();
  const k = value.k;
  if (k === "checkbox") return <Checkbox checked={value.v === true} onCheckedChange={(checked) => onChange({ k, v: checked === true })} aria-label={name} className="size-4" />;
  if (k === "date") return <DateField value={String(value.v ?? "") || undefined} label={name} onChange={(x) => onChange(x ? { k, v: x } : null)} />;
  if (k === "number")
    return <InlineText value={typeof value.v === "number" ? numberText(lang, value.v) : String(value.v)} onCommit={(x) => { const n = parseNumber(lang, x); onChange(n === undefined ? null : { k, v: n }); }} label={name} className="text-sm tabular-nums" />;
  if (k === "select")
    return (
      <>
        <Input variant="bare" list={`opts-${name}`} defaultValue={String(value.v)} onBlur={(e) => onChange(e.target.value.trim() ? { k, v: e.target.value.trim() } : null)} aria-label={name} className="field w-40 rounded-md bg-transparent px-1 text-sm outline-none hover:bg-hover" />
        <datalist id={`opts-${name}`}>{options?.map((o) => <option key={o} value={o} />)}</datalist>
      </>
    );
  return <InlineText value={String(value.v ?? "")} onCommit={(x) => onChange(x.trim() ? { k, v: x.trim() } : null)} placeholder={t("props.empty")} label={name} className="text-sm" />;
}

export function freeOptions(name: string): string[] {
  const set = new Set<string>();
  for (const i of repo.live()) {
    const v = Object.entries(i.extra).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
    if (v?.k === "select") set.add(String(v.v));
  }
  return [...set].sort();
}

/** "Neue Eigenschaft": a name and a kind; it starts with a value to change. */
export function AddFreeProp({ item, onDone }: { item: Item; onDone: () => void }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<FreeKind>("text");
  const addFree = () => {
    const n = name.trim();
    if (!n) return;
    repo.setExtra(item.id, n, { k: kind, v: kind === "checkbox" ? true : kind === "number" ? 0 : kind === "date" ? todayISO() : "…" });
    onDone();
  };
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <Input variant="sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" && addFree(), e.key === "Escape" && onDone())} placeholder={t("props.name")} className="w-36" />
      <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as FreeKind)} className="rounded-md border border-line bg-bg px-1.5 py-1 text-sm" aria-label={t("props.kind")}>
        {FREE_KINDS.map((k) => (
          <option key={k} value={k}>
            {t("kind.prop." + k)}
          </option>
        ))}
      </NativeSelect>
      <Button variant="plain" onClick={addFree} className="rounded-md bg-ink px-2 py-1 text-xs text-ink-text">
        {t("props.add")}
      </Button>
      <Button variant="plain" onClick={() => onDone()} className="text-xs text-muted-foreground">
        {t("cancel")}
      </Button>
    </div>
  );
}
