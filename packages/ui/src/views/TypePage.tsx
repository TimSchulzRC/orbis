// A type is an information with a schema; changing it is editing, not programming.
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { NativeSelect } from "../components/ui/native-select";
import { useEffect, useState } from "react";
import { Plus, Trash2, GripVertical, ArrowUp, ArrowDown, Tag as TagIcon, X, Pencil, Pin, RotateCcw } from "lucide-react";
import type * as Y from "yjs";
import {
  type Item,
  type OptionDef,
  type Patch,
  type PropDef,
  type PropKind,
  type StatusGroup,
  PROP_KINDS,
  removeProp,
  setCapability,
  setMeta,
  setSchemaField,
  setTabs,
  shortId,
  titleKey,
  upsertProp,
} from "@obtion/core/model";
import { COLORS, ICONS } from "@obtion/core/palette";
import { isStatusProp, statusProp, useAsStatus } from "@obtion/core/traits";
import { keyBetween } from "@obtion/core/sortkey";
import { parseQuery, printQuery, runQuery } from "@obtion/core/query";
import { type DeleteMode, deleteType, previewTagToType, tagToType, typeUsage } from "@obtion/core/typeops";
import { useIndex, useRoute, navigate, setParams, useDocumentTitle, useRepo } from "../hooks";
import { useT } from "../i18n";
import { Card, Button, Dialog, MenuItem, Popover, SectionTitle, Seg, AddButton, IconButton, MoreMenu, PagePlaceholder } from "../ui/primitives";
import { InlineText } from "../ui/fields";
import { ItemIcon, TypeGlyph, pal } from "../ui/item-look";
import { cn } from "../lib/utils";
import { ICON } from "../ui/icons";
import { TypeList } from "./Lists";
import { notify } from "../ui/feedback";
import type { T } from "@obtion/core/i18n";
import { NewTypeDialog } from "./Types";

export function TypePage({ item }: { item: Item }) {
  const repo = useRepo();
  const { t } = useT();
  const ix = useIndex();
  const route = useRoute();
  const [editing, setEditing] = useState(route.query.get("edit") === "1");
  useEffect(() => void setParams({ edit: null }), []);
  const plural = ix.typePlural(item.id);
  useDocumentTitle(plural);
  if (item.deleted) return <PagePlaceholder>{t("type.isDeleted", { name: item.schema!.name })}</PagePlaceholder>;
  return (
    <div className="page-wide">
      <div className="mb-4 flex items-center gap-3">
        <TypeGlyph schema={item.schema} size={22} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="page-title truncate">{plural}</h1>
          <span className="text-[15px] tabular-nums text-muted-foreground">{ix.itemsOfType(item.id).length}</span>
        </div>
        <MoreMenu>
          {(close) => (
            <>
              <MenuItem icon={<Pencil size={14} />} onClick={() => (close(), setEditing(!editing))}>
                {t("type.edit")}
              </MenuItem>
              <MenuItem icon={<Pin size={14} />} onClick={() => (close(), repo.pin(item.id, !item.pinned))}>
                {item.pinned ? t("item.unpin") : t("item.pin")}
              </MenuItem>
              <MenuItem icon={<RotateCcw size={14} />} onClick={() => (close(), repo.change(item.id, (d) => setTabs(d, [])), notify(t("type.viewsReset")))}>
                {t("type.resetViews")}
              </MenuItem>
            </>
          )}
        </MoreMenu>
      </div>
      {editing && <TypeEditor item={item} onClose={() => setEditing(false)} />}
      <TypeList type={item} />
    </div>
  );
}

