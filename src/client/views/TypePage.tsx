// A type's page: the list of its entries with views as tabs (like a database in Notion). Behind
// "…" › "Typ bearbeiten": identity, description (the agent reads it), properties and capabilities –
// a type is an information with a schema; changing it is editing, not programming.
import { useEffect, useState } from "react";
import { MoreHorizontal, Plus, Trash2, GripVertical, ArrowUp, ArrowDown, Layers, Tag as TagIcon, X, Pencil, RotateCcw } from "lucide-react";
import {
  type Item,
  type OptionDef,
  type PropDef,
  type PropKind,
  type StatusGroup,
  PROP_KINDS,
  STATUS_GROUPS,
  removeProp,
  setCapability,
  setMeta,
  setSchemaField,
  setTabs,
  shortId,
  upsertProp,
} from "../../shared/model";
import { COLORS, ICONS } from "../../shared/palette";
import { keyBetween } from "../../shared/sortkey";
import { parseQuery, printQuery, runQuery } from "../../shared/query";
import { type DeleteMode, deleteType, previewTagToType, tagToType, typeUsage } from "../../shared/typeops";
import { useIndex, useRoute, go } from "../hooks";
import { repo } from "../repo";
import { useT } from "../i18n";
import { Button, Dialog, InlineText, ItemIcon, MenuItem, Popover, SectionTitle, Seg, TypeGlyph, cx, pal, AddButton, IconButton } from "../ui/bits";
import { ICON } from "../ui/icons";
import { TypeList } from "./Lists";
import { notify } from "../ui/feedback";
import { createType } from "../actions";

export function TypePage({ item }: { item: Item }) {
  const { t } = useT();
  const ix = useIndex();
  const route = useRoute();
  const [editing, setEditing] = useState(route.query.get("edit") === "1");
  const plural = ix.typePlural(item.id);
  useEffect(() => void (document.title = plural), [plural]);
  if (item.deleted)
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center text-muted">
        {t("type.isDeleted", { name: item.schema!.name })}
      </div>
    );
  return (
    <div className="page-wide">
      <div className="mb-4 flex items-center gap-3">
        <TypeGlyph schema={item.schema} size={22} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="page-title truncate">{plural}</h1>
          <span className="text-[15px] tabular-nums text-muted">{ix.itemsOfType(item.id).length}</span>
        </div>
        <Popover align="right" trigger={(p) => <IconButton {...p} label={t("more")} icon={MoreHorizontal} />}>
          {(close) => (
            <>
              <MenuItem icon={<Pencil size={14} />} onClick={() => (close(), setEditing(!editing))}>
                {t("type.edit")}
              </MenuItem>
              <MenuItem icon={<RotateCcw size={14} />} onClick={() => (close(), repo.change(item.id, (d) => setTabs(d, [])), notify(t("type.viewsReset")))}>
                {t("type.resetViews")}
              </MenuItem>
            </>
          )}
        </Popover>
      </div>
      {editing && <TypeEditor item={item} onClose={() => setEditing(false)} />}
      <TypeList type={item} />
    </div>
  );
}

