import { Table as ShadcnTable, TableHeader, TableBody, TableRow, TableHead, TableCell as ShadcnTableCell } from "../components/ui/table";
import { Input } from "../components/ui/input";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { type ViewTab, type Item, type ItemInit, type PropDef, type StatusGroup, type TypeSchema, parseRange, propByName, titleKey } from "@obtion/core/model";
import { type EvalCtx, type Group, type QueryDef, FIELDS, fieldOf, groupItems, pathBase, viewTypeIds } from "@obtion/core/query";
import { fmtDate } from "@obtion/core/i18n";
import { firstOfGroup, statusProp } from "@obtion/core/traits";
import { repo } from "../repo";
import { itemHref, useIndex, useNarrow, useStoredSet } from "../hooks";
import { useT, titleOf } from "../i18n";
import { DateField, InlineText } from "./fields";
import { EmptyDash, ItemIcon } from "./item-look";
import { Button, IconButton, MenuItem, MoreMenu, Popover } from "./primitives";
import { PercentBar } from "./progress";
import { startPointerDrag } from "../lib/drag";
import { cn, moveInArray } from "../lib/utils";
import { OptionSelect, PropertyField, RangeEditor } from "./Properties";
import { AreaChip, GroupChip, HiddenGroups, fieldLabel, hiddenPatch, splitHidden } from "./groups";
import { CellValue, defaultColumns } from "./Results";
import { treeOrder } from "./Row";
import { KEYS } from "./storage";

/** What a view adds to the query when showing it: its tab (grouping options, widths) and how to save. */
export interface Look {
  key: string; // per-device state: folded groups, opened sub-items
  tab?: ViewTab;
  onLook?: (patch: Partial<ViewTab>) => void;
  /** "+ Task" in each group: new entries of this type (with the group's value). */
  add?: { type: string; init?: ItemInit };
}

/** Bounds for a column width dragged by its border. */
const MIN_WIDTH = 60;
const MAX_WIDTH = 800;

const WIDTH: Record<string, number> = { status: 150, select: 130, multiselect: 170, date: 130, range: 230, computed: 160, relation: 190, text: 220, number: 100, checkbox: 80, url: 180, item: 170, tags: 170 };

/** A select is as wide as what it holds: one option or several. */
function widthKey(p: PropDef): string {
  if (p.kind === "date" && p.range) return "range";
  return p.kind === "select" && p.multiple ? "multiselect" : p.kind;
}

function defaultWidth(col: string, items: Item[], ctx: EvalCtx): number {
  if (col === "title") return 300;
  if (col === "area") return 130;
  if (col === "project") return 190;
  if (col === "tags") return WIDTH.tags!;
  if ((FIELDS as readonly string[]).includes(col)) return 120;
  for (const i of items.slice(0, 30)) {
    const hit = fieldOf(i, col, ctx.ix);
    if (hit?.prop) return WIDTH[widthKey(hit.prop)] ?? 160;
    if (hit) return WIDTH[hit.kind] ?? 160;
  }
  return 160;
}

/** A property's value if it is text. */
const textProp = (item: Item, id: string) => (typeof item.props[id] === "string" ? (item.props[id] as string) : undefined);

function RangeCell({ item, prop }: { item: Item; prop: PropDef }) {
  const { t, lang } = useT();
  const value = textProp(item, prop.id) ?? "";
  const { start, end } = parseRange(value);
  return (
    <Popover
      trigger={(p) => (
        <Button variant="plain" {...p} className="tap-y w-full truncate text-left tabular-nums hover:text-fg" aria-label={t("props.set", { name: prop.name })}>
          {start || end ? `${start ? fmtDate(lang, start) : "…"} – ${end ? fmtDate(lang, end) : "…"}` : <span className="text-muted-foreground">{t("props.empty")}</span>}
        </Button>
      )}
    >
      <RangeEditor value={value} onChange={(x) => repo.setProp(item.id, prop.id, x || null)} autoFocus={!start} className="p-2 text-sm" />
    </Popover>
  );
}

