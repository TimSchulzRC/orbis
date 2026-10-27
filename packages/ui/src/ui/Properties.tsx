// Properties of an item: those its type defines, free ones, and values of removed
// properties ("Weitere Eigenschaften") – schema changes never delete values.
import { useState } from "react";
import { X, Plus, ExternalLink, AlertTriangle, Trash2, ArrowRightLeft } from "lucide-react";
import { type FreeKind, type FreeValue, type Item, type PropDef, type TypeSchema, type Value, FREE_KINDS, todayISO } from "@obtion/core/model";
import { fmtDate, fmtNumber } from "@obtion/core/i18n";
import { parseQuery, matches } from "@obtion/core/query";
import { doneAt, statusProp } from "@obtion/core/traits";
import { toFree } from "@obtion/core/typeops";
import { repo } from "../repo";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { DateField, InlineText, ItemLink, MenuItem, Popover, Progress, StatusPill, Tag, cx, GROUP_COLOR, AddButton } from "./bits";
import { TagInput } from "./TagInput";
import { ItemPicker } from "./Picker";
import { setStatus } from "./Row";

function Row({ label, children, title }: { label: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <>
      {/* label and value share the row height (44 px to tap on touch screens) */}
      <div className="tap-row flex items-start py-1 text-sm text-muted pointer-coarse:items-center pointer-coarse:py-0" title={title}>
        <span className="truncate">{label}</span>
      </div>
      <div className="tap-row flex min-h-7 min-w-0 flex-wrap items-center gap-1.5 py-0.5 text-sm">{children}</div>
    </>
  );
}

const grid = "grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[8.5rem_minmax(0,1fr)]";

export { hasValue, visibleProps } from "@obtion/core/traits";
import { visibleProps } from "@obtion/core/traits";