/** "Typ bearbeiten": name, plural, symbol, description, properties, capabilities – above the list. */
function TypeEditor({ item, onClose }: { item: Item; onClose: () => void }) {
  const { t } = useT();
  const ix = useIndex();
  const s = item.schema!;
  const [sel, setSel] = useState<string | undefined>(s.properties[0]?.id);
  const [dialog, setDialog] = useState<null | "delete" | "fromTag" | "toTag">(null);
  const change = (fn: (doc: any) => void) => repo.change(item.id, fn);
  const selected = s.properties.find((p) => p.id === sel);

  return (
    <div className="@container mb-6 rounded-xl border border-line bg-surface p-4 md:p-5">
      <div className="flex items-start gap-3">
        <Popover
          trigger={(p) => (
            <button {...p} className="tap mt-1 rounded-lg p-1.5 hover:bg-hover" aria-label={t("type.icon")}>
              <TypeGlyph schema={s} size={24} />
            </button>
          )}
        >
          {(close) => (
            <div className="w-72 p-1">
              <div className="grid grid-cols-8 gap-1">
                {ICONS.map((n) => {
                  const I = ICON[n] ?? ICON.circle!;
                  return (
                    <button key={n} onClick={() => (change((d) => setSchemaField(d, "icon", n)), close())} className={cx("tap rounded-md p-1.5 hover:bg-hover", s.icon === n && "bg-hover")} aria-label={n}>
                      <I size={16} style={{ color: pal(s.color) }} />
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
                {COLORS.map((c) => (
                  <button key={c} onClick={() => change((d) => setSchemaField(d, "color", c))} className={cx("size-6 rounded-full border-2", s.color === c ? "border-fg" : "border-transparent")} style={{ background: pal(c) }} aria-label={c} />
                ))}
              </div>
            </div>
          )}
        </Popover>
        <div className="min-w-0 flex-1">
          <InlineText
            value={s.name}
            label={t("type.name")}
            onCommit={(v) => v.trim() && change((d) => (setSchemaField(d, "name", v.trim()), setMeta(d, { title: v.trim() })))}
            className="text-2xl font-semibold tracking-tight"
            large
          />
          <label className="mt-1 flex items-center gap-2 text-sm text-muted">
            {t("type.plural")}
            <input
              key={item.id + (s.plural ?? "")}
              defaultValue={ix.typePlural(item.id)}
              onBlur={(e) => e.target.value.trim() !== ix.typePlural(item.id) && change((d) => setSchemaField(d, "plural", e.target.value.trim()))}
              className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-0.5 text-sm text-fg outline-none focus:border-[var(--focus)]"
            />
          </label>
        </div>
        <Popover align="right" trigger={(p) => <IconButton {...p} label={t("more")} icon={MoreHorizontal} />}>
          {(close) => (
            <>
              <MenuItem icon={<TagIcon size={14} />} onClick={() => (close(), setDialog("fromTag"))}>
                {t("type.fromTag")}
              </MenuItem>
              <MenuItem icon={<TagIcon size={14} />} onClick={() => (close(), setDialog("toTag"))}>
                {t("type.toTag")}
              </MenuItem>
              <MenuItem danger icon={<Trash2 size={14} />} onClick={() => (close(), setDialog("delete"))}>
                {t("type.delete")}
              </MenuItem>
            </>
          )}
        </Popover>
        <IconButton icon={X} label={t("view.closeSettings")} onClick={onClose} />
      </div>

      <label className="mt-5 block">
        <span className="text-xs font-medium text-muted">{t("type.description")}</span>
        <textarea
          key={item.id}
          defaultValue={s.description}
          onBlur={(e) => e.target.value !== s.description && change((d) => setSchemaField(d, "description", e.target.value))}
          rows={3}
          className="mt-1 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-[var(--focus)]"
        />
      </label>

      <div className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section>
          <SectionTitle right={<AddProperty item={item} onAdded={setSel} />}>{t("type.properties")}</SectionTitle>
          <div className="rounded-xl border border-line bg-surface p-1">
            {s.properties.map((p, i) => (
              <div key={p.id}>
              <div className={cx("group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-hover", p.id === sel && "bg-selected")}>
                <GripVertical size={14} className="text-muted" />
                <button onClick={() => setSel(p.id)} className="tap-row flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="truncate font-medium">{p.name}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{t("kind.prop." + p.kind)}</span>
                </button>
                {/* on touch screens only on the selected row: no invisible buttons to hit */}
                <span className={cx("flex opacity-0 group-hover:opacity-100", p.id === sel ? "opacity-100" : "pointer-coarse:hidden")}>
                  <button disabled={i === 0} onClick={() => change((d) => upsertProp(d, p.id, { sort: keyBetween(s.properties[i - 2]?.sort ?? null, s.properties[i - 1]!.sort) }))} className="tap rounded p-0.5 text-muted hover:text-fg disabled:opacity-30" aria-label={t("type.up")}>
                    <ArrowUp size={12} />
                  </button>
                  <button disabled={i === s.properties.length - 1} onClick={() => change((d) => upsertProp(d, p.id, { sort: keyBetween(s.properties[i + 1]!.sort, s.properties[i + 2]?.sort ?? null) }))} className="tap rounded p-0.5 text-muted hover:text-fg disabled:opacity-30" aria-label={t("type.down")}>
                    <ArrowDown size={12} />
                  </button>
                </span>
              </div>
              {/* narrow: the settings open right below the chosen property, not under the capabilities */}
              {p.id === sel && <div className="px-1 pb-2 pt-1 @3xl:hidden">{selected && <PropEditor item={item} prop={selected} />}</div>}
              </div>
            ))}
            {!s.properties.length && <p className="px-2 py-2 text-sm text-muted">{t("type.noProps")}</p>}
          </div>
          <Capabilities item={item} />
        </section>
        <section className="hidden @3xl:block">{selected ? <PropEditor item={item} prop={selected} /> : null}</section>
      </div>

      {dialog === "delete" && <DeleteTypeDialog item={item} onClose={() => setDialog(null)} />}
      {dialog === "toTag" && <DeleteTypeDialog item={item} onClose={() => setDialog(null)} toTag />}
      {dialog === "fromTag" && <FromTagDialog item={item} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ---------- properties ----------

function AddProperty({ item, onAdded }: { item: Item; onAdded: (id: string) => void }) {
  const { t } = useT();
  const ix = useIndex();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PropKind>("text");
  // Same name on another type: offer to copy its settings (the types stay independent).
  const twins = name.trim()
    ? [...ix.types.values()].flatMap((tp) => (tp.id === item.id ? [] : tp.schema!.properties.filter((p) => p.name.toLowerCase() === name.trim().toLowerCase()).map((p) => ({ tp, p }))))
    : [];
  const add = (copy?: PropDef) => {
    if (!name.trim()) return;
    const id = shortId("p");
    const { id: _i, sort: _s, ...rest } = copy ?? ({ id: "", sort: "", name: "", kind } as PropDef);
    // options get fresh ids? No: keeping them lets queries by option name and conversions work the same.
    repo.change(item.id, (d) => {
      upsertProp(d, id, { ...rest, name: name.trim(), kind: copy ? copy.kind : kind, options: copy?.options ?? (kind === "status" ? defaultStatusOptions(t) : kind === "select" || kind === "multiselect" ? [] : undefined), ...(!copy && kind === "relation" ? { inverseName: t("type.inverseOf", { name: name.trim() }) } : {}) });
      // the first status property is what ticking off and "offen" use: switch the capability on with it
      if ((copy ? copy.kind : kind) === "status" && !item.schema!.capabilities.status) setCapability(d, "status", id);
    });
    onAdded(id);
    setOpen(false);
    setName("");
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="right"
      trigger={(p) => (
        <AddButton {...p}>{t("type.addProp")}</AddButton>
      )}
    >
      <div className="w-72 space-y-2 p-2">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !twins.length && add()} placeholder={t("props.name")} className="w-full rounded-md border border-line bg-bg px-2 py-1 text-sm outline-none" />
        {twins.length > 0 && (
          <div className="rounded-lg bg-surface-2 p-2 text-xs">
            <p className="mb-1 text-muted">{t("type.twins")}</p>
            {twins.map(({ tp, p }) => (
              <button key={tp.id + p.id} onClick={() => add(p)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover">
                <TypeGlyph schema={tp.schema} size={12} /> {tp.schema!.name} › {p.name} <span className="ml-auto text-muted">{t("kind.prop." + p.kind)}</span>
              </button>
            ))}
          </div>
        )}
        <select value={kind} onChange={(e) => setKind(e.target.value as PropKind)} className="w-full rounded-md border border-line bg-bg px-1.5 py-1 text-sm" aria-label={t("props.kind")}>
          {PROP_KINDS.map((k) => (
            <option key={k} value={k}>
              {t("kind.prop." + k)}
            </option>
          ))}
        </select>
        <Button variant="primary" className="w-full" onClick={() => add()} disabled={!name.trim()}>
          {twins.length ? t("type.addNew") : t("props.add")}
        </Button>
      </div>
    </Popover>
  );
}

function defaultStatusOptions(t: (k: string) => string): OptionDef[] {
  return [
    { id: shortId("st"), name: t("group.todo"), group: "todo", color: "gray" },
    { id: shortId("st"), name: t("group.active"), group: "active", color: "amber" },
    { id: shortId("st"), name: t("group.done"), group: "done", color: "green" },
  ];
}

function PropEditor({ item, prop }: { item: Item; prop: PropDef }) {
  const { t } = useT();
  const ix = useIndex();
  const set = (patch: Partial<PropDef>) => repo.change(item.id, (d) => upsertProp(d, prop.id, patch));
  const field = (label: string, inner: React.ReactNode) => (
    <div className="mt-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <div className="mt-1">{inner}</div>
    </div>
  );
  const box = "w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-[var(--focus)]";
  // no target: anything can be chosen
  const targetHits = prop.kind !== "relation" ? 0 : prop.target ? runQuery(parseQuery(prop.target, ix).def, { ix }).total : ix.live.filter((i) => i.kind === "info").length;
  const types = [...ix.types.values()];
  return (
    <div className="rounded-xl border border-line bg-surface p-4" key={prop.id}>
      <div className="flex items-center gap-2">
        <InlineText value={prop.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} className="font-semibold" label={t("props.name")} />
        <select value={prop.kind} onChange={(e) => set({ kind: e.target.value as PropKind })} className="rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs" aria-label={t("props.kind")}>
          {PROP_KINDS.map((k) => (
            <option key={k} value={k}>
              {t("kind.prop." + k)}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-xs text-muted">{t("type.kindHint")}</p>
      {field(t("type.propDescription"), <textarea key={prop.id + "d"} defaultValue={prop.description ?? ""} onBlur={(e) => set({ description: e.target.value || null as any })} rows={2} className={box} />)}
      {prop.kind !== "computed" && (
        <label className="tap-row mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!prop.hideEmpty} onChange={(e) => set({ hideEmpty: e.target.checked || (null as any) })} className="accent-[var(--focus)]" />
          <span>
            {t("type.hideEmpty")} <span className="text-xs text-muted">– {t("type.hideEmptyHint")}</span>
          </span>
        </label>
      )}
      {(prop.kind === "select" || prop.kind === "multiselect" || prop.kind === "status") && field(t("type.options"), <OptionsEditor prop={prop} onChange={(options) => set({ options })} />)}
      {prop.kind === "date" &&
        field(
          t("type.dateRange"),
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!prop.range} onChange={(e) => set({ range: e.target.checked || (null as any) })} className="accent-[var(--focus)]" /> {t("type.range")}
          </label>,
        )}
      {prop.kind === "relation" && (
        <>
          {field(
            t("type.target"),
            <TargetField key={prop.id + "t"} target={prop.target} hits={targetHits} onChange={(target) => set({ target: target || (null as any) })} />,
          )}
          {field(
            t("type.count"),
            <Seg label={t("type.count")} value={prop.multiple ? "many" : "one"} onChange={(v) => set({ multiple: v === "many" || (null as any) })} options={[{ value: "one", label: t("type.one") }, { value: "many", label: t("type.many") }]} />,
          )}
          {field(
            t("type.inverse"),
            <input key={prop.id + "i"} defaultValue={prop.inverseName ?? ""} placeholder={t("type.inverseOf", { name: prop.name })} onBlur={(e) => set({ inverseName: e.target.value.trim() || (null as any) })} className={box} />,
          )}
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!prop.symmetric} onChange={(e) => set({ symmetric: e.target.checked || (null as any) })} className="accent-[var(--focus)]" /> {t("type.symmetric")}
          </label>
        </>
      )}
      {prop.kind === "computed" && (
        <>
          {field(
            t("type.computed"),
            <Seg label={t("type.computed")} value={prop.computed?.fn ?? "progress"} onChange={(fn) => set({ computed: { ...prop.computed, fn } })} options={[{ value: "progress", label: t("type.fnProgress") }, { value: "count", label: t("type.fnCount") }]} />,
          )}
          {field(
            t("type.ofType"),
            <select value={prop.computed?.of ?? ""} onChange={(e) => set({ computed: { fn: prop.computed?.fn ?? "progress", of: e.target.value || undefined } })} className={box}>
              <option value="">{t("type.anyType")}</option>
              {types.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.schema!.name}
                </option>
              ))}
            </select>,
          )}
        </>
      )}
      <div className="mt-5 flex justify-end">
        <Button variant="danger" onClick={() => repo.change(item.id, (d) => removeProp(d, prop.id))}>
          <Trash2 size={14} /> {t("type.removeProp")}
        </Button>
      </div>
      <p className="mt-1 text-right text-xs text-muted">{t("type.removeHint")}</p>
    </div>
  );
}

function OptionsEditor({ prop, onChange }: { prop: PropDef; onChange: (o: OptionDef[]) => void }) {
  const { t } = useT();
  const opts = prop.options ?? [];
  const upd = (i: number, patch: Partial<OptionDef>) => onChange(opts.map((o, n) => (n === i ? { ...o, ...patch } : o)));
  return (
    <div className="space-y-1">
      {opts.map((o, i) => (
        <div key={o.id} className="flex items-center gap-1.5">
          <Popover trigger={(p) => <button {...p} className="size-4 shrink-0 rounded-full" style={{ background: pal(o.color ?? "gray") }} aria-label={t("type.color")} />}>
            {(close) => (
              <div className="flex w-56 flex-wrap gap-1.5 p-1">
                {COLORS.map((c) => (
                  <button key={c} onClick={() => (upd(i, { color: c }), close())} className="size-5 rounded-full" style={{ background: pal(c) }} aria-label={c} />
                ))}
              </div>
            )}
          </Popover>
          <input defaultValue={o.name} onBlur={(e) => e.target.value.trim() && e.target.value !== o.name && upd(i, { name: e.target.value.trim() })} className="field min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-sm outline-none hover:bg-hover" />
          {prop.kind === "status" && (
            <select value={o.group ?? "todo"} onChange={(e) => upd(i, { group: e.target.value as StatusGroup })} className="rounded-md border border-line bg-bg px-1 py-0.5 text-xs" aria-label={t("type.group")}>
              {STATUS_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {t("group." + g)}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => onChange(opts.filter((_, n) => n !== i))} className="text-muted hover:text-danger" aria-label={t("type.removeOption")}>
            <X size={13} />
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...opts, { id: shortId("o"), name: t("type.newOption"), group: prop.kind === "status" ? "todo" : undefined, color: "gray" }])} className="flex items-center gap-0.5 text-xs text-muted hover:text-fg">
        <Plus size={12} /> {t("type.addOption")}
      </button>
    </div>
  );
}

// ---------- capabilities ----------

function Capabilities({ item }: { item: Item }) {
  const { t } = useT();
  const ix = useIndex();
  const s = item.schema!;
  const c = s.capabilities;
  const set = <K extends keyof typeof c>(k: K, v: (typeof c)[K] | null) => repo.change(item.id, (d) => setCapability(d, k, v));
  const statusProps = s.properties.filter((p) => p.kind === "status");
  const dateProps = s.properties.filter((p) => p.kind === "date");
  const types = [...ix.types.values()];
  const sel = "tap-row rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs";
  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="flex items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
  return (
    <div className="mt-8">
      <SectionTitle>{t("caps.title")}</SectionTitle>
      <div className="divide-y divide-line rounded-xl border border-line bg-surface px-3">
        {row(
          t("caps.status"),
          t("caps.statusHint"),
          <select value={c.status ?? ""} onChange={(e) => set("status", e.target.value || null)} className={sel} aria-label={t("caps.status")}>
            <option value="">{t("caps.off")}</option>
            {statusProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>,
        )}
        {row(
          t("caps.due"),
          t("caps.dueHint"),
          <select value={c.due ?? ""} onChange={(e) => set("due", e.target.value || null)} className={sel} aria-label={t("caps.due")}>
            <option value="">{t("caps.off")}</option>
            {dateProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>,
        )}
        {row(
          t("caps.progress"),
          t("caps.progressHint"),
          <select value={c.progress ? (c.progress.of ?? "*") : ""} onChange={(e) => set("progress", e.target.value ? (e.target.value === "*" ? {} : { of: e.target.value }) : null)} className={sel} aria-label={t("caps.progress")}>
            <option value="">{t("caps.off")}</option>
            <option value="*">{t("caps.anyWithStatus")}</option>
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.schema!.name}
              </option>
            ))}
          </select>,
        )}
        {row(t("caps.updates"), t("caps.updatesHint"), <input type="checkbox" checked={!!c.updates} onChange={(e) => set("updates", e.target.checked || null)} className="size-4 accent-[var(--focus)]" aria-label={t("caps.updates")} />)}
        {row(
          t("caps.primaryChild"),
          t("caps.primaryChildHint"),
          <select value={c.primaryChild ?? ""} onChange={(e) => set("primaryChild", e.target.value || null)} className={sel} aria-label={t("caps.primaryChild")}>
            <option value="">{t("caps.off")}</option>
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.schema!.name}
              </option>
            ))}
          </select>,
        )}
        <div className="py-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={!!c.template} onChange={(e) => set("template", e.target.checked ? { body: "" } : null)} className="size-4 accent-[var(--focus)]" /> {t("caps.template")}
          </label>
          <p className="text-xs text-muted">{t("caps.templateHint")}</p>
          {c.template && (
            <textarea
              key={item.id + "tpl"}
              defaultValue={c.template.body ?? ""}
              onBlur={(e) => set("template", { ...c.template, body: e.target.value })}
              rows={4}
              placeholder={t("caps.templatePlaceholder")}
              className="mt-2 w-full resize-y rounded-lg border border-line bg-bg px-2.5 py-1.5 font-mono text-xs outline-none"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- delete / convert ----------

function DeleteTypeDialog({ item, onClose, toTag }: { item: Item; onClose: () => void; toTag?: boolean }) {
  const { t } = useT();
  const ix = useIndex();
  const s = item.schema!;
  const u = typeUsage(ix, item.id);
  const [mode, setMode] = useState<"tag" | "type" | "remove">(toTag ? "tag" : "tag");
  const [tag, setTag] = useState(s.name.toLowerCase().replace(/\s+/g, "-"));
  const others = [...ix.types.values()].filter((x) => x.id !== item.id);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  const run = () => {
    const m: DeleteMode = mode === "tag" ? { mode: "tag", tag } : mode === "type" ? { mode: "type", target } : { mode: "remove" };
    const label =
      mode === "tag" ? t("op.typeToTag", { name: s.name, tag }) : mode === "type" ? t("op.typeToType", { name: s.name, target: ix.typeName(target) }) : t("op.typeRemoved", { name: s.name });
    deleteType(repo.writer, ix, item.id, m, label, `web:${repo.device}`);
    onClose();
    go("/types");
  };
  return (
    <Dialog title={toTag ? t("type.toTagTitle", { name: s.name }) : t("type.deleteTitle", { name: s.name })} onClose={onClose}>
      <p className="text-sm">{t("type.affects", { count: u.items.length })}</p>
      <ul className="mt-2 space-y-1 text-sm text-muted">
        {u.queries.length > 0 && <li>{t("type.usedInQueries", { list: u.queries.map((q) => q.title).join(", ") })}</li>}
        {u.relations.length > 0 && <li>{t("type.usedInRelations", { list: u.relations.map((r) => r.name).join(", ") })}</li>}
        {u.progress.length > 0 && <li>{t("type.usedInProgress", { list: u.progress.map((r) => r.name).join(", ") })}</li>}
        {u.childOf.length > 0 && <li>{t("type.usedAsChild", { list: u.childOf.map((r) => r.name).join(", ") })}</li>}
      </ul>
      {!toTag && (
        <div className="mt-4">
          <Seg
            label={t("type.deleteMode")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "tag", label: t("type.modeTag") },
              { value: "type", label: t("type.modeType") },
              { value: "remove", label: t("type.modeRemove") },
            ]}
          />
        </div>
      )}
      {mode === "tag" && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          {t("type.tagName")} <input value={tag} onChange={(e) => setTag(e.target.value)} className="rounded-md border border-line bg-bg px-2 py-1 text-sm" />
        </label>
      )}
      {mode === "type" && (
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="mt-3 rounded-md border border-line bg-bg px-2 py-1 text-sm">
          {others.map((x) => (
            <option key={x.id} value={x.id}>
              {x.schema!.name}
            </option>
          ))}
        </select>
      )}
      <p className="mt-3 text-xs text-muted">{t("type.valuesKept")}</p>
      {mode !== "type" && u.inboxAfterRemove > 0 && <p className="mt-1 text-xs text-warn">{t("type.toInbox", { count: u.inboxAfterRemove })}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button variant="primary" onClick={run} disabled={(mode === "tag" && !tag.trim()) || (mode === "type" && !target)}>
          {toTag ? t("type.convert") : t("type.delete")}
        </Button>
      </div>
    </Dialog>
  );
}

function FromTagDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const { t } = useT();
  const ix = useIndex();
  const s = item.schema!;
  const [tag, setTag] = useState(s.name.toLowerCase());
  const [replace, setReplace] = useState(false);
  const [removeTag, setRemoveTag] = useState(false);
  const p = previewTagToType(ix, tag, item.id);
  const n = p.untyped.length + (replace ? p.typedOther.length : 0);
  return (
    <Dialog title={t("type.fromTagTitle")} onClose={onClose}>
      <label className="flex items-center gap-2 text-sm">
        # <input value={tag} onChange={(e) => setTag(e.target.value)} className="rounded-md border border-line bg-bg px-2 py-1 text-sm" />
      </label>
      <p className="mt-3 text-sm">{t("type.fromTagCount", { count: p.untyped.length, name: s.name, tag: tag.trim().replace(/^#/, "") })}</p>
      {p.untyped.length > 0 && (
        <details className="mt-1 text-sm">
          <summary className="tap-y cursor-pointer text-xs text-muted hover:text-fg">{t("type.fromTagShow")}</summary>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted">
            {p.untyped.slice(0, 50).map((id) => (
              <li key={id} className="flex items-center gap-1">
                <ItemIcon item={ix.get(id)!} size={11} /> {ix.get(id)!.title}
              </li>
            ))}
            {p.untyped.length > 50 && <li>…</li>}
          </ul>
        </details>
      )}
      {p.typedOther.length > 0 && (
        <div className="mt-2 rounded-lg bg-surface-2 p-2.5 text-sm">
          <p>{t("type.fromTagConflict", { count: p.typedOther.length })}</p>
          <ul className="mt-1 max-h-28 overflow-y-auto text-xs text-muted">
            {p.typedOther.slice(0, 20).map((id) => (
              <li key={id} className="flex items-center gap-1">
                <ItemIcon item={ix.get(id)!} size={11} /> {ix.get(id)!.title}
              </li>
            ))}
          </ul>
          <Seg label={t("type.conflict")} value={replace ? "replace" : "skip"} onChange={(v) => setReplace(v === "replace")} options={[{ value: "skip", label: t("type.skip") }, { value: "replace", label: t("type.replaceType") }]} />
        </div>
      )}
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={removeTag} onChange={(e) => setRemoveTag(e.target.checked)} className="accent-[var(--focus)]" /> {t("type.removeTagAfter", { tag })}
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={!n && !(removeTag && p.already.length)}
          onClick={() => {
            tagToType(repo.writer, ix, tag, item.id, { replaceTypes: replace, removeTag }, t("op.tagToType", { tag, name: s.name }), `web:${repo.device}`);
            onClose();
          }}
        >
          {t("type.convertCount", { count: n })}
        </Button>
      </div>
    </Dialog>
  );
}

export { Layers };

/**
 * What a relation may point to: a type (the usual case), a tag, or – for those who want it –
 * any query as text. Stored as query text, e.g. "typ:Person" or "#autor".
 */
function TargetField({ target, hits, onChange }: { target?: string; hits: number; onChange: (t: string) => void }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const where = target ? parseQuery(target, ix).def.where : undefined;
  const typeId = where && "type" in where ? where.type : undefined;
  const tag = where && "tag" in where ? where.tag : undefined;
  const [mode, setMode] = useState<"type" | "tag" | "query">(typeId || !target ? "type" : tag ? "tag" : "query");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const types = [...ix.types.values()].sort((a, b) => a.schema!.name.localeCompare(b.schema!.name));
  const box = "w-full rounded-md border border-line bg-bg px-2 py-1 text-sm outline-none";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <select
          value={mode === "type" ? (typeId ?? "") : mode}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "new") return setCreating(true);
            if (v === "tag" || v === "query") return setMode(v);
            setMode("type");
            onChange(v ? printQuery({ where: { type: v } }, lang, ix) : "");
          }}
          className={box}
          aria-label={t("type.target")}
        >
          <option value="">{t("type.targetAny")}</option>
          {types.map((x) => (
            <option key={x.id} value={x.id}>
              {x.schema!.name}
            </option>
          ))}
          <option value="tag">{t("type.targetTag")}</option>
          <option value="query">{t("type.targetQuery")}</option>
          <option value="new">{t("type.targetNew")}</option>
        </select>
        <span className="shrink-0 text-xs text-muted">{t("type.hits", { count: hits })}</span>
      </div>
      {mode === "tag" && <input defaultValue={tag ?? ""} onBlur={(e) => e.target.value.trim() && onChange("#" + e.target.value.trim().replace(/^#/, "").toLowerCase())} placeholder="#autor" className={box} />}
      {mode === "query" && <input defaultValue={target ?? ""} onBlur={(e) => onChange(e.target.value.trim())} placeholder={t("type.targetPlaceholder")} className={cx(box, "font-mono")} />}
      {/* the target type does not exist yet: make it here, without leaving the editor */}
      {creating && (
        <Dialog title={t("type.targetNewTitle")} onClose={() => setCreating(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = newName.trim();
              if (!n) return;
              const id = createType(n);
              setCreating(false);
              setNewName("");
              setMode("type");
              onChange(printQuery({ where: { type: id } }, lang, repo.index()));
            }}
          >
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("type.name")} className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none" />
            <div className="mt-4 flex justify-end">
              <Button type="submit" variant="primary" disabled={!newName.trim()}>
                {t("types.create")}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