/** Editable in place only where `col` is a property of the entry's type. */
export function TableCell({ item, col, ctx }: { item: Item; col: string; ctx: EvalCtx }) {
  const { t } = useT();
  const ix = ctx.ix;
  if (col === "area") {
    const area = ix.area(item.id);
    return area ? <AreaChip id={area} /> : <EmptyDash />;
  }
  if (col === "progress") {
    const progress = ix.progressOf(item);
    return progress ? <PercentBar done={progress.done} total={progress.total} /> : <EmptyDash />;
  }
  const hit = fieldOf(item, col, ix);
  const prop = hit?.prop;
  const own = prop && !hit.inverse && ix.schemaOf(item)?.properties.some((x) => x.id === prop.id);
  if (prop?.kind === "computed" && prop.computed?.fn !== "count") {
    const progress = ix.progress(item.id, prop.computed?.of);
    return <PercentBar done={progress.done} total={progress.total} />;
  }
  if (!own || !prop) return <CellValue item={item} name={col} ctx={ctx} />;
  switch (prop.kind) {
    case "status":
    case "select":
      if (prop.multiple) return <span className="cell-tools flex min-w-0 items-center gap-1 overflow-hidden"><PropertyField item={item} prop={prop} /></span>;
      return <OptionSelect item={item} prop={prop} className="flex min-h-6 w-full" />;
    case "date":
      return prop.range ? (
        <RangeCell item={item} prop={prop} />
      ) : (
        <span className="cell-tools block">
          <DateField value={textProp(item, prop.id)} label={prop.name} onChange={(x) => repo.setProp(item.id, prop.id, x || null)} />
        </span>
      );
    case "text":
    case "url":
      return <InlineText value={String(item.props[prop.id] ?? "")} onCommit={(x) => repo.setProp(item.id, prop.id, x.trim() || null)} placeholder={t("props.empty")} label={prop.name} className="truncate" />;
    default:
      return (
        <span className="cell-tools flex min-w-0 items-center gap-1 overflow-hidden">
          <PropertyField item={item} prop={prop} />
        </span>
      );
  }
}