export function Properties({ item, schema, compact, all, opened, focus }: { item: Item; schema: TypeSchema; compact?: boolean; all?: boolean; opened?: Set<string>; focus?: string }) {
  const { t } = useT();
  const ix = useIndex();
  const leftovers = schema.removedProperties.filter((p) => item.props[p.id] !== undefined || item.rels[p.id]?.length);
  const props = all ? schema.properties : visibleProps(item, schema, ix, opened ?? new Set());
  return (
    <div className={cx(compact ? "" : "mt-4", grid)}>
      {props.map((p) => (
        <Row key={p.id} label={p.name} title={p.description}>
          <PropertyField item={item} prop={p} autoFocus={focus === p.id} />
        </Row>
      ))}
      {leftovers.length > 0 && (
        <>
          <div className="col-span-2 mt-2 text-xs font-medium text-muted">{t("props.more")}</div>
          {leftovers.map((p) => (
            <Row key={p.id} label={p.name}>
              <span className="text-muted">{displayValue(item, p)}</span>
              <Popover trigger={(pp) => <button {...pp} className="tap rounded p-0.5 text-muted hover:bg-hover" aria-label={t("more")}><ArrowRightLeft size={12} /></button>}>
                {(close) => (
                  <>
                    <MenuItem
                      onClick={() => {
                        close();
                        const fv = toFree(p, item.props[p.id], repo.index());
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
            </Row>
          ))}
        </>
      )}
    </div>
  );
}

function displayValue(item: Item, p: PropDef): string {
  const v = item.props[p.id];
  const ix = repo.index();
  if (item.rels[p.id]?.length) return item.rels[p.id]!.map((id) => ix.get(id)?.title ?? id).join(", ");
  if (v === undefined) return "";
  if (p.options) return (Array.isArray(v) ? v : [v]).map((id) => p.options!.find((o) => o.id === id)?.name ?? String(id)).join(", ");
  return String(v);
}

export function numberValue(s: string): number | undefined {
  const n = Number(s.trim().replace(/\s/g, "").replace(",", "."));
  return s.trim() === "" || isNaN(n) ? undefined : n;
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
            <a href={v} target="_blank" rel="noopener" className="text-muted hover:text-fg" aria-label={t("props.openLink")}>
              <ExternalLink size={13} />
            </a>
          )}
        </span>
      );
    case "number":
      return (
        <InlineText
          value={typeof v === "number" ? fmtNumber(lang, v).replace(/\./g, lang === "de" ? "" : ".") : ""}
          onCommit={(x) => set(numberValue(x) ?? null)}
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
      return <input type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked ? true : null)} aria-label={prop.name} className="size-4 accent-[var(--focus)]" />;
    case "select":
    case "status": {
      const opt = prop.options?.find((o) => o.id === v);
      const done = prop.kind === "status" ? doneAt(item, ix.schemaOf(item)) : undefined;
      return (
        <>
        <label className="tap-row relative inline-flex cursor-pointer items-center">
          {opt ? <StatusPill option={opt} /> : <span className="text-muted">{t("props.empty")}</span>}
          <select
            value={String(v ?? "")}
            onChange={(e) => (prop.kind === "status" && e.target.value ? void setStatus(item, e.target.value) : set(e.target.value || null))}
            aria-label={prop.name}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            {prop.kind !== "status" && <option value="">–</option>}
            {prop.kind === "status"
              ? (["todo", "active", "done"] as const).map((g) => (
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
          </select>
        </label>
        {done && <span className="text-xs tabular-nums text-muted">{t("props.doneOn", { date: fmtDate(lang, todayISO(new Date(done))) })}</span>}
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
                <button onClick={() => set(ids.filter((x) => x !== id))} className="text-muted hover:text-fg" aria-label={t("props.removeValue")}>
                  <X size={11} />
                </button>
              </span>
            );
          })}
          <Popover
            trigger={(p) =>
              ids.length ? (
                <button {...p} className="tap rounded-md px-1 text-xs text-muted hover:bg-hover" aria-label={t("props.set", { name: prop.name })}><Plus size={12} /></button>
              ) : (
                <button {...p} className="tap-y -ml-1 rounded px-1 text-faint hover:bg-hover hover:text-muted" aria-label={t("props.set", { name: prop.name })}>{t("props.empty")}</button>
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
      if (c?.fn === "count") return <span className="tabular-nums text-muted">{ix.countDescendants(item.id, c.of)}</span>;
      const p = ix.progress(item.id, c?.of);
      return p.total ? (
        <span className="flex w-full max-w-64 items-center gap-2">
          <Progress done={p.done} total={p.total} className="flex-1" />
          <span className="text-xs tabular-nums text-muted">
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
      <button type="button" onClick={() => setOpen(true)} className="tap-y -ml-1 rounded px-1 text-muted hover:bg-hover hover:text-fg" aria-label={t("props.set", { name })}>
        {t("props.empty")}
      </button>
    );
  // set: read as one line ("1. März 2026 – 30. Juni 2027"), a click opens both dates
  if (!open) {
    const long = (d: string) => (d ? fmtDate(lang, d, { day: "numeric", month: "long", year: "numeric" }) : "…");
    return (
      <button type="button" onClick={() => setOpen(true)} className="tap-y -ml-1 rounded px-1 text-left tabular-nums hover:bg-hover" aria-label={t("props.set", { name })}>
        {long(a)} – {long(b)}
      </button>
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
            <button onClick={() => remove(id)} className="rounded px-1 text-muted hover:bg-hover hover:text-fg" aria-label={t("props.removeValue")}>
              <X size={11} />
            </button>
          </span>
        );
      })}
      {/* empty: the same quiet "–" as every empty field; with values and several allowed: "+" */}
      {!ids.length ? (
        <button type="button" onClick={() => setPicking(true)} className="tap-y -ml-1 rounded px-1 text-muted hover:bg-hover hover:text-fg" aria-label={t("props.set", { name: prop.name })}>
          {t("props.empty")}
        </button>
      ) : (
        prop.multiple && <AddButton onClick={() => setPicking(true)} aria-label={t("props.set", { name: prop.name })} />
      )}
      {picking && (
        <ItemPicker
          title={prop.name}
          suggestions={ix.live.filter((x) => target && x.id !== item.id && fits(x) && !ids.includes(x.id)).slice(0, 8).map((x) => ({ id: x.id, reason: "target" as any }))}
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

export function FreeField({ value, onChange, name, options }: { value: FreeValue; onChange: (v: FreeValue | null) => void; name: string; options?: string[] }) {
  const { t, lang } = useT();
  const k = value.k;
  if (k === "checkbox") return <input type="checkbox" checked={value.v === true} onChange={(e) => onChange({ k, v: e.target.checked })} aria-label={name} className="size-4 accent-[var(--focus)]" />;
  if (k === "date") return <DateField value={String(value.v ?? "") || undefined} label={name} onChange={(x) => onChange(x ? { k, v: x } : null)} />;
  if (k === "number")
    return <InlineText value={typeof value.v === "number" ? String(value.v).replace(".", lang === "de" ? "," : ".") : String(value.v)} onCommit={(x) => onChange(numberValue(x) === undefined ? null : { k, v: numberValue(x)! })} label={name} className="text-sm tabular-nums" />;
  if (k === "select")
    return (
      <>
        <input list={`opts-${name}`} defaultValue={String(value.v)} onBlur={(e) => onChange(e.target.value.trim() ? { k, v: e.target.value.trim() } : null)} aria-label={name} className="field w-40 rounded-md bg-transparent px-1 text-sm outline-none hover:bg-hover" />
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

// ---------- the property block of a page ----------

/** One row of the block: label 13 muted (one line, the name as tooltip when cut), value beside it. */
function BlockRow({ label, title, children }: { label: React.ReactNode; title?: string; children: React.ReactNode }) {
  return (
    <>
      <div className="flex min-h-8 items-center truncate text-[13px] text-muted pointer-coarse:min-h-11" title={title ?? (typeof label === "string" ? label : undefined)}>
        <span className="truncate">{label}</span>
      </div>
      <div className="group flex min-h-8 min-w-0 flex-wrap items-center gap-1.5 text-sm pointer-coarse:min-h-11">{children}</div>
    </>
  );
}

/**
 * The properties of a page as one block under the title (design rules § 2.2): the type's
 * properties in their order – without the status (it stands in the type line) and without
 * progress (the band) –, then free properties, then the other side of relations ("Blockiert
 * diese"), last the tags if any. "+ Eigenschaft" offers the empty ones, a new free one and a tag.
 */
export function PropertyBlock({ item, schema, noAdd }: { item: Item; schema?: TypeSchema; noAdd?: boolean }) {
  const { t } = useT();
  const ix = useIndex();
  // empty properties opened from "+ Eigenschaft" stay while on this page
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [tagging, setTagging] = useState(false);
  const status = statusProp(schema);
  const shown = schema ? visibleProps(item, schema, ix, opened).filter((p) => p.id !== status?.id && !(p.kind === "computed" && p.computed?.fn !== "count")) : [];
  const empty = schema ? schema.properties.filter((p) => p.kind !== "computed" && p.id !== status?.id && !shown.some((x) => x.id === p.id)) : [];
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
  const any = shown.length || free.length || inverse.length || item.tags.length || leftovers.length;
  if (!any && noAdd) return null;
  return (
    <div className="mt-[18px] grid grid-cols-[148px_minmax(0,1fr)] gap-x-3 max-md:grid-cols-[124px_minmax(0,1fr)]">
      {shown.map((p) => (
        <BlockRow key={p.id} label={p.name} title={p.description || p.name}>
          <PropertyField item={item} prop={p} autoFocus={focus === p.id} />
        </BlockRow>
      ))}
      {free.map(([n, v]) => (
        <BlockRow key={"free:" + n} label={n}>
          <FreeField value={v} name={n} options={v.k === "select" ? freeOptions(n) : undefined} onChange={(x) => repo.setExtra(item.id, n, x)} />
          <button onClick={() => repo.setExtra(item.id, n, null)} className="tap ml-auto rounded p-0.5 text-faint opacity-0 pointer-coarse:opacity-100 hover:bg-hover hover:text-fg group-hover:opacity-100 focus:opacity-100" aria-label={t("props.removeFree", { name: n })}>
            <X size={12} />
          </button>
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
          <span className="text-muted">{displayValue(item, p)}</span>
          <Popover trigger={(pp) => <button {...pp} className="tap rounded p-0.5 text-faint hover:bg-hover" aria-label={t("more")}><ArrowRightLeft size={12} /></button>}>
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close();
                    const fv = toFree(p, item.props[p.id], repo.index());
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
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" && addFree(), e.key === "Escape" && setAdding(false))} placeholder={t("props.name")} className="w-36 rounded-md border border-line bg-bg px-2 py-1 text-sm outline-none" />
              <select value={kind} onChange={(e) => setKind(e.target.value as FreeKind)} className="rounded-md border border-line bg-bg px-1.5 py-1 text-sm" aria-label={t("props.kind")}>
                {FREE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t("kind.prop." + k)}
                  </option>
                ))}
              </select>
              <button onClick={addFree} className="rounded-md bg-ink px-2 py-1 text-xs text-ink-text">
                {t("props.add")}
              </button>
              <button onClick={() => setAdding(false)} className="text-xs text-muted">
                {t("cancel")}
              </button>
            </div>
          ) : (
            <Popover
              trigger={(pp) => (
                <button {...pp} className="tap-y -ml-1 flex h-7 w-fit items-center gap-1 rounded-md px-1 text-[13px] text-muted hover:bg-hover hover:text-fg">
                  <Plus size={13} /> {t("props.addFree")}
                </button>
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
  );
}

/** Other entries' relations pointing here, under the relation's inverse name ("Blockiert diese"). */
function inverseGroups(item: Item, ix: ReturnType<typeof useIndex>, t: (k: string, v?: Record<string, unknown>) => string): { label: string; ids: string[] }[] {
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

export { GROUP_COLOR, fmtDate };
