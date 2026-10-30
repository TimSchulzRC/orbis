// Views as tabs: each tab its own kind, filter (added to the query), grouping, sorting and
// properties. The tab bar and the panel to set a view up; a type's page and query blocks share them.
import { Checkbox } from "../components/ui/checkbox";
import { Button as ShadcnButton } from "../components/ui/button";
import { NativeSelect } from "../components/ui/native-select";
import { useState } from "react";
import { CalendarDays, ChartGantt, ChevronLeft, ChevronRight, Copy, GripVertical, LayoutGrid, List, ListChecks, ListTree, Plus, SlidersHorizontal, SquareKanban, Table2, Trash2, X } from "lucide-react";
import { type ViewTab, type PropDef, type ViewKind, titleKey } from "@obtion/core/model";
import { type Cond, type Group, FIELDS, groupId, parseQuery, typesIn } from "@obtion/core/query";
import { statusProp } from "@obtion/core/traits";
import { keyBetween } from "@obtion/core/sortkey";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { Button, InlineText, MenuItem, Popover, Seg, cx } from "./bits";
import { QueryEditor } from "./QueryEditor";
import { GroupChip } from "./Table";
import type { T } from "@obtion/core/i18n";

/** The kinds offered for a new tab, in this order. */
const TAB_KINDS: ViewKind[] = ["table", "board", "timeline", "calendar", "list", "gallery", "triage"];
const KIND_ICON: Record<ViewKind, React.ComponentType<{ size?: number; className?: string }>> = {
  table: Table2,
  board: SquareKanban,
  list: List,
  tree: ListTree,
  gallery: LayoutGrid,
  triage: ListChecks,
  calendar: CalendarDays,
  timeline: ChartGantt,
};

export const tabName = (tab: Pick<ViewTab, "name" | "kind">, t: T) => tab.name || t("view." + tab.kind);

/** The tab this device showed last for `key` (a type's page, a block); an unknown one: the first. */
export function useTabChoice(key: string, tabs: ViewTab[]): [ViewTab, (id: string) => void] {
  const k = "obtion.tab." + key;
  const [id, setId] = useState(() => localStorage.getItem(k));
  const tab = tabs.find((x) => x.id === id) ?? tabs[0]!;
  return [tab, (x) => (localStorage.setItem(k, x), setId(x))];
}