export function GroupedTable({ items, def, ctx, look }: { items: Item[]; def: QueryDef; ctx: EvalCtx; look?: Look }) {
  const { t } = useT();
  const ix = ctx.ix;
  const key = look?.key ?? "";
  const tab = look?.tab;
  const cols = def.columns?.length ? def.columns : defaultColumns(items, ctx);
  const typeIds = viewTypeIds(def.where, items, ix);
  const by = def.group;
  // empty groups show too (every type, every option) unless the view hides them
  const allGroups = () => groupItems(items, by!, ctx, pathBase(def, ctx), tab?.hideEmpty ? undefined : { types: typeIds, where: def.where }).filter((g) => !tab?.hideEmpty || g.items.length);
  const all = by ? allGroups() : [{ key: "", items } as Group];
  const [groups, hiddenGroups] = by ? splitHidden(all, tab) : [all, []];
  // grouped by place with everything on this level: one table without a heading
  const heads = !!by && !(by === "path" && all.length === 1 && !all[0]!.key);
  const [folded, fold, setFolded] = useStoredSet(KEYS.fold(key));
  const [opened, open] = useStoredSet(KEYS.open(key));
  // widths: saved per view; while dragging a border only here
  const [live, setLive] = useState<Record<string, number>>({});
  const width = (c: string) => live[c] ?? tab?.widths?.[c] ?? defaultWidth(c, items, ctx);
  // on a phone the title column leaves room for the next one; the table scrolls sideways
  const narrow = useNarrow();
  const titleW = narrow ? Math.min(width("title"), 190) : width("title");
  const total = titleW + cols.reduce((s, c) => s + width(c), 0);
  const label = (c: string) => {
    if ((FIELDS as readonly string[]).includes(c)) return t("field." + c);
    if (c === "tags") return t("item.tags");
    for (const i of items) {
      const hit = fieldOf(i, c, ix);
      if (hit?.prop) return hit.prop.name;
      const free = Object.keys(i.extra).find((n) => n.toLowerCase() === c.toLowerCase());
      if (free) return free;
    }
    return c;
  };
  const byLabel = by ? fieldLabel(by, t, [{ key: by, label: label(by) }]) : "";
  const [dragCol, setDragCol] = useState<string | null>(null);
  const resize = (c: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = width(c);
    let w = w0;
    startPointerDrag(
      (ev) => ((w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w0 + ev.clientX - x0)))), setLive((l) => ({ ...l, [c]: w }))),
      () => {
        if (w !== w0) look?.onLook?.({ widths: { ...(tab?.widths ?? {}), [c]: w } });
        setTimeout(() =>
          setLive((l) => {
            const { [c]: _, ...rest } = l;
            return rest;
          }), 0);
      },
    );
  };
  const sticky = "sticky left-0 z-[1] bg-bg";
  // the last, empty column takes the rest of the row, so a table with few columns still spans the page
  // (up to the right edge of the content: the wrapper reaches 0.5rem past it on both sides)
  const filler = "border-b border-l border-line p-0";
  const head = (
    <TableHeader>
      <TableRow className="text-left text-xs text-muted-foreground">
        <TableHead className={cn(sticky, "relative border-b border-line px-2 py-1.5 font-medium")}>
          {t("field.title")}
          {look?.onLook && <Resizer onPointerDown={(e) => resize("title", e)} />}
        </TableHead>
        {cols.map((c) => (
          <TableHead
            key={c}
            draggable={!!look?.onLook}
            onDragStart={() => setDragCol(c)}
            onDragEnd={() => setDragCol(null)}
            onDragOver={(e) => dragCol && e.preventDefault()}
            onDrop={() => {
              if (!dragCol || dragCol === c) return;
              const from = cols.indexOf(dragCol);
              const to = cols.indexOf(c);
              look?.onLook?.({ columns: moveInArray(cols, from, from < to ? to + 1 : to) });
            }}
            className="relative truncate whitespace-nowrap border-b border-l border-line px-2 py-1.5 font-medium"
          >
            {label(c)}
            {look?.onLook && <Resizer onPointerDown={(e) => resize(c, e)} />}
          </TableHead>
        ))}
        <TableHead className={filler} aria-hidden />
      </TableRow>
    </TableHeader>
  );
  const colgroup = (
    <colgroup>
      <col style={{ width: titleW }} />
      {cols.map((c) => (
        <col key={c} style={{ width: width(c) }} />
      ))}
      <col />
    </colgroup>
  );
  const rows = (g: Group) => {
    const order = treeOrder(g.items);
    const out: React.ReactNode[] = [];
    let hideBelow = Infinity;
    order.forEach(({ item: i, depth }, n) => {
      if (depth > hideBelow) return;
      hideBelow = Infinity;
      const kids = countKids(order, n);
      const isOpen = opened.has(i.id);
      if (kids && !isOpen) hideBelow = depth;
      out.push(
        <TableRow key={i.id} data-id={i.id} className="group/row hover:bg-hover">
          <ShadcnTableCell className={cn(sticky, "border-b border-line px-2 py-1 align-middle group-hover/row:bg-hover")}>
            <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 20 }}>
              {kids ? (
                <IconButton size="xs" icon={isOpen ? ChevronDown : ChevronRight} iconSize={14} onClick={() => open(i.id, !isOpen)} aria-expanded={isOpen} label={t(isOpen ? "table.closeSub" : "table.openSub", { count: kids })} className="-ml-1 shrink-0 hover:bg-surface-2" />
              ) : (
                depth > 0 && <span className="w-4 shrink-0" />
              )}
              <a href={itemHref(i.id)} className="flex min-w-0 items-center gap-2 hover:underline">
                <ItemIcon item={i} size={14} className="shrink-0" />
                <span className="truncate font-medium">{titleOf(i, t)}</span>
              </a>
              {kids > 0 && !isOpen && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{kids}</span>}
            </span>
          </ShadcnTableCell>
          {cols.map((c) => (
            <ShadcnTableCell key={c} className="overflow-hidden border-b border-l border-line px-2 py-1 align-middle text-muted-foreground">
              <TableCell item={i} col={c} ctx={ctx} />
            </ShadcnTableCell>
          ))}
          <ShadcnTableCell className={filler} aria-hidden />
        </TableRow>,
      );
    });
    return out;
  };
  const addInit = (g: Group): ItemInit | undefined => {
    if (!look?.add) return undefined;
    const schema = ix.types.get(look.add.type)?.schema;
    const init: ItemInit = { ...look.add.init, type: look.add.type, props: { ...(look.add.init?.props ?? {}) } };
    if (!by || !g.key) return init;
    if (by === "status" && g.option) init.props![statusProp(schema)?.id ?? ""] = g.option.id;
    else if (by === "statusGroup") {
      const option = firstOfGroup(schema, g.key as StatusGroup);
      if (option) init.props![statusProp(schema)!.id] = option.id;
    } else if (by === "type") init.type = g.key;
    else if (by === "path" && g.path?.length) init.parents = [g.path.at(-1)!];
    else if (g.option) {
      const prop = propByName(schema, by);
      if (prop) init.props![prop.id] = prop.multiple ? [g.option.id] : g.option.id;
    } else if (g.ref && (by === "project" || by === "area")) init.parents = [g.ref];
    else if (g.ref) {
      const prop = propByName(schema, by, (x) => x.kind === "relation");
      if (prop) init.rels = { [prop.id]: [g.ref] };
    }
    return init;
  };
  const allKeys = groups.map((g) => g.key);
  return (
    <div className="-mx-2 overflow-x-auto pb-2 text-sm">
      {groups.map((g) => {
        const isFolded = heads ? folded.has(g.key) : false;
        const init = addInit(g);
        return (
          <section key={g.key || "_"} className={heads ? "mb-5" : undefined} aria-label={heads ? g.label || g.key || byLabel : undefined}>
            {heads && (
              <div className="group/head sticky left-0 flex w-fit max-w-full items-center gap-2 px-2 py-1.5">
                <IconButton size="xs" icon={isFolded ? ChevronRight : ChevronDown} iconSize={15} onClick={() => fold(g.key, !isFolded)} aria-expanded={!isFolded} label={t(isFolded ? "table.unfold" : "table.fold")} className="-ml-1" />
                <GroupChip g={g} by={by} byLabel={byLabel} />
                <span className="text-xs tabular-nums text-muted-foreground">{g.items.length}</span>
                <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/head:opacity-100 pointer-coarse:opacity-100">
                  <MoreMenu align="left" size="xs" iconSize={15} label={t("table.groupMenu")}>
                    {(close) => (
                      <>
                        {look?.onLook && <MenuItem onClick={() => (close(), look.onLook!(hiddenPatch(tab, g, true)))}>{t("view.hideGroup")}</MenuItem>}
                        <MenuItem onClick={() => (close(), setFolded(allKeys.filter((k) => k !== g.key)))}>{t("table.foldOthers")}</MenuItem>
                        <MenuItem onClick={() => (close(), setFolded([]))}>{t("table.unfoldAll")}</MenuItem>
                        {look?.onLook && (
                          <MenuItem active={!!tab?.hideEmpty} onClick={() => (close(), look.onLook!({ hideEmpty: !tab?.hideEmpty || undefined }))}>
                            {t("view.hideEmpty")}
                          </MenuItem>
                        )}
                      </>
                    )}
                  </MoreMenu>
                  {init && <NewRowButton init={init} label={t("table.addIn", { name: ix.typeName(init.type ?? null) ?? "" })} compact />}
                </span>
              </div>
            )}
            {!isFolded && (
              <ShadcnTable className="table-fixed border-collapse" style={{ width: "calc(100% - 0.5rem)", minWidth: total }}>
                {colgroup}
                {head}
                <TableBody>{rows(g)}</TableBody>
              </ShadcnTable>
            )}
            {!isFolded && init && (
              <div className="sticky left-0 w-fit">
                <NewRowButton init={init} label={t("table.addIn", { name: ix.typeName(init.type ?? null) ?? "" })} />
              </div>
            )}
          </section>
        );
      })}
      {by && <HiddenGroups groups={hiddenGroups} by={by} byLabel={byLabel} onShow={look?.onLook ? (g) => look.onLook!(hiddenPatch(tab, g, false)) : undefined} />}
    </div>
  );
}

