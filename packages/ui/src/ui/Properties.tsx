// Schema changes never delete values; values of removed properties show as "Weitere Eigenschaften".
import { Checkbox } from "../components/ui/checkbox";
import { NativeSelect } from "../components/ui/native-select";
import { useState } from "react";
import { X, Plus, ExternalLink, AlertTriangle, CalendarDays } from "lucide-react";
import { type Item, type PropDef, type TypeSchema, type Value, STATUS_GROUPS, formatRange, optionNames, parseRange } from "@obtion/core/model";
import { type T, fmtDate } from "@obtion/core/i18n";
import type { Index } from "@obtion/core/graph";
import { numberText, parseNumber } from "@obtion/core/input";
import { parseQuery, matches } from "@obtion/core/query";
import { defaultOption, doneAt, hasValue, isSingle, isStatusProp, optionIds, statusOf, visibleProps } from "@obtion/core/traits";
import { repo } from "../repo";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { DateField, InlineText } from "./fields";
import { EmptyDash, ItemLink, StatusPill, Tag } from "./item-look";
import { Button, EmptyValueButton, IconButton, MenuItem, Popover, AddButton, REVEAL } from "./primitives";
import { Progress, ProgressCount } from "./progress";
import { cn } from "../lib/utils";
import { PageTags } from "./Tags";
import { FreeValueText } from "./FreeProps";
import { ItemPicker } from "./Picker";
import { StatusMenu, setStatus } from "./Row";
import { dateOf } from "@obtion/core/date";

/** Longer text values get a multi-line field. */
const MULTILINE_FROM = 60;
const TARGET_SUGGESTIONS = 8;

function displayValue(item: Item, p: PropDef): string {
  const value = item.props[p.id];
  const ix = repo.index();
  if (item.rels[p.id]?.length) return item.rels[p.id]!.map((id) => ix.get(id)?.title ?? id).join(", ");
  if (value === undefined) return "";
  if (p.options) return optionNames(p, value).join(", ");
  return String(value);
}

export function PropertyField({ item, prop, autoFocus }: { item: Item; prop: PropDef; autoFocus?: boolean }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const value = item.props[prop.id];
  const setValue = (x: Value | null) => repo.setProp(item.id, prop.id, x);
  switch (prop.kind) {
    case "text":
      return <InlineText value={String(value ?? "")} onCommit={(x) => setValue(x.trim() || null)} placeholder={t("props.empty")} label={prop.name} multiline={String(value ?? "").length > MULTILINE_FROM} autoFocus={autoFocus} className="text-sm leading-relaxed" />;
    case "url":
      return (
        <span className="flex w-full items-center gap-1">
          <InlineText value={String(value ?? "")} onCommit={(x) => setValue(x.trim() || null)} placeholder={t("props.empty")} label={prop.name} autoFocus={autoFocus} className="text-sm" />
          {typeof value === "string" && /^https?:\/\//.test(value) && (
            <a href={value} target="_blank" rel="noopener" className="text-muted-foreground hover:text-fg" aria-label={t("props.openLink")}>
              <ExternalLink size={13} />
            </a>
          )}
        </span>
      );
    case "number":
      return (
        <InlineText
          value={typeof value === "number" ? numberText(lang, value) : ""}
          onCommit={(x) => setValue(parseNumber(lang, x) ?? null)}
          placeholder={t("props.empty")}
          label={prop.name}
          autoFocus={autoFocus}
          className="text-sm tabular-nums"
        />
      );
    case "date": {
      const text = typeof value === "string" ? value : "";
      if (!prop.range) return <DateField value={text || undefined} label={prop.name} autoFocus={autoFocus} onChange={(x) => setValue(x || null)} />;
      return <RangeField value={text} name={prop.name} autoFocus={autoFocus} onChange={(x) => setValue(x || null)} />;
    }
    case "checkbox":
      return <Checkbox checked={value === true} onCheckedChange={(checked) => setValue(checked === true ? true : null)} aria-label={prop.name} className="size-4" />;
    case "select": {
      if (prop.multiple) return <MultiField item={item} prop={prop} />;
      const schema = ix.schemaOf(item);
      const done = isStatusProp(schema, prop) ? doneAt(item, schema) : undefined;
      return (
        <>
          <OptionSelect item={item} prop={prop} className="inline-flex" />
          {done && <span className="text-xs tabular-nums text-muted-foreground">{t("props.doneOn", { date: fmtDate(lang, dateOf(done)) })}</span>}
        </>
      );
    }
    case "relation":
      return <RelationField item={item} prop={prop} autoOpen={autoFocus} />;
    case "computed": {
      const computed = prop.computed;
      if (computed?.fn === "count") return <span className="tabular-nums text-muted-foreground">{ix.countDescendants(item.id, computed.of)}</span>;
      const progress = ix.progress(item.id, computed?.of);
      return progress.total ? (
        <span className="flex w-full max-w-64 items-center gap-2">
          <Progress done={progress.done} total={progress.total} className="flex-1" />
          <ProgressCount done={progress.done} total={progress.total} className="text-xs text-muted-foreground" />
        </span>
      ) : (
        <EmptyDash />
      );
    }
  }
  return null;
}