export interface TabEdit {
  add: (kind: ViewKind) => void;
  rename: (id: string, name: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  move: (id: string, pos: string) => void;
  settings: () => void;
}

/**
 * The tab bar: a click picks a view, a click on the shown one opens its menu (rename, set up,
 * duplicate, move, delete), "+" adds one. Tabs can be dragged into another order.
 */
export function ViewTabs({ tabs, active, onPick, edit, right }: { tabs: ViewTab[]; active: string; onPick: (id: string) => void; edit?: TabEdit; right?: React.ReactNode }) {
  const { t } = useT();
  const [menu, setMenu] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drop = (target: string) => {
    if (!edit || !drag || drag === target) return;
    const rest = tabs.filter((x) => x.id !== drag);
    const at = rest.findIndex((x) => x.id === target);
    const from = tabs.findIndex((x) => x.id === drag);
    const to = tabs.findIndex((x) => x.id === target);
    // dropped on a tab: it goes to that tab's place (before it when coming from the right)
    const before = from > to ? rest[at] : rest[at + 1];
    const after = from > to ? rest[at - 1] : rest[at];
    edit.move(drag, keyBetween(after?.pos ?? null, before?.pos ?? null));
  };
  const step = (id: string, d: -1 | 1) => {
    const n = tabs.findIndex((x) => x.id === id);
    const a = d < 0 ? tabs[n - 2] : tabs[n + 1];
    const b = d < 0 ? tabs[n - 1] : tabs[n + 2];
    edit?.move(id, keyBetween(a?.pos ?? null, b?.pos ?? null));
  };
  return (
    <div className="mb-3 flex items-end gap-2 border-b border-line">
      <div role="tablist" aria-label={t("view.tabs")} className="-mb-px flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab, n) => {
          const Icon = KIND_ICON[tab.kind] ?? List;
          const on = tab.id === active;
          return (
            <Popover
              key={tab.id}
              open={menu === tab.id}
              onOpenChange={(o) => setMenu(o ? tab.id : null)}
              trigger={(p) => (
                <ShadcnButton variant="plain" size="none"
                  role="tab"
                  aria-selected={on}
                  aria-haspopup={on && edit ? "menu" : undefined}
                  aria-expanded={on && edit ? p["aria-expanded"] : undefined}
                  onClick={() => (on ? edit && p.onClick() : onPick(tab.id))}
                  draggable={!!edit}
                  onDragStart={(e) => (e.dataTransfer.setData("obtion/tab", tab.id), setDrag(tab.id))}
                  onDragEnd={() => (setDrag(null), setOver(null))}
                  onDragOver={(e) => drag && (e.preventDefault(), setOver(tab.id))}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => (e.preventDefault(), drop(tab.id), setDrag(null), setOver(null))}
                  className={cx(
                    "tap-y flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2 text-sm",
                    on ? "border-[var(--text)] font-medium text-fg" : "border-transparent text-muted-foreground hover:text-fg",
                    over === tab.id && "bg-hover",
                  )}
                >
                  <Icon size={14} className="shrink-0" />
                  {tabName(tab, t)}
                </ShadcnButton>
              )}
            >
              {(close) => (
                <div className="w-60">
                  <div className="px-1.5 pb-1 pt-0.5">
                    <InlineText value={tab.name ?? ""} placeholder={t("view." + tab.kind)} onCommit={(v) => edit!.rename(tab.id, v.trim())} label={t("view.rename")} className="rounded-md border border-line bg-bg px-2 py-1 text-sm" />
                  </div>
                  <MenuItem icon={<SlidersHorizontal size={14} />} onClick={() => (close(), edit!.settings())}>
                    {t("view.settings")}
                  </MenuItem>
                  <MenuItem icon={<Copy size={14} />} onClick={() => (close(), edit!.duplicate(tab.id))}>
                    {t("view.duplicate")}
                  </MenuItem>
                  {n > 0 && (
                    <MenuItem icon={<ChevronLeft size={14} />} onClick={() => step(tab.id, -1)}>
                      {t("view.moveLeft")}
                    </MenuItem>
                  )}
                  {n < tabs.length - 1 && (
                    <MenuItem icon={<ChevronRight size={14} />} onClick={() => step(tab.id, 1)}>
                      {t("view.moveRight")}
                    </MenuItem>
                  )}
                  {tabs.length > 1 && (
                    <MenuItem danger icon={<Trash2 size={14} />} onClick={() => (close(), edit!.remove(tab.id))}>
                      {t("view.remove")}
                    </MenuItem>
                  )}
                </div>
              )}
            </Popover>
          );
        })}
        {edit && (
          <Popover
            trigger={(p) => (
              <ShadcnButton variant="plain" size="none" {...p} className="tap mb-1 ml-0.5 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("view.add")} title={t("view.add")}>
                <Plus size={15} />
              </ShadcnButton>
            )}
          >
            {(close) =>
              TAB_KINDS.map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <MenuItem key={k} icon={<Icon size={14} />} onClick={() => (close(), edit.add(k))}>
                    {t("view." + k)}
                  </MenuItem>
                );
              })
            }
          </Popover>
        )}
      </div>
      {right && <div className="mb-1 flex shrink-0 items-center gap-1.5">{right}</div>}
    </div>
  );
}

// ---------- what a view can show and group by ----------

interface ViewField {
  key: string; // stored in columns / sort / group: a built-in field or the property's name
  label: string;
  kind: PropDef["kind"] | "item" | "tags" | "builtin-date";
  prop?: PropDef;
}

/** Fields of the types a view lists (and the built-in ones), for columns, sorting, grouping and dates. */
export function useViewFields(where: Cond | undefined, sample: { type: string | null }[] = []): ViewField[] {
  const ix = useIndex();
  const { t } = useT();
  const typeIds = [...new Set([...typesIn(where), ...sample.slice(0, 200).map((i) => i.type ?? "")])].filter((id) => ix.types.has(id));
  const out: ViewField[] = [];
  const seen = new Set<string>();
  const push = (f: ViewField) => !seen.has(titleKey(f.key)) && (seen.add(titleKey(f.key)), out.push(f));
  for (const id of typeIds)
    for (const p of ix.types.get(id)!.schema!.properties) push({ key: p.name, label: p.name, kind: p.kind, prop: p });
  // the other side of relations that can point here ("Blockiert diese")
  for (const ty of ix.types.values())
    for (const p of ty.schema!.properties) {
      if (p.kind !== "relation" || p.symmetric || !p.inverseName) continue;
      const target = p.target ? typesIn(parseQuery(p.target, ix).def.where) : [];
      if (target.length && !target.some((x) => typeIds.includes(x))) continue;
      if (!typeIds.includes(ty.id) && !target.length) continue;
      push({ key: p.inverseName, label: p.inverseName, kind: "relation" });
    }
  push({ key: "project", label: t("field.project"), kind: "item" });
  push({ key: "area", label: t("field.area"), kind: "item" });
  push({ key: "tags", label: t("item.tags"), kind: "tags" });
  push({ key: "created", label: t("field.created"), kind: "builtin-date" });
  push({ key: "updated", label: t("field.updated"), kind: "builtin-date" });
  return out;
}

