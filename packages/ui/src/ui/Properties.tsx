// Properties of an item: those its type defines, free ones, and values of removed
// properties ("Weitere Eigenschaften") – schema changes never delete values.
import { Checkbox } from "../components/ui/checkbox";
import { Button as ShadcnButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { useState } from "react";
import { X, Plus, ExternalLink, AlertTriangle, Trash2, ArrowRightLeft, CalendarDays } from "lucide-react";
import { type FreeKind, type FreeValue, type Item, type PropDef, type TypeSchema, type Value, FREE_KINDS, STATUS_GROUPS, optionNames, todayISO } from "@obtion/core/model";
import { type T, fmtDate } from "@obtion/core/i18n";
import type { Index } from "@obtion/core/graph";
import { numberText, parseNumber } from "@obtion/core/input";
import { parseQuery, matches } from "@obtion/core/query";
import { doneAt, hasValue, priorityProp, statusOf, visibleProps } from "@obtion/core/traits";
import { toFree } from "@obtion/core/typeops";
import { repo } from "../repo";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { DateField, InlineText, ItemLink, MenuItem, Popover, Progress, StatusPill, Tag, cx, AddButton } from "./bits";
import { TagInput } from "./TagInput";
import { ItemPicker } from "./Picker";
import { StatusMenu, setStatus } from "./Row";
import { dateOf } from "@obtion/core/date";

function displayValue(item: Item, p: PropDef): string {
  const v = item.props[p.id];
  const ix = repo.index();
  if (item.rels[p.id]?.length) return item.rels[p.id]!.map((id) => ix.get(id)?.title ?? id).join(", ");
  if (v === undefined) return "";
  if (p.options) return optionNames(p, v).join(", ");
  return String(v);
}

export function PropertyField({ item, prop, autoFocus }: { item: Item; prop: PropDef; autoFocus?: boolean }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const v = item.props[prop.id];
  const set = (x: Value | null) => repo.setProp(item.id, prop.id, x);
  switch (prop.kind) {
    case "text":
      return <InlineText value={String(v ?? "")} onCommit={(x) => set(x.trim() || null)} placeholder={t("props.empty")} label={prop.name} multiline={String(v ?? "").length > 60} autoFocus={autoFocus} className="text-sm leading-relaxed" />;
    case "url":
      return (
        <span className="flex w-full items-center gap-1">
          <InlineText value={String(v ?? "")} onCommit={(x) => set(x.trim() || null)} placeholder={t("props.empty")} label={prop.name} autoFocus={autoFocus} className="text-sm" />
          {typeof v === "string" && /^https?:\/\//.test(v) && (
            <a href={v} target="_blank" rel="noopener" className="text-muted-foreground hover:text-fg" aria-label={t("props.openLink")}>
              <ExternalLink size={13} />
            </a>
          )}
        </span>
      );
    case "number":
      return (
        <InlineText
          value={typeof v === "number" ? numberText(lang, v) : ""}
          onCommit={(x) => set(parseNumber(lang, x) ?? null)}
          placeholder={t("props.empty")}
          label={prop.name}
          autoFocus={autoFocus}
          className="text-sm tabular-nums"
        />
      );
    case "date": {
      const s = typeof v === "string" ? v : "";
      if (!prop.range) return <DateField value={s || undefined} label={prop.name} autoFocus={autoFocus} onChange={(x) => set(x || null)} />;
      return <RangeField value={s} name={prop.name} autoFocus={autoFocus} onChange={(x) => set(x || null)} />;
    }
    case "checkbox":
      return <Checkbox checked={v === true} onCheckedChange={(checked) => set(checked === true ? true : null)} aria-label={prop.name} className="size-4" />;
    case "select":
    case "status": {
      const opt = prop.options?.find((o) => o.id === v);
      const done = prop.kind === "status" ? doneAt(item, ix.schemaOf(item)) : undefined;
      return (
        <>
        <label className="tap-row relative inline-flex cursor-pointer items-center">
          {opt ? <StatusPill option={opt} /> : <span className="text-muted-foreground">{t("props.empty")}</span>}
          <NativeSelect
            value={String(v ?? "")}
            onChange={(e) => (prop.kind === "status" && e.target.value ? void setStatus(item, e.target.value) : set(e.target.value || null))}
            aria-label={prop.name}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            {prop.kind !== "status" && <option value="">–</option>}
            {prop.kind === "status"
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
        {done && <span className="text-xs tabular-nums text-muted-foreground">{t("props.doneOn", { date: fmtDate(lang, dateOf(done)) })}</span>}
        </>
      );
    }
    case "multiselect": {
      const ids = Array.isArray(v) ? (v as string[]) : [];
      return (
        <>
          {ids.map((id) => {
            const o = prop.options?.find((x) => x.id === id);
            return (
              <span key={id} className="inline-flex items-center gap-0.5">
                {o ? <StatusPill option={o} small /> : id}
                <ShadcnButton variant="plain" size="none" onClick={() => set(ids.filter((x) => x !== id))} className="text-muted-foreground hover:text-fg" aria-label={t("props.removeValue")}>
                  <X size={11} />
                </ShadcnButton>
              </span>
            );
          })}
          <Popover
            trigger={(p) =>
              ids.length ? (
                <ShadcnButton variant="plain" size="none" {...p} className="tap rounded-md px-1 text-xs text-muted-foreground hover:bg-hover" aria-label={t("props.set", { name: prop.name })}><Plus size={12} /></ShadcnButton>
              ) : (
                <ShadcnButton variant="plain" size="none" {...p} className="tap-y -ml-1 rounded px-1 text-faint hover:bg-hover hover:text-muted-foreground" aria-label={t("props.set", { name: prop.name })}>{t("props.empty")}</ShadcnButton>
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
    case "relation":
      return <RelationField item={item} prop={prop} autoOpen={autoFocus} />;
    case "computed": {
      const c = prop.computed;
      if (c?.fn === "count") return <span className="tabular-nums text-muted-foreground">{ix.countDescendants(item.id, c.of)}</span>;
      const p = ix.progress(item.id, c?.of);
      return p.total ? (
        <span className="flex w-full max-w-64 items-center gap-2">
          <Progress done={p.done} total={p.total} className="flex-1" />
          <span className="text-xs tabular-nums text-muted-foreground">
            {p.done}/{p.total}
          </span>
        </span>
      ) : (
        <span className="text-faint">–</span>
      );
    }
  }
  return null;
}

/** A start–end date: empty it is one quiet "–" like every empty field; a click shows both dates. */
function RangeField({ value, name, autoFocus, onChange }: { value: string; name: string; autoFocus?: boolean; onChange: (v: string) => void }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(!!autoFocus);
  const [a, b] = value ? [value.split("/")[0] ?? "", value.split("/")[1] ?? ""] : ["", ""];
  const put = (x: string, y: string) => onChange(x || y ? `${x}/${y}` : "");
  if (!value && !open)
    return (
      <ShadcnButton variant="plain" size="none" type="button" onClick={() => setOpen(true)} className="tap-y -ml-1 rounded px-1 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("props.set", { name })}>
        {t("props.empty")}
      </ShadcnButton>
    );
  // set: read as one line ("1. März 2026 – 30. Juni 2027"), a click opens both dates
  if (!open) {
    const long = (d: string) => (d ? fmtDate(lang, d, { day: "numeric", month: "long", year: "numeric" }) : "…");
    return (
      <ShadcnButton variant="plain" size="none" type="button" onClick={() => setOpen(true)} className="tap-y -ml-1 rounded px-1 text-left tabular-nums hover:bg-hover" aria-label={t("props.set", { name })}>
        {long(a)} – {long(b)}
      </ShadcnButton>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      <DateField value={a || undefined} label={t("props.start")} autoFocus={open} onChange={(x) => put(x, b)} />
      <span className="text-faint">–</span>
      <DateField value={b || undefined} label={t("props.end")} onChange={(x) => put(a, x)} />
    </span>
  );
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
    else repo.setRel(id, prop.id, item.id, false); // symmetric: stored on the other side
  };
  return (
    <>
      {ids.map((id) => {
        const x = ix.get(id)!;
        return (
          <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-1.5 pr-0.5 text-xs">
            <ItemLink item={x} className="min-w-0" />
            {!fits(x) && <span title={t("props.notTarget", { target: prop.target })} className="text-warn"><AlertTriangle size={11} /></span>}
            <ShadcnButton variant="plain" size="none" onClick={() => remove(id)} className="rounded px-1 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("props.removeValue")}>
              <X size={11} />
            </ShadcnButton>
          </span>
        );
      })}
      {/* empty: the same quiet "–" as every empty field; with values and several allowed: "+" */}
      {!ids.length ? (
        <ShadcnButton variant="plain" size="none" type="button" onClick={() => setPicking(true)} className="tap-y -ml-1 rounded px-1 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("props.set", { name: prop.name })}>
          {t("props.empty")}
        </ShadcnButton>
      ) : (
        prop.multiple && <AddButton onClick={() => setPicking(true)} aria-label={t("props.set", { name: prop.name })} />
      )}
      {picking && (
        <ItemPicker
          title={prop.name}
          suggestions={ix.live.filter((x) => target && x.id !== item.id && fits(x) && !ids.includes(x.id)).slice(0, 8).map((x) => ({ id: x.id, reason: "target" as const }))}
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

// ---------- free properties ----------

function FreeField({ value, onChange, name, options }: { value: FreeValue; onChange: (v: FreeValue | null) => void; name: string; options?: string[] }) {
  const { t, lang } = useT();
  const k = value.k;
  if (k === "checkbox") return <Checkbox checked={value.v === true} onCheckedChange={(checked) => onChange({ k, v: checked === true })} aria-label={name} className="size-4" />;
  if (k === "date") return <DateField value={String(value.v ?? "") || undefined} label={name} onChange={(x) => onChange(x ? { k, v: x } : null)} />;
  if (k === "number")
    return <InlineText value={typeof value.v === "number" ? numberText(lang, value.v) : String(value.v)} onCommit={(x) => { const n = parseNumber(lang, x); onChange(n === undefined ? null : { k, v: n }); }} label={name} className="text-sm tabular-nums" />;
  if (k === "select")
    return (
      <>
        <Input list={`opts-${name}`} defaultValue={String(value.v)} onBlur={(e) => onChange(e.target.value.trim() ? { k, v: e.target.value.trim() } : null)} aria-label={name} className="field w-40 rounded-md bg-transparent px-1 text-sm outline-none hover:bg-hover" />
        <datalist id={`opts-${name}`}>{options?.map((o) => <option key={o} value={o} />)}</datalist>
      </>
    );
  return <InlineText value={String(value.v ?? "")} onCommit={(x) => onChange(x.trim() ? { k, v: x.trim() } : null)} placeholder={t("props.empty")} label={name} className="text-sm" />;
}

function freeOptions(name: string): string[] {
  const set = new Set<string>();
  for (const i of repo.live()) {
    const v = Object.entries(i.extra).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
    if (v?.k === "select") set.add(String(v.v));
  }
  return [...set].sort();
}

// ---------- the property block of a page ----------

/** One row of the block: label 13 muted (one line, the name as tooltip when cut), value beside it. */
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

/** What the page puts around its badges: the type in front, the languages behind, the progress under the dates. */
interface PageHead {
  first?: React.ReactNode;
  last?: React.ReactNode;
  progress?: React.ReactNode;
}

/** Status and selections read by themselves as badges; dates by their icon. They need no label. */
const isBadge = (p: PropDef) => p.kind === "status" || p.kind === "select";

/**
 * The properties of a page under the title (design rules § 2.2). First a row of badges – the
 * type, then status and selections in the type's order –, under it the dates, under them the
 * progress. The rest follows with its name: the type's properties in their order, free ones,
 * the other side of relations ("Blockiert diese"), last the tags. "+ Eigenschaft" offers the
 * empty ones, a new free one and a tag.
 */
export function PropertyBlock({ item, schema, noAdd, head = {} }: { item: Item; schema?: TypeSchema; noAdd?: boolean; head?: PageHead }) {
  const { t } = useT();
  const ix = useIndex();
  // empty properties opened from "+ Eigenschaft" stay while on this page
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [tagging, setTagging] = useState(false);
  const visible = schema ? visibleProps(item, schema, ix, opened).filter((p) => !(p.kind === "computed" && p.computed?.fn !== "count")) : [];
  const badges = visible.filter(isBadge);
  const dates = visible.filter((p) => p.kind === "date");
  const shown = visible.filter((p) => !isBadge(p) && p.kind !== "date");
  const empty = schema ? schema.properties.filter((p) => p.kind !== "computed" && !visible.some((x) => x.id === p.id)) : [];
  const leftovers = schema ? schema.removedProperties.filter((p) => item.props[p.id] !== undefined || item.rels[p.id]?.length) : [];
  const inverse = inverseGroups(item, ix, t);
  const free = Object.entries(item.extra);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<FreeKind>("text");
  const addFree = () => {
    const n = name.trim();
    if (!n) return;
    repo.setExtra(item.id, n, { k: kind, v: kind === "checkbox" ? true : kind === "number" ? 0 : kind === "date" ? todayISO() : "…" });
    setName("");
    setAdding(false);
  };
  // an empty badge or date waits for the pointer, like "+ Eigenschaft" (unless just opened)
  const quiet = (p: PropDef) => !hasValue(item, p, ix) && !opened.has(p.id) && "opacity-0 transition-opacity group-hover/props:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100";
  const rows = shown.length || free.length || inverse.length || item.tags.length || leftovers.length || tagging;
  if (!rows && !badges.length && !dates.length && !head.first && !head.last && !head.progress && noAdd) return null;
  return (
    <div className="group/props">
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {head.first}
        {badges.map((p) => (
          <span key={p.id} className={cx("inline-flex", quiet(p))}>
            {p.kind === "status" ? <StatusBadge item={item} /> : <SelectBadge item={item} prop={p} />}
          </span>
        ))}
        {head.last}
      </div>
      {dates.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          {dates.map((p) => (
            <span key={p.id} className={cx("inline-flex items-center gap-1.5", quiet(p))} title={p.description || p.name}>
              <CalendarDays size={15} className="shrink-0 text-muted-foreground" aria-hidden />
              {/* the name only where the icon alone does not say which date it is */}
              {(dates.length > 1 || !hasValue(item, p, ix)) && <span className="text-muted-foreground">{p.name}</span>}
              <PropertyField item={item} prop={p} autoFocus={focus === p.id} />
            </span>
          ))}
        </div>
      )}
      {head.progress}
      <div className={cx("-mx-1.5 grid grid-cols-[160px_minmax(0,1fr)] gap-x-1 max-md:grid-cols-[124px_minmax(0,1fr)]", rows ? "mt-4" : "mt-2")}>
      {shown.map((p) => (
        <BlockRow key={p.id} label={p.name} title={p.description || p.name}>
          <PropertyField item={item} prop={p} autoFocus={focus === p.id} />
        </BlockRow>
      ))}
      {free.map(([n, v]) => (
        <BlockRow key={"free:" + n} label={n}>
          <FreeField value={v} name={n} options={v.k === "select" ? freeOptions(n) : undefined} onChange={(x) => repo.setExtra(item.id, n, x)} />
          <ShadcnButton variant="plain" size="none" onClick={() => repo.setExtra(item.id, n, null)} className="tap ml-auto rounded p-0.5 text-faint opacity-0 pointer-coarse:opacity-100 hover:bg-hover hover:text-fg group-hover:opacity-100 focus:opacity-100" aria-label={t("props.removeFree", { name: n })}>
            <X size={12} />
          </ShadcnButton>
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
          <Popover trigger={(pp) => <ShadcnButton variant="plain" size="none" {...pp} className="tap rounded p-0.5 text-faint hover:bg-hover" aria-label={t("more")}><ArrowRightLeft size={12} /></ShadcnButton>}>
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close();
                    const fv = toFree(p, item.props[p.id]);
                    if (fv) repo.setExtra(item.id, p.name, fv);
                    for (const r of item.rels[p.id] ?? []) repo.setMember(item.id, "refs", r, true);
                    repo.setProp(item.id, p.id, null);
                  }}
                >
                  {t("props.toFree")}
                </MenuItem>
                <MenuItem danger icon={<Trash2 size={13} />} onClick={() => (close(), repo.setProp(item.id, p.id, null))}>
                  {t("props.removeValue")}
                </MenuItem>
              </>
            )}
          </Popover>
        </BlockRow>
      ))}
      {(item.tags.length > 0 || tagging) && (
        <BlockRow label={t("item.tags")}>
          {item.tags.map((tag) => (
            <Tag key={tag} tag={tag} href={`#/search?q=${encodeURIComponent("#" + tag)}`} onRemove={() => repo.setMember(item.id, "tags", tag, false)} />
          ))}
          <TagInput exclude={item.tags} start={tagging} onAdd={(tag) => (repo.setMember(item.id, "tags", tag, true), setTagging(false))} onCancel={() => setTagging(false)} />
        </BlockRow>
      )}
      {!noAdd && (
        <div className="col-span-2">
          {adding ? (
            <div className="flex flex-wrap items-center gap-2 py-1">
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" && addFree(), e.key === "Escape" && setAdding(false))} placeholder={t("props.name")} className="w-36 rounded-md border border-line bg-bg px-2 py-1 text-sm outline-none" />
              <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as FreeKind)} className="rounded-md border border-line bg-bg px-1.5 py-1 text-sm" aria-label={t("props.kind")}>
                {FREE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t("kind.prop." + k)}
                  </option>
                ))}
              </NativeSelect>
              <ShadcnButton variant="plain" size="none" onClick={addFree} className="rounded-md bg-ink px-2 py-1 text-xs text-ink-text">
                {t("props.add")}
              </ShadcnButton>
              <ShadcnButton variant="plain" size="none" onClick={() => setAdding(false)} className="text-xs text-muted-foreground">
                {t("cancel")}
              </ShadcnButton>
            </div>
          ) : (
            <Popover
              trigger={(pp) => (
                // quiet until the pointer is over the properties (always there on touch screens)
                <ShadcnButton
                  variant="plain"
                  size="none"
                  {...pp}
                  className="tap-y flex h-[34px] w-fit items-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground opacity-0 transition-opacity hover:bg-hover hover:text-fg focus:opacity-100 group-hover/props:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
                >
                  <Plus size={15} /> {t("props.addProperty")}
                </ShadcnButton>
              )}
            >
              {(close) => (
                <>
                  {empty.map((p) => (
                    <MenuItem key={p.id} onClick={() => (close(), setOpened(new Set([...opened, p.id])), setFocus(p.id))}>
                      {p.name}
                    </MenuItem>
                  ))}
                  {!item.tags.length && <MenuItem onClick={() => (close(), setTagging(true))}>{t("props.tag")}</MenuItem>}
                  {(empty.length > 0 || !item.tags.length) && <div className="my-1 border-t border-line" />}
                  <MenuItem onClick={() => (close(), setAdding(true))}>{t("props.newFree")}</MenuItem>
                </>
              )}
            </Popover>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

/** The status as a badge; a click picks another. */
function StatusBadge({ item }: { item: Item }) {
  const { t } = useT();
  const ix = useIndex();
  const st = statusOf(item, ix.schemaOf(item));
  if (!st) return null;
  return (
    <StatusMenu
      item={item}
      trigger={(p) => (
        <ShadcnButton variant="plain" size="none" {...p} className="tap-y inline-flex" aria-label={t("row.status", { name: st.option.name })}>
          <StatusPill option={st.option} group={st.group} />
        </ShadcnButton>
      )}
    />
  );
}

/**
 * A selection as a badge that says what it is: "Prio hoch" for the priority, otherwise the
 * property's name before the value ("Phase Entwurf"). Empty: the name, dashed, to pick one.
 */
function SelectBadge({ item, prop }: { item: Item; prop: PropDef }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const v = item.props[prop.id];
  const opt = prop.options?.find((o) => o.id === v);
  const prio = priorityProp(ix.schemaOf(item))?.id === prop.id;
  const label = !opt ? null : prio ? t("props.prioBadge", { value: lang === "de" ? opt.name.toLocaleLowerCase("de") : opt.name }) : (
    <>
      <span className="opacity-70">{prop.name}</span> {opt.name}
    </>
  );
  return (
    <Popover
      trigger={(p) => (
        <ShadcnButton variant="plain" size="none" {...p} className="tap-y inline-flex" aria-label={t("props.set", { name: prop.name })} title={prop.description || prop.name}>
          {opt ? (
            <StatusPill option={opt} label={label} />
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted-foreground hover:text-fg">
              <Plus size={11} /> {prop.name}
            </span>
          )}
        </ShadcnButton>
      )}
    >
      {(close) => (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">{prop.name}</p>
          {prop.options?.map((o) => (
            <MenuItem key={o.id} active={o.id === v} onClick={() => (close(), repo.setProp(item.id, prop.id, o.id))}>
              <StatusPill option={o} />
            </MenuItem>
          ))}
          {opt && (
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

/** Other entries' relations pointing here, under the relation's inverse name ("Blockiert diese"). */
function inverseGroups(item: Item, ix: Index, t: T): { label: string; ids: string[] }[] {
  const groups = new Map<string, { label: string; ids: string[] }>();
  for (const b of ix.backlinks(item.id)) {
    if (b.kind !== "rel") continue;
    const from = ix.get(b.from);
    if (!from) continue;
    const p = ix.schemaOf(from)?.properties.find((x) => x.id === b.prop);
    if (!p || p.symmetric) continue;
    const label = p.inverseName || t("props.inverse", { prop: p.name, type: ix.typeName(from.type) ?? "" });
    const g = groups.get(label) ?? { label, ids: [] };
    if (!g.ids.includes(from.id)) g.ids.push(from.id);
    groups.set(label, g);
  }
  return [...groups.values()];
}