function TypeEditor({ item, onClose }: { item: Item; onClose: () => void }) {
  const repo = useRepo();
  const { t } = useT();
  const ix = useIndex();
  const s = item.schema!;
  const [sel, setSel] = useState<string | undefined>(s.properties[0]?.id);
  const [dialog, setDialog] = useState<null | "delete" | "fromTag" | "toTag">(null);
  const change = (fn: (doc: Y.Doc) => void) => repo.change(item.id, fn);
  const selected = s.properties.find((p) => p.id === sel);

  return (
    <Card className="@container mb-6 p-4 md:p-5">
      <div className="flex items-start gap-3">
        <Popover
          trigger={(p) => (
            <Button variant="plain" {...p} className="tap mt-1 rounded-lg p-1.5 hover:bg-hover" aria-label={t("type.icon")}>
              <TypeGlyph schema={s} size={24} />
            </Button>
          )}
        >
          {(close) => (
            <div className="w-72 p-1">
              <div className="grid grid-cols-8 gap-1">
                {ICONS.map((n) => {
                  const I = ICON[n] ?? ICON.circle!;
                  return (
                    <Button variant="plain" key={n} onClick={() => (change((d) => setSchemaField(d, "icon", n)), close())} className={cn("tap rounded-md p-1.5 hover:bg-hover", s.icon === n && "bg-hover")} aria-label={n}>
                      <I size={16} style={{ color: pal(s.color) }} />
                    </Button>
                  );
                })}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
                {COLORS.map((c) => (
                  <Button variant="plain" key={c} onClick={() => change((d) => setSchemaField(d, "color", c))} className={cn("size-6 rounded-full border-2", s.color === c ? "border-fg" : "border-transparent")} style={{ background: pal(c) }} aria-label={c} />
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
          <label className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            {t("type.plural")}
            <Input
              variant="bare"
              key={item.id + (s.plural ?? "")}
              defaultValue={ix.typePlural(item.id)}
              onBlur={(e) => e.target.value.trim() !== ix.typePlural(item.id) && change((d) => setSchemaField(d, "plural", e.target.value.trim()))}
              className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-0.5 text-sm text-fg outline-none focus:border-focus"
            />
          </label>
        </div>
        <MoreMenu>
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
        </MoreMenu>
        <IconButton icon={X} label={t("view.closeSettings")} onClick={onClose} />
      </div>

      <label className="mt-5 block">
        <span className="text-xs font-medium text-muted-foreground">{t("type.description")}</span>
        <Textarea
          key={item.id}
          defaultValue={s.description}
          onBlur={(e) => e.target.value !== s.description && change((d) => setSchemaField(d, "description", e.target.value))}
          rows={3}
          className="mt-1 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-focus"
        />
      </label>

      <div className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section>
          <SectionTitle right={<AddProperty item={item} onAdded={setSel} />}>{t("type.properties")}</SectionTitle>
          <Card className="p-1">
            {s.properties.map((p, i) => (
              <div key={p.id}>
              <div className={cn("group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-hover", p.id === sel && "bg-selected")}>
                <GripVertical size={14} className="text-muted-foreground" />
                <Button variant="plain" onClick={() => setSel(p.id)} className="tap-row flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="truncate font-medium">{p.name}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{kindLabel(p, s.capabilities.status, t)}</span>
                </Button>
                {/* on touch screens only on the selected row: no invisible buttons to hit */}
                <span className={cn("flex opacity-0 group-hover:opacity-100", p.id === sel ? "opacity-100" : "pointer-coarse:hidden")}>
                  <Button variant="plain" disabled={i === 0} onClick={() => change((d) => upsertProp(d, p.id, { sort: keyBetween(s.properties[i - 2]?.sort ?? null, s.properties[i - 1]!.sort) }))} className="tap rounded p-0.5 text-muted-foreground hover:text-fg disabled:opacity-30" aria-label={t("type.up")}>
                    <ArrowUp size={12} />
                  </Button>
                  <Button variant="plain" disabled={i === s.properties.length - 1} onClick={() => change((d) => upsertProp(d, p.id, { sort: keyBetween(s.properties[i + 1]!.sort, s.properties[i + 2]?.sort ?? null) }))} className="tap rounded p-0.5 text-muted-foreground hover:text-fg disabled:opacity-30" aria-label={t("type.down")}>
                    <ArrowDown size={12} />
                  </Button>
                </span>
              </div>
              {/* narrow: the settings open right below the chosen property, not under the capabilities */}
              {p.id === sel && <div className="px-1 pb-2 pt-1 @3xl:hidden">{selected && <PropEditor item={item} prop={selected} />}</div>}
              </div>
            ))}
            {!s.properties.length && <p className="px-2 py-2 text-sm text-muted-foreground">{t("type.noProps")}</p>}
          </Card>
          <Capabilities item={item} />
        </section>
        <section className="hidden @3xl:block">{selected ? <PropEditor item={item} prop={selected} /> : null}</section>
      </div>

      {dialog === "delete" && <DeleteTypeDialog item={item} onClose={() => setDialog(null)} />}
      {dialog === "toTag" && <DeleteTypeDialog item={item} onClose={() => setDialog(null)} toTag />}
      {dialog === "fromTag" && <FromTagDialog item={item} onClose={() => setDialog(null)} />}
    </Card>
  );
}

function AddProperty({ item, onAdded }: { item: Item; onAdded: (id: string) => void }) {
  const repo = useRepo();
  const { t } = useT();
  const ix = useIndex();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PropKind>("text");
  // Same name on another type: offer to copy its settings (the types stay independent).
  const twins = name.trim()
    ? [...ix.types.values()].flatMap((tp) => (tp.id === item.id ? [] : tp.schema.properties.filter((p) => p.name.toLowerCase() === titleKey(name)).map((p) => ({ tp, p }))))
    : [];
  const add = (copy?: PropDef) => {
    if (!name.trim()) return;
    const id = shortId("p");
    const { id: _i, sort: _s, ...rest } = copy ?? ({ id: "", sort: "", name: "", kind } as PropDef);
    // copied options keep their ids: queries by option name and conversions then work the same.
    repo.change(item.id, (d) => {
      upsertProp(d, id, { ...rest, name: name.trim(), kind: copy ? copy.kind : kind, options: copy?.options ?? (kind === "select" ? [] : undefined), ...(!copy && kind === "relation" ? { inverseName: t("type.inverseOf", { name: name.trim() }) } : {}) });
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
        <Input variant="sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !twins.length && add()} placeholder={t("props.name")} />
        {twins.length > 0 && (
          <div className="rounded-lg bg-surface-2 p-2 text-xs">
            <p className="mb-1 text-muted-foreground">{t("type.twins")}</p>
            {twins.map(({ tp, p }) => (
              <Button variant="plain" key={tp.id + p.id} onClick={() => add(p)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover">
                <TypeGlyph schema={tp.schema} size={12} /> {tp.schema.name} › {p.name} <span className="ml-auto text-muted-foreground">{kindLabel(p, tp.schema.capabilities.status, t)}</span>
              </Button>
            ))}
          </div>
        )}
        <NativeSelect full value={kind} onChange={(e) => setKind(e.target.value as PropKind)} className="w-full rounded-md border border-line bg-bg px-1.5 py-1 text-sm" aria-label={t("props.kind")}>
          {PROP_KINDS.map((k) => (
            <option key={k} value={k}>
              {t("kind.prop." + k)}
            </option>
          ))}
        </NativeSelect>
        <Button variant="primary" className="w-full" onClick={() => add()} disabled={!name.trim()}>
          {twins.length ? t("type.addNew") : t("props.add")}
        </Button>
      </div>
    </Popover>
  );
}

/** "Auswahl", "Auswahl · mehrere" or "Status": a select says what it is set to. */
function kindLabel(p: PropDef, status: string | undefined, t: T): string {
  if (p.kind !== "select") return t("kind.prop." + p.kind);
  return p.id === status && !p.multiple ? t("kind.prop.status") : p.multiple ? t("kind.prop.multiselect") : t("kind.prop.select");
}

function defaultStatusOptions(t: T): OptionDef[] {
  return [
    { id: shortId("st"), name: t("group.todo"), group: "todo", color: "gray" },
    { id: shortId("st"), name: t("group.active"), group: "active", color: "amber" },
    { id: shortId("st"), name: t("group.done"), group: "done", color: "green" },
  ];
}

function PropEditor({ item, prop }: { item: Item; prop: PropDef }) {
  const repo = useRepo();
  const { t } = useT();
  const ix = useIndex();
  const set = (patch: Patch<Omit<PropDef, "id">>) => repo.change(item.id, (d) => upsertProp(d, prop.id, patch));
  const field = (label: string, inner: React.ReactNode) => (
    <div className="mt-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1">{inner}</div>
    </div>
  );
  const box = "w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-focus";
  // no target: anything can be chosen
  const targetHits = prop.kind !== "relation" ? 0 : prop.target ? runQuery(parseQuery(prop.target, ix).def, { ix }).total : ix.live.filter((i) => i.kind === "info").length;
  const types = [...ix.types.values()];
  const isStatus = isStatusProp(item.schema!, prop);
  const other = statusProp(item.schema!);
  return (
    <Card className="p-4" key={prop.id}>
      <div className="flex items-center gap-2">
        <InlineText value={prop.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} className="font-semibold" label={t("props.name")} />
        <NativeSelect value={prop.kind} onChange={(e) => repo.change(item.id, (d) => (upsertProp(d, prop.id, { kind: e.target.value as PropKind }), isStatus && setCapability(d, "status", null)))} className="rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs" aria-label={t("props.kind")}>
          {PROP_KINDS.map((k) => (
            <option key={k} value={k}>
              {t("kind.prop." + k)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t("type.kindHint")}</p>
      {field(t("type.propDescription"), <Textarea key={prop.id + "d"} defaultValue={prop.description ?? ""} onBlur={(e) => set({ description: e.target.value || null })} rows={2} className={box} />)}
      {(prop.kind === "relation" || prop.kind === "text") && (
        <label className="tap-row mt-1 flex items-center gap-2 text-sm">
          <Checkbox checked={!!prop.blocks} onCheckedChange={(checked) => set({ blocks: checked === true || null })} />
          <span>
            {t("type.blocks")} <span className="text-xs text-muted-foreground">– {t(prop.kind === "relation" ? "type.blocksRelationHint" : "type.blocksTextHint")}</span>
          </span>
        </label>
      )}
      {prop.kind === "select" && (
        <>
          {field(t("type.options"), <OptionsEditor prop={prop} grouped={isStatus} onChange={(options) => set({ options, ...(prop.default && !options.some((o) => o.id === prop.default) ? { default: isStatus ? options[0]?.id : (null as any) } : {}) })} />)}
          {field(
            t("type.values"),
            // the status has one value: nothing to switch
            isStatus ? (
              <p className="text-sm text-muted-foreground">{t("type.statusOne")}</p>
            ) : (
              <Seg label={t("type.values")} value={prop.multiple ? "many" : "one"} onChange={(v) => set(v === "many" ? { multiple: true, default: null as any } : { multiple: null as any })} options={[{ value: "one", label: t("type.one") }, { value: "many", label: t("type.many") }]} />
            ),
          )}
          {!prop.multiple &&
            field(
              t("type.default"),
              <>
                <NativeSelect value={prop.default ?? ""} onChange={(e) => set({ default: e.target.value || (null as any) })} className={box} aria-label={t("type.default")}>
                  {!isStatus && <option value="">{t("type.defaultNone")}</option>}
                  {prop.options?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </NativeSelect>
                {(isStatus || prop.default) && <p className="mt-1 text-xs text-muted-foreground">{t(isStatus ? "type.defaultStatusHint" : "type.defaultHint")}</p>}
              </>,
            )}
          <label className="tap-row mt-3 flex items-start gap-2 text-sm">
            <Checkbox checked={isStatus} onCheckedChange={(on) => repo.change(item.id, (d) => (on === true ? useAsStatus(d, prop, defaultStatusOptions(t)) : setCapability(d, "status", null)))} className="mt-0.5 accent-[var(--focus)]" />
            <span>
              {t("type.asStatus")}
              <span className="block text-xs text-muted-foreground">{other && !isStatus ? t("type.asStatusMoves", { name: other.name }) : t("type.asStatusHint")}</span>
            </span>
          </label>
        </>
      )}
      {prop.kind === "date" &&
        field(
          t("type.dateRange"),
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={!!prop.range} onCheckedChange={(checked) => set({ range: checked === true || null })} /> {t("type.range")}
          </label>,
        )}
      {prop.kind === "relation" && (
        <>
          {field(
            t("type.target"),
            <TargetField key={prop.id + "t"} target={prop.target} hits={targetHits} onChange={(target) => set({ target: target || null })} />,
          )}
          {field(
            t("type.count"),
            <Seg label={t("type.count")} value={prop.multiple ? "many" : "one"} onChange={(v) => set({ multiple: v === "many" || null })} options={[{ value: "one", label: t("type.one") }, { value: "many", label: t("type.many") }]} />,
          )}
          {field(
            t("type.inverse"),
            <Input variant="bare" key={prop.id + "i"} defaultValue={prop.inverseName ?? ""} placeholder={t("type.inverseOf", { name: prop.name })} onBlur={(e) => set({ inverseName: e.target.value.trim() || null })} className={box} />,
          )}
          <label className="mt-2 flex items-center gap-2 text-sm">
            <Checkbox checked={!!prop.symmetric} onCheckedChange={(checked) => set({ symmetric: checked === true || null })} /> {t("type.symmetric")}
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
            <NativeSelect full value={prop.computed?.of ?? ""} onChange={(e) => set({ computed: { fn: prop.computed?.fn ?? "progress", of: e.target.value || undefined } })} className={box}>
              <option value="">{t("type.anyType")}</option>
              {types.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.schema.name}
                </option>
              ))}
            </NativeSelect>,
          )}
        </>
      )}
      <div className="mt-5 flex justify-end">
        <Button variant="danger" onClick={() => repo.change(item.id, (d) => removeProp(d, prop.id))}>
          <Trash2 size={14} /> {t("type.removeProp")}
        </Button>
      </div>
      <p className="mt-1 text-right text-xs text-muted-foreground">{t("type.removeHint")}</p>
    </Card>
  );
}

/** The choices of a status option: the three groups, paused within active, dropped within done. */
const GROUP_CHOICES = ["todo", "active", "active:paused", "done", "done:dropped"];

function OptionsEditor({ prop, grouped, onChange }: { prop: PropDef; grouped: boolean; onChange: (o: OptionDef[]) => void }) {
  const { t } = useT();
  const opts = prop.options ?? [];
  const upd = (i: number, patch: Partial<OptionDef>) => onChange(opts.map((o, n) => (n === i ? { ...o, ...patch } : o)));
  // "active:paused" → group active, state paused; a plain group drops the state
  const setGroup = (i: number, v: string) => {
    const [group, state] = v.split(":") as [StatusGroup, OptionDef["state"]];
    onChange(opts.map(({ state: _, ...o }, n) => (n === i ? { ...o, group, ...(state ? { state } : {}) } : opts[n]!)));
  };
  return (
    <div className="space-y-1">
      {opts.map((o, i) => (
        <div key={o.id} className="flex items-center gap-1.5">
          <Popover trigger={(p) => <Button variant="plain" {...p} className="size-4 shrink-0 rounded-full" style={{ background: pal(o.color ?? "gray") }} aria-label={t("type.color")} />}>
            {(close) => (
              <div className="flex w-56 flex-wrap gap-1.5 p-1">
                {COLORS.map((c) => (
                  <Button variant="plain" key={c} onClick={() => (upd(i, { color: c }), close())} className="size-5 rounded-full" style={{ background: pal(c) }} aria-label={c} />
                ))}
              </div>
            )}
          </Popover>
          <Input variant="bare" defaultValue={o.name} onBlur={(e) => e.target.value.trim() && e.target.value !== o.name && upd(i, { name: e.target.value.trim() })} className="field min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-sm outline-none hover:bg-hover" />
          {grouped && (
            <NativeSelect value={(o.group ?? "todo") + (o.state ? ":" + o.state : "")} onChange={(e) => setGroup(i, e.target.value)} className="rounded-md border border-line bg-bg px-1 py-0.5 text-xs" aria-label={t("type.group")}>
              {GROUP_CHOICES.map((g) => (
                <option key={g} value={g}>
                  {t("group." + g.replace(":", "."))}
                </option>
              ))}
            </NativeSelect>
          )}
          <Button variant="plain" onClick={() => onChange(opts.filter((_, n) => n !== i))} className="text-muted-foreground hover:text-danger" aria-label={t("type.removeOption")}>
            <X size={13} />
          </Button>
        </div>
      ))}
      <Button variant="plain" onClick={() => onChange([...opts, { id: shortId("o"), name: t("type.newOption"), group: grouped ? "todo" : undefined, color: "gray" }])} className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-fg">
        <Plus size={12} /> {t("type.addOption")}
      </Button>
    </div>
  );
}

function Capabilities({ item }: { item: Item }) {
  const repo = useRepo();
  const { t } = useT();
  const ix = useIndex();
  const s = item.schema!;
  const c = s.capabilities;
  const set = <K extends keyof typeof c>(k: K, v: (typeof c)[K] | null) => repo.change(item.id, (d) => setCapability(d, k, v));
  const statusProps = s.properties.filter((p) => p.kind === "select" && !p.multiple);
  const dateProps = s.properties.filter((p) => p.kind === "date");
  const types = [...ix.types.values()];
  const sel = "tap-row rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs";
  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="flex items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
  return (
    <div className="mt-8">
      <SectionTitle>{t("caps.title")}</SectionTitle>
      <Card className="divide-y divide-line px-3">
        {row(
          t("caps.status"),
          t("caps.statusHint"),
          <NativeSelect value={statusProp(s)?.id ?? ""} onChange={(e) => { const p = statusProps.find((x) => x.id === e.target.value); repo.change(item.id, (d) => (p ? useAsStatus(d, p, defaultStatusOptions(t)) : setCapability(d, "status", null))); }} className={sel} aria-label={t("caps.status")}>
            <option value="">{t("caps.off")}</option>
            {statusProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>,
        )}
        {row(
          t("caps.due"),
          t("caps.dueHint"),
          <NativeSelect value={c.due ?? ""} onChange={(e) => set("due", e.target.value || null)} className={sel} aria-label={t("caps.due")}>
            <option value="">{t("caps.off")}</option>
            {dateProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>,
        )}
        {row(
          t("caps.progress"),
          t("caps.progressHint"),
          <NativeSelect value={c.progress ? (c.progress.of ?? "*") : ""} onChange={(e) => set("progress", e.target.value ? (e.target.value === "*" ? {} : { of: e.target.value }) : null)} className={sel} aria-label={t("caps.progress")}>
            <option value="">{t("caps.off")}</option>
            <option value="*">{t("caps.anyWithStatus")}</option>
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.schema.name}
              </option>
            ))}
          </NativeSelect>,
        )}
        {row(t("caps.updates"), t("caps.updatesHint"), <Checkbox checked={!!c.updates} onCheckedChange={(checked) => set("updates", checked === true || null)} className="size-4" aria-label={t("caps.updates")} />)}
        {row(
          t("caps.primaryChild"),
          t("caps.primaryChildHint"),
          <NativeSelect value={c.primaryChild ?? ""} onChange={(e) => set("primaryChild", e.target.value || null)} className={sel} aria-label={t("caps.primaryChild")}>
            <option value="">{t("caps.off")}</option>
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.schema.name}
              </option>
            ))}
          </NativeSelect>,
        )}
        <div className="py-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={!!c.template} onCheckedChange={(checked) => set("template", checked === true ? { body: "" } : null)} className="size-4" /> {t("caps.template")}
          </label>
          <p className="text-xs text-muted-foreground">{t("caps.templateHint")}</p>
          {c.template && (
            <Textarea
              key={item.id + "tpl"}
              defaultValue={c.template.body ?? ""}
              onBlur={(e) => set("template", { ...c.template, body: e.target.value })}
              rows={4}
              placeholder={t("caps.templatePlaceholder")}
              className="mt-2 w-full resize-y rounded-lg border border-line bg-bg px-2.5 py-1.5 font-mono text-xs outline-none"
            />
          )}
        </div>
      </Card>
    </div>
  );
}

function DeleteTypeDialog({ item, onClose, toTag }: { item: Item; onClose: () => void; toTag?: boolean }) {
  const repo = useRepo();
  const { t } = useT();
  const ix = useIndex();
  const s = item.schema!;
  const u = typeUsage(ix, item.id);
  const [mode, setMode] = useState<"tag" | "type" | "remove">("tag");
  const [tag, setTag] = useState(s.name.toLowerCase().replace(/\s+/g, "-"));
  const others = [...ix.types.values()].filter((x) => x.id !== item.id);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  const run = () => {
    const m: DeleteMode = mode === "tag" ? { mode: "tag", tag } : mode === "type" ? { mode: "type", target } : { mode: "remove" };
    const label =
      mode === "tag" ? t("op.typeToTag", { name: s.name, tag }) : mode === "type" ? t("op.typeToType", { name: s.name, target: ix.typeName(target) }) : t("op.typeRemoved", { name: s.name });
    deleteType(repo.writer, ix, item.id, m, label, repo.origin);
    onClose();
    navigate("/types");
  };
  return (
    <Dialog title={toTag ? t("type.toTagTitle", { name: s.name }) : t("type.deleteTitle", { name: s.name })} onClose={onClose}>
      <p className="text-sm">{t("type.affects", { count: u.items.length })}</p>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
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
          {t("type.tagName")} <Input variant="sm" value={tag} onChange={(e) => setTag(e.target.value)} />
        </label>
      )}
      {mode === "type" && (
        <NativeSelect value={target} onChange={(e) => setTarget(e.target.value)} className="mt-3 rounded-md border border-line bg-bg px-2 py-1 text-sm">
          {others.map((x) => (
            <option key={x.id} value={x.id}>
              {x.schema.name}
            </option>
          ))}
        </NativeSelect>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t("type.valuesKept")}</p>
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
  const repo = useRepo();
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
        # <Input variant="sm" value={tag} onChange={(e) => setTag(e.target.value)} />
      </label>
      <p className="mt-3 text-sm">{t("type.fromTagCount", { count: p.untyped.length, name: s.name, tag: tag.trim().replace(/^#/, "") })}</p>
      {p.untyped.length > 0 && (
        <details className="mt-1 text-sm">
          <summary className="tap-y cursor-pointer text-xs text-muted-foreground hover:text-fg">{t("type.fromTagShow")}</summary>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
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
          <ul className="mt-1 max-h-28 overflow-y-auto text-xs text-muted-foreground">
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
        <Checkbox checked={removeTag} onCheckedChange={(checked) => setRemoveTag(checked === true)} /> {t("type.removeTagAfter", { tag })}
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={!n && !(removeTag && p.already.length)}
          onClick={() => {
            tagToType(repo.writer, ix, tag, item.id, { replaceTypes: replace, removeTag }, t("op.tagToType", { tag, name: s.name }), repo.origin);
            onClose();
          }}
        >
          {t("type.convertCount", { count: n })}
        </Button>
      </div>
    </Dialog>
  );
}

/** A type, a tag or any query; stored as query text, e.g. "typ:Person" or "#autor". */
function TargetField({ target, hits, onChange }: { target?: string; hits: number; onChange: (t: string) => void }) {
  const repo = useRepo();
  const { t, lang } = useT();
  const ix = useIndex();
  const where = target ? parseQuery(target, ix).def.where : undefined;
  const typeId = where && "type" in where ? where.type : undefined;
  const tag = where && "tag" in where ? where.tag : undefined;
  const [mode, setMode] = useState<"type" | "tag" | "query">(typeId || !target ? "type" : tag ? "tag" : "query");
  const [creating, setCreating] = useState(false);
  const types = ix.typesByName();
  const box = "w-full rounded-md border border-line bg-bg px-2 py-1 text-sm outline-none";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <NativeSelect
          full
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
              {x.schema.name}
            </option>
          ))}
          <option value="tag">{t("type.targetTag")}</option>
          <option value="query">{t("type.targetQuery")}</option>
          <option value="new">{t("type.targetNew")}</option>
        </NativeSelect>
        <span className="shrink-0 text-xs text-muted-foreground">{t("type.hits", { count: hits })}</span>
      </div>
      {mode === "tag" && <Input defaultValue={tag ?? ""} onBlur={(e) => e.target.value.trim() && onChange("#" + e.target.value.trim().replace(/^#/, "").toLowerCase())} placeholder="#autor" variant="sm" />}
      {mode === "query" && <Input defaultValue={target ?? ""} onBlur={(e) => onChange(e.target.value.trim())} placeholder={t("type.targetPlaceholder")} variant="sm" className="font-mono" />}
      {/* the target type does not exist yet: make it here, without leaving the editor */}
      {creating && (
        <NewTypeDialog
          title={t("type.targetNewTitle")}
          onClose={() => setCreating(false)}
          onCreated={(id) => (setMode("type"), onChange(printQuery({ where: { type: id } }, lang, repo.index())))}
        />
      )}
    </div>
  );
}