function Resizer({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return <span onPointerDown={onPointerDown} onDragStart={(e) => e.preventDefault()} className="absolute -right-1 top-0 z-[2] h-full w-2 cursor-col-resize touch-none hover:bg-focus/40" aria-hidden />;
}

/** Number of sub-items right after row n (deeper rows until one at the same depth or above). */
function countKids(order: { depth: number }[], n: number): number {
  const depth = order[n]!.depth;
  let count = 0;
  for (let m = n + 1; m < order.length && order[m]!.depth > depth; m++) if (order[m]!.depth === depth + 1) count++;
  return count;
}

/** Nothing is created before there is a title. */
export function NewRowButton({ init, label, compact }: { init: ItemInit; label: string; compact?: boolean }) {
  const { t } = useT();
  const ix = useIndex();
  const aria = t("view.new", { name: ix.typeName(init.type ?? null) ?? "" });
  const [typing, setTyping] = useState(false);
  const [title, setTitle] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => void (typing && ref.current?.focus()), [typing]);
  const create = () => {
    const trimmed = title.trim();
    if (trimmed) repo.create({ ...init, title: trimmed });
    setTitle("");
    return !!trimmed;
  };
  if (typing)
    return (
      <Input
        variant="sm"
        ref={ref}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => (create(), setTyping(false))}
        onKeyDown={(e) => {
          if (e.key === "Enter") create(); // and the next one
          if (e.key === "Escape") (setTitle(""), setTyping(false));
        }}
        placeholder={t("table.newTitle")}
        aria-label={aria}
        className={compact ? "w-48" : "ml-2 mt-1 w-72"}
      />
    );
  return compact ? (
    <IconButton size="xs" icon={Plus} iconSize={15} onClick={() => setTyping(true)} label={aria} />
  ) : (
    <Button variant="plain" onClick={() => setTyping(true)} aria-label={aria} className="tap-y flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted-foreground hover:text-fg">
      <Plus size={14} /> {label}
    </Button>
  );
}