function MultiField({ item, prop }: { item: Item; prop: PropDef }) {
  const { t } = useT();
  const ids = optionIds(item.props[prop.id]);
  const set = (x: string[]) => repo.setProp(item.id, prop.id, x.length ? x : null);
  return (
    <>
      {ids.map((id) => {
        const option = prop.options?.find((x) => x.id === id);
        return (
          <span key={id} className="inline-flex items-center gap-0.5">
            {option ? <StatusPill option={option} small /> : id}
            <Button variant="plain" onClick={() => set(ids.filter((x) => x !== id))} className="text-muted-foreground hover:text-fg" aria-label={t("props.removeValue")}>
              <X size={11} />
            </Button>
          </span>
        );
      })}
      <Popover
        trigger={(p) =>
          ids.length ? (
            <Button variant="plain" {...p} className="tap rounded-md px-1 text-xs text-muted-foreground hover:bg-hover" aria-label={t("props.set", { name: prop.name })}><Plus size={12} /></Button>
          ) : (
            <Button variant="plain" {...p} className="tap-y -ml-1 rounded px-1 text-faint hover:bg-hover hover:text-muted-foreground" aria-label={t("props.set", { name: prop.name })}>{t("props.empty")}</Button>
          )
        }
      >
        {(close) =>
          prop.options?.filter((o) => !ids.includes(o.id)).map((o) => (
            <MenuItem key={o.id} onClick={() => (close(), set([...ids, o.id]))}>
              {o.name}
            </MenuItem>
          ))
        }
      </Popover>
    </>
  );
}

/** An invisible native select lies over the chip, so a click picks right there. */
export function OptionSelect({ item, prop, className }: { item: Item; prop: PropDef; className?: string }) {
  const { t } = useT();
  const value = item.props[prop.id];
  const opt = prop.options?.find((o) => o.id === value);
  const schema = useIndex().schemaOf(item);
  const isStatus = isStatusProp(schema, prop);
  // a select with a default is never empty
  const required = !!defaultOption(prop, schema);
  return (
    <label className={cn("tap-row relative cursor-pointer items-center", className)}>
      {opt ? <StatusPill option={opt} group={isStatus ? (opt.group ?? "todo") : undefined} /> : <span className="text-muted-foreground">{t("props.empty")}</span>}
      <NativeSelect
        overlay
        value={String(value ?? "")}
        onChange={(e) => (isStatus && e.target.value ? void setStatus(item, e.target.value) : repo.setProp(item.id, prop.id, e.target.value || null))}
        aria-label={prop.name}
      >
        {(!required || !opt) && <option value="">–</option>}
        {isStatus
          ? STATUS_GROUPS.map((g) => (
              <optgroup key={g} label={t("group." + g)}>
                {prop.options!.filter((o) => (o.group ?? "todo") === g).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            ))
          : prop.options?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
      </NativeSelect>
    </label>
  );
}

export function RangeEditor({ value, onChange, autoFocus, className }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; className?: string }) {
  const { t } = useT();
  const { start, end } = parseRange(value);
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      <DateField value={start || undefined} label={t("props.start")} autoFocus={autoFocus} onChange={(x) => onChange(formatRange(x, end))} />
      <EmptyDash />
      <DateField value={end || undefined} label={t("props.end")} onChange={(x) => onChange(formatRange(start, x))} />
    </span>
  );
}

function RangeField({ value, name, autoFocus, onChange }: { value: string; name: string; autoFocus?: boolean; onChange: (v: string) => void }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(!!autoFocus);
  if (!value && !open) return <EmptyValueButton type="button" onClick={() => setOpen(true)} aria-label={t("props.set", { name })} />;
  if (!open) {
    const { start, end } = parseRange(value);
    const long = (d: string) => (d ? fmtDate(lang, d, { day: "numeric", month: "long", year: "numeric" }) : "…");
    return (
      <Button variant="plain" type="button" onClick={() => setOpen(true)} className="tap-y -ml-1 rounded px-1 text-left tabular-nums hover:bg-hover" aria-label={t("props.set", { name })}>
        {long(start)} – {long(end)}
      </Button>
    );
  }
  return <RangeEditor value={value} onChange={onChange} autoFocus />;
}