/** The name of a column, sort or group key in the UI language. */
function fieldLabel(key: string, fields: ViewField[], t: T): string {
  if (key === "status" || key === "statusGroup" || key === "type" || key === "path") return t("group." + key);
  if ((FIELDS as readonly string[]).includes(key)) return t("field." + key);
  if (key === "tags") return t("item.tags");
  return fields.find((f) => titleKey(f.key) === titleKey(key))?.label ?? key;
}

// ---------- the panel to set a view up ----------

interface FilterDraft {
  where: Cond | undefined;
  onChange: (where: Cond | undefined) => void;
  dirty: boolean;
  save: () => void;
  discard: () => void;
}

/**
 * How a view looks (kind, grouping, sorting, properties, date) – saved at once – and its own
 * filter, which stays a draft until "Speichern".
 */
export function ViewSettings({ tab, fields, columns, groups = [], onLook, filter, onClose, kinds = TAB_KINDS }: { tab: ViewTab; fields: ViewField[]; columns?: string[]; groups?: Group[]; onLook: (patch: Partial<ViewTab>) => void; filter?: FilterDraft; onClose: () => void; kinds?: ViewKind[] }) {
  const { t } = useT();
  const ix = useIndex();
  const hasStatus = [...ix.types.values()].some((x) => statusProp(x.schema));
  const groupable = [
    ...(hasStatus ? ["status", "statusGroup"] : []),
    "project",
    "area",
    "type",
    "path",
    ...fields.filter((f) => f.prop && (f.kind === "select" || f.kind === "relation") ).map((f) => f.key),
  ];
  const sortable = ["title", ...(hasStatus ? ["status"] : []), ...fields.filter((f) => f.kind !== "relation" && f.kind !== "tags" && f.kind !== "computed" && f.key !== "area" && f.key !== "project").map((f) => f.key)];
  const dates = fields.filter((f) => f.kind === "date" || f.kind === "builtin-date");
  const shown = tab.columns ?? columns ?? []; // none chosen yet: the ones shown by default
  const [dragCol, setDragCol] = useState<string | null>(null);
  const select = "rounded-md border border-line bg-bg px-2 py-1 text-sm";
  const row = "flex flex-wrap items-center gap-2";
  const label = "w-28 shrink-0 text-xs text-muted-foreground";
  const kindsHere = kinds.includes(tab.kind) ? kinds : [...kinds, tab.kind];
  return (
    <div className="mb-4 space-y-3 rounded-xl border border-line bg-surface p-3 text-sm">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
          <Seg label={t("view.label")} value={tab.kind} onChange={(k) => onLook({ kind: k })} options={kindsHere.map((k) => ({ value: k, label: t("view." + k) }))} />
        </div>
        <ShadcnButton variant="plain" size="none" onClick={onClose} className="tap rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("view.closeSettings")}>
          <X size={15} />
        </ShadcnButton>
      </div>

      {filter && <div>
        <p className="mb-1 text-xs text-muted-foreground">{t("view.filter")}</p>
        <QueryEditor def={{ where: filter.where }} onChange={(d) => filter.onChange(d.where)} />
        {filter.dirty && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--focus)] px-2.5 py-1.5" role="status">
            <span className="mr-auto text-muted-foreground">{t("view.draft")}</span>
            <Button variant="outline" onClick={filter.discard}>
              {t("view.discard")}
            </Button>
            <Button variant="primary" onClick={filter.save}>
              {t("view.save")}
            </Button>
          </div>
        )}
      </div>}

      {tab.kind !== "triage" && tab.kind !== "calendar" && (
        <div className={row}>
          <span className={label}>{t("view.groupBy")}</span>
          <NativeSelect value={tab.group ?? ""} onChange={(e) => onLook({ group: e.target.value || undefined })} className={select} aria-label={t("view.groupBy")}>
            <option value="">{t("view.noGroup")}</option>
            {groupable.map((g) => (
              <option key={g} value={g}>
                {fieldLabel(g, fields, t)}
              </option>
            ))}
          </NativeSelect>
          {tab.group && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={!!tab.hideEmpty} onCheckedChange={(checked) => onLook({ hideEmpty: checked === true || undefined })} />
              {t("view.hideEmpty")}
            </label>
          )}
        </div>
      )}
      {tab.group && groups.length > 1 && tab.kind !== "triage" && tab.kind !== "calendar" && (
        <div className={cx(row, "items-start")}>
          <span className={cx(label, "pt-1")}>{t("view.visibleGroups")}</span>
          <ul className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1.5">
            {groups.map((g) => {
              const hidden = (tab.hiddenGroups ?? []).includes(groupId(g));
              return (
                <li key={g.key || "_"}>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <Checkbox
                      checked={!hidden}
                      onCheckedChange={(checked) => onLook({ hiddenGroups: checked === true ? (tab.hiddenGroups ?? []).filter((x) => x !== groupId(g)) : [...(tab.hiddenGroups ?? []), groupId(g)] })}
                    />
                    <GroupChip g={g} by={tab.group!} byLabel={fieldLabel(tab.group!, fields, t)} />
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {tab.kind === "board" && (
        <div className={row}>
          <span className={label}>{t("view.subgroup")}</span>
          <NativeSelect value={tab.subgroup ?? ""} onChange={(e) => onLook({ subgroup: e.target.value || undefined })} className={select} aria-label={t("view.subgroup")}>
            <option value="">{t("view.noGroup")}</option>
            {groupable.filter((g) => g !== (tab.group ?? "status")).map((g) => (
              <option key={g} value={g}>
                {fieldLabel(g, fields, t)}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {(tab.kind === "calendar" || tab.kind === "timeline") && (
        <div className={row}>
          <span className={label}>{t("view.date")}</span>
          <NativeSelect value={tab.date ?? ""} onChange={(e) => onLook({ date: e.target.value || undefined })} className={select} aria-label={t("view.date")}>
            <option value="">{t("view.dateAuto")}</option>
            {dates.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      {tab.kind !== "triage" && (
        <div className={row}>
          <span className={label}>{t("view.sort")}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {(tab.sort ?? []).map((s, n) => (
              <span key={n} className="inline-flex items-center gap-1 rounded-md border border-line bg-bg py-0.5 pl-1 pr-0.5">
                <NativeSelect
                  value={s.key}
                  onChange={(e) => onLook({ sort: (tab.sort ?? []).map((x, m) => (m === n ? { ...x, key: e.target.value } : x)) })}
                  className="bg-transparent text-sm outline-none"
                  aria-label={t("view.sort")}
                >
                  {[...new Set([s.key, ...sortable])].map((k) => (
                    <option key={k} value={k}>
                      {fieldLabel(k, fields, t)}
                    </option>
                  ))}
                </NativeSelect>
                <ShadcnButton variant="plain" size="none" onClick={() => onLook({ sort: (tab.sort ?? []).map((x, m) => (m === n ? { ...x, desc: !x.desc || undefined } : x)) })} className="tap rounded px-1 text-xs text-muted-foreground hover:bg-hover hover:text-fg">
                  {s.desc ? t("view.desc") : t("view.asc")}
                </ShadcnButton>
                <ShadcnButton variant="plain" size="none" onClick={() => onLook({ sort: (tab.sort ?? []).filter((_, m) => m !== n) })} className="tap rounded p-0.5 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("view.sortRemove")}>
                  <X size={12} />
                </ShadcnButton>
              </span>
            ))}
            <ShadcnButton variant="plain" size="none" onClick={() => onLook({ sort: [...(tab.sort ?? []), { key: sortable.find((k) => !(tab.sort ?? []).some((s) => s.key === k)) ?? "title" }] })} className="tap inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover hover:text-fg">
              <Plus size={12} /> {(tab.sort ?? []).length ? t("view.sortMore") : t("view.sortAdd")}
            </ShadcnButton>
          </div>
        </div>
      )}

      {/* properties: columns of a table, lines on board cards (lists and galleries show their own) */}
      {(tab.kind === "table" || tab.kind === "board") && (
        <div className={cx(row, "items-start")}>
          <span className={cx(label, "pt-1")}>{tab.kind === "table" ? t("view.columns") : t("view.cardProps")}</span>
          <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {[...shown.map((k) => fields.find((f) => titleKey(f.key) === titleKey(k)) ?? { key: k, label: fieldLabel(k, fields, t), kind: "text" as const }), ...fields.filter((f) => !shown.some((k) => titleKey(k) === titleKey(f.key)))].map((f) => {
              const on = shown.some((k) => titleKey(k) === titleKey(f.key));
              return (
                <li
                  key={f.key}
                  draggable={on}
                  onDragStart={() => setDragCol(f.key)}
                  onDragOver={(e) => dragCol && on && e.preventDefault()}
                  onDrop={() => {
                    if (!dragCol || dragCol === f.key) return;
                    const rest = shown.filter((k) => k !== dragCol);
                    const at = rest.indexOf(f.key);
                    onLook({ columns: [...rest.slice(0, at), dragCol, ...rest.slice(at)] });
                    setDragCol(null);
                  }}
                >
                  <label className={cx("inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs", on ? "border-line bg-bg text-fg" : "border-dashed border-line text-muted-foreground hover:text-fg")}>
                    {on && <GripVertical size={11} className="cursor-grab text-muted-foreground" aria-hidden />}
                    <Checkbox
                      checked={on}
                      onCheckedChange={(checked) => onLook({ columns: checked === true ? [...shown, f.key] : shown.filter((k) => titleKey(k) !== titleKey(f.key)) })}
                      className="sr-only"
                    />
                    {f.label}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