function RelationField({ item, prop, autoOpen }: { item: Item; prop: PropDef; autoOpen?: boolean }) {
  const { t } = useT();
  const ix = useIndex();
  const [picking, setPicking] = useState(!!autoOpen);
  const ids = ix.relValues(item, prop.id, prop.symmetric);
  const target = prop.target ? parseQuery(prop.target, ix).def.where : undefined;
  const fits = (x: Item) => !target || matches(x, target, { ix, thisId: item.id });
  const own = item.rels[prop.id] ?? [];
  const remove = (id: string) => {
    if (own.includes(id)) repo.setRel(item.id, prop.id, id, false);
    else repo.setRel(id, prop.id, item.id, false); // a symmetric relation may be stored on the other side
  };
  return (
    <>
      {ids.map((id) => {
        const related = ix.get(id)!;
        return (
          <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-1.5 pr-0.5 text-xs">
            <ItemLink item={related} className="min-w-0" />
            {!fits(related) && <span title={t("props.notTarget", { target: prop.target })} className="text-warn"><AlertTriangle size={11} /></span>}
            <Button variant="plain" onClick={() => remove(id)} className="rounded px-1 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("props.removeValue")}>
              <X size={11} />
            </Button>
          </span>
        );
      })}
      {!ids.length ? (
        <EmptyValueButton type="button" onClick={() => setPicking(true)} aria-label={t("props.set", { name: prop.name })} />
      ) : (
        prop.multiple && <AddButton onClick={() => setPicking(true)} aria-label={t("props.set", { name: prop.name })} />
      )}
      {picking && (
        <ItemPicker
          title={prop.name}
          suggestions={ix.live.filter((x) => target && x.id !== item.id && fits(x) && !ids.includes(x.id)).slice(0, TARGET_SUGGESTIONS).map((x) => ({ id: x.id, reason: "target" as const }))}
          exclude={(x) => x.id === item.id || ids.includes(x.id)}
          onPick={(id) => {
            if (!prop.multiple) for (const old of own) repo.setRel(item.id, prop.id, old, false);
            repo.setRel(item.id, prop.id, id, true);
            setPicking(false);
          }}
          onCreate={(title) => {
            const id = repo.create({ title, type: target && "type" in target ? target.type : null });
            repo.setRel(item.id, prop.id, id, true);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

function BlockRow({ label, title, children }: { label: React.ReactNode; title?: string; children: React.ReactNode }) {
  return (
    <>
      <div className="flex min-h-[34px] items-center truncate rounded-md px-1.5 text-sm text-muted-foreground pointer-coarse:min-h-11" title={title ?? (typeof label === "string" ? label : undefined)}>
        <span className="truncate">{label}</span>
      </div>
      <div className="group flex min-h-[34px] min-w-0 flex-wrap items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-hover/60 pointer-coarse:min-h-11">{children}</div>
    </>
  );
}

/** `first` goes before the badges, `end` at the right edge after the tags, `progress` under the dates. */
interface PageHead {
  first?: React.ReactNode;
  end?: React.ReactNode;
  progress?: React.ReactNode;
}

/** Status and selections read as badges by themselves, so they need no label. */
const isBadge = (p: PropDef) => isSingle(p);

/**
 * Design rules § 2.2. Every property of the type shows from the start, a page adds none the type
 * lacks. Tags are no property and follow the badges (see PageTags).
 */
export function PropertyBlock({ item, schema, head = {} }: { item: Item; schema?: TypeSchema; head?: PageHead }) {
  const { t } = useT();
  const ix = useIndex();
  const visible = schema ? visibleProps(item, schema, ix).filter((p) => !(p.kind === "computed" && p.computed?.fn !== "count")) : [];
  const badges = visible.filter(isBadge);
  const dates = visible.filter((p) => p.kind === "date");
  const shown = visible.filter((p) => !isBadge(p) && p.kind !== "date");
  const leftovers = schema ? schema.removedProperties.filter((p) => item.props[p.id] !== undefined || item.rels[p.id]?.length) : [];
  const inverse = inverseGroups(item, ix, t);
  const free = Object.entries(item.extra);
  const rows = shown.length || free.length || inverse.length || leftovers.length;
  return (
    <div className="group/props">
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {head.first}
        {badges.map((p) => (
          <span key={p.id} className="inline-flex">
            {isStatusProp(schema, p) ? <StatusBadge item={item} /> : <SelectBadge item={item} prop={p} />}
          </span>
        ))}
        <PageTags item={item} />
        {head.end && <span className="ml-auto inline-flex">{head.end}</span>}
      </div>
      {dates.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          {dates.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1.5" title={p.description || p.name}>
              <CalendarDays size={15} className="shrink-0 text-muted-foreground" aria-hidden />
              {/* name the date only where the icon alone does not say which one it is */}
              {(dates.length > 1 || !hasValue(item, p, ix)) && <span className="text-muted-foreground">{p.name}</span>}
              <PropertyField item={item} prop={p} />
            </span>
          ))}
        </div>
      )}
      {head.progress}
      {rows > 0 && (
      <div className="-mx-1.5 mt-4 grid grid-cols-[160px_minmax(0,1fr)] gap-x-1 max-md:grid-cols-[124px_minmax(0,1fr)]">
      {shown.map((p) => (
        <BlockRow key={p.id} label={p.name} title={p.description || p.name}>
          <PropertyField item={item} prop={p} />
        </BlockRow>
      ))}
      {free.map(([n, v]) => (
        <BlockRow key={"free:" + n} label={n}>
          <FreeValueText value={v} />
          <IconButton size="xs" icon={X} iconSize={12} onClick={() => repo.setExtra(item.id, n, null)} className={cn("ml-auto text-faint", REVEAL.any)} label={t("props.removeFree", { name: n })} />
        </BlockRow>
      ))}
      {inverse.map((g) => (
        <BlockRow key={"inv:" + g.label} label={g.label}>
          {g.ids.map((id) => (
            <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[13px]">
              <ItemLink item={ix.get(id)!} className="min-w-0" />
            </span>
          ))}
        </BlockRow>
      ))}
      {leftovers.map((p) => (
        <BlockRow key={"old:" + p.id} label={p.name} title={t("props.more")}>
          <span className="text-muted-foreground">{displayValue(item, p)}</span>
          <IconButton size="xs" icon={X} iconSize={12} onClick={() => repo.setProp(item.id, p.id, null)} className={cn("ml-auto text-faint", REVEAL.any)} label={t("props.removeFree", { name: p.name })} />
        </BlockRow>
      ))}
      </div>
      )}
      <div className="mt-2" />
    </div>
  );
}

function StatusBadge({ item }: { item: Item }) {
  const { t } = useT();
  const ix = useIndex();
  const status = statusOf(item, ix.schemaOf(item));
  if (!status) return null;
  return (
    <StatusMenu
      item={item}
      trigger={(p) => (
        <Button variant="plain" {...p} className="tap-y inline-flex" aria-label={t("row.status", { name: status.option.name })}>
          <StatusPill option={status.option} group={status.group} />
        </Button>
      )}
    />
  );
}

/** Shows the property's name before the value ("Phase Entwurf"). */
function SelectBadge({ item, prop }: { item: Item; prop: PropDef }) {
  const { t } = useT();
  const value = item.props[prop.id];
  const opt = prop.options?.find((o) => o.id === value);
  const ix = useIndex();
  // a select with a default is never empty
  const required = !!defaultOption(prop, ix.schemaOf(item));
  const label = !opt ? null : (
    <>
      <span className="opacity-70">{prop.name}</span> {opt.name}
    </>
  );
  return (
    <Popover
      trigger={(p) => (
        <Button variant="plain" {...p} className="tap-y inline-flex" aria-label={t("props.set", { name: prop.name })} title={prop.description || prop.name}>
          {opt ? (
            <StatusPill option={opt} label={label} />
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted-foreground hover:text-fg">
              <Plus size={11} /> {prop.name}
            </span>
          )}
        </Button>
      )}
    >
      {(close) => (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">{prop.name}</p>
          {prop.options?.map((o) => (
            <MenuItem key={o.id} active={o.id === value} onClick={() => (close(), repo.setProp(item.id, prop.id, o.id))}>
              <StatusPill option={o} />
            </MenuItem>
          ))}
          {opt && !required && (
            <>
              <div className="my-1 border-t border-line" />
              <MenuItem icon={<X size={13} />} onClick={() => (close(), repo.setProp(item.id, prop.id, null))}>
                {t("props.removeValue")}
              </MenuItem>
            </>
          )}
        </>
      )}
    </Popover>
  );
}

function inverseGroups(item: Item, ix: Index, t: T): { label: string; ids: string[] }[] {
  const groups = new Map<string, { label: string; ids: string[] }>();
  for (const b of ix.backlinks(item.id)) {
    if (b.kind !== "rel") continue;
    const from = ix.get(b.from);
    if (!from) continue;
    const prop = ix.schemaOf(from)?.properties.find((x) => x.id === b.prop);
    if (!prop || prop.symmetric) continue;
    const label = prop.inverseName || t("props.inverse", { prop: prop.name, type: ix.typeName(from.type) ?? "" });
    const group = groups.get(label) ?? { label, ids: [] };
    if (!group.ids.includes(from.id)) group.ids.push(from.id);
    groups.set(label, group);
  }
  return [...groups.values()];
}
