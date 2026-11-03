// Live query blocks inside a text: ```abfrage … ``` is stored as JSON with ids and shown
// as its results. Text-form blocks (typed by hand or by an agent) are normalised to JSON.
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StateEffect, StateField, type EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { ListFilter, Pencil, Trash2 } from "lucide-react";
import { type ViewTab, MAIN_TAB, legacyTab, shortId } from "@obtion/core/model";
import { keyBetween, cmpKey } from "@obtion/core/sortkey";
import { type QueryDef, andWhere, blockSource, findBlocks, readBlock, runQuery, queryFence } from "@obtion/core/query";
import { repo } from "../repo";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { Results, defaultColumns, useQuery } from "./Results";
import { viewGroups } from "./groups";
import { type TabEdit, ViewSettings, ViewTabs, tabName, useTabChoice, useViewFields } from "./Views";
import { QueryEditor } from "./QueryEditor";
import { Button, IconButton, InCard, SectionTitle, DraftBar } from "./primitives";
import { cn } from "../lib/utils";
import { sameValue } from "@obtion/core/equal";

/** A block's views: its tabs, or its one look as the only tab. */
function blockTabs(def: QueryDef): ViewTab[] {
  if (def.tabs && def.tabs.length > 1) return def.tabs;
  return [{ ...legacyTab({ display: def.view, sort: def.sort, group: def.group, columns: def.columns }), ...(def.tabs?.[0] ? { widths: def.tabs[0].widths, name: def.tabs[0].name } : {}) }];
}

/** The block's own look ("main") turns into a tab with an id of its own once there are several. */
function promoteMainTab(tabs: ViewTab[]): ViewTab[] {
  return tabs.map((x, i) => (i === 0 && x.id === MAIN_TAB ? { ...x, id: shortId("v") } : x));
}

function QueryBlockView({ src, thisId, n = 0, onChange, onDelete, readOnly }: { src: string; thisId?: string; n?: number; onChange?: (def: QueryDef) => void; onDelete?: () => void; readOnly?: boolean }) {
  const ix = useIndex();
  const { t } = useT();
  const { def: stored } = readBlock(src, ix);
  const [editing, setEditing] = useState(!stored.where && !readOnly);
  // the conditions are a draft until "Speichern" (or the check mark): trying a filter changes
  // nothing. Title, view and "hide when empty" apply at once, like everywhere.
  const [draft, setDraft] = useState<{ scope: string; where: QueryDef["where"] } | null>(null); // scope: "base" or a tab id
  const tabs = blockTabs(stored);
  const [tab, pickTab] = useTabChoice(`block:${thisId}:${n}`, tabs);
  const baseWhere = draft?.scope === "base" ? draft.where : stored.where;
  const tabWhere = draft?.scope === tab.id ? draft.where : tab.where;
  const def: QueryDef = { ...stored, where: baseWhere };
  const savedWhere = draft ? (draft.scope === "base" ? stored.where : tabs.find((x) => x.id === draft.scope)?.where) : undefined;
  const dirty = !!draft && !sameValue(draft.where, savedWhere);
  /** Write the views: several as tabs, a single one as the block's own look (its filter joins the query). */
  const writeTabs = (next: ViewTab[], base: QueryDef = stored) => {
    const first = next[0]!;
    const { tabs: _, ...rest } = base;
    const one = next.length === 1;
    onChange?.({
      ...rest,
      where: one ? andWhere(base.where, first.where) : base.where,
      view: first.kind,
      sort: first.sort,
      group: first.group,
      columns: first.columns,
      tabs: one ? (first.widths || first.name ? [{ ...first, where: undefined }] : undefined) : next,
    });
  };
  const clean = (x: ViewTab) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length))) as unknown as ViewTab;
  const patchTab = (id: string, patch: Partial<ViewTab>) => writeTabs(tabs.map((x) => (x.id === id ? clean({ ...x, ...patch }) : x)));
  const edit = (d: QueryDef) => {
    const { where: _w, ...look } = d;
    const { where: _s, ...was } = stored;
    if (!sameValue(look, was)) onChange?.({ ...look, where: stored.where });
  };
  const save = () => {
    if (dirty && onChange && draft) {
      if (draft.scope === "base") onChange({ ...stored, where: draft.where });
      else patchTab(draft.scope, { where: draft.where });
    }
    setDraft(null);
  };
  const tabEdit: TabEdit = {
    add: (kind) => {
      const id = shortId("v");
      // the first time: the block's own look becomes the first tab
      const base = promoteMainTab(tabs);
      writeTabs([...base, { id, pos: keyBetween(base.at(-1)?.pos ?? null, null), kind, ...(kind === "board" ? { group: "status" } : {}) }]);
      pickTab(id);
    },
    rename: (id, name) => patchTab(id, { name: name || undefined }),
    duplicate: (id) => {
      const original = tabs.find((x) => x.id === id)!;
      const i = tabs.indexOf(original);
      const copyId = shortId("v");
      const copy = { ...original, id: copyId, name: t("view.copyName", { name: tabName(original, t) }), pos: keyBetween(original.pos, tabs[i + 1]?.pos ?? null) };
      writeTabs(promoteMainTab([...tabs.slice(0, i + 1), copy, ...tabs.slice(i + 1)]));
      pickTab(copyId);
    },
    remove: (id) => writeTabs(tabs.filter((x) => x.id !== id)),
    move: (id, pos) => writeTabs(tabs.map((x) => (x.id === id ? { ...x, pos } : x)).sort((a, b) => cmpKey(a.pos, b.pos))),
    settings: () => setEditing(true),
  };
  const eff: QueryDef = { ...def, where: andWhere(def.where, tabWhere), view: tab.kind, sort: tab.sort, group: tab.group, columns: tab.columns };
  const { items, ctx } = useQuery(eff, thisId);
  const fields = useViewFields(def.where, items);
  if (def.hideEmpty && !items.length && !editing) return <div className="h-0" />;
  const showTabs = tabs.length > 1 || (editing && !!onChange);
  const finish = () => (save(), setEditing(false));
  const editable = editing && !!onChange;
  const label = "w-28 shrink-0 pt-2 text-xs text-muted-foreground max-sm:w-full max-sm:pt-0";
  const tools = !readOnly && (
    <span className={cn("qb-tools flex shrink-0 items-center gap-1", !editing && "opacity-0 transition-opacity focus-within:opacity-100 group-hover/qb:opacity-100")}>
      {editing ? (
        <Button variant="primary" onClick={finish} className="py-1 text-[13px]">
          {t("block.done")}
        </Button>
      ) : (
        <IconButton size="sm" icon={Pencil} iconSize={14} onClick={() => setEditing(true)} label={t("block.edit")} />
      )}
      <IconButton size="sm" icon={Trash2} iconSize={14} onClick={onDelete} label={t("block.delete")} className="hover:text-danger" />
    </span>
  );
  return (
    // a card of its own in the text: what it shows comes from elsewhere. Padding, not margin,
    // around it: CodeMirror leaves a block widget's margins out of its heights
    <div className="py-3" contentEditable={false}>
    <div className="group/qb relative rounded-xl border border-line bg-surface">
      {editable ? (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 max-sm:px-3" data-handle-anchor>
          <ListFilter size={15} className="shrink-0 text-muted-foreground" aria-hidden />
          <span className="mr-auto text-sm font-medium">{t("block.edit")}</span>
          {tools}
        </div>
      ) : def.title ? (
        <div className="flex items-start gap-2 px-4 pt-3 max-sm:px-3">
          <div className="min-w-0 flex-1" data-handle-anchor>
            <SectionTitle className="mb-1" count={items.length || undefined}>
              {def.title}
            </SectionTitle>
          </div>
          <span className="mt-0.5">{tools}</span>
        </div>
      ) : (
        tools && <span className="absolute right-2 top-2 z-10 rounded-lg bg-surface">{tools}</span>
      )}
      {editable && (
        <div className="space-y-3 border-b border-line bg-surface-2/50 px-4 py-3 text-sm max-sm:px-3">
          <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <span className={label}>{t("block.heading")}</span>
            <Input
              variant="sm"
              defaultValue={def.title ?? ""}
              onBlur={(e) => (e.target.value.trim() || undefined) !== def.title && edit({ ...stored, title: e.target.value.trim() || undefined })}
              placeholder={t("block.title")}
              aria-label={t("block.heading")}
              className="min-w-0 flex-1 rounded-lg bg-bg py-1.5"
            />
          </div>
          <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <span className={label}>{t("block.conditions")}</span>
            <div className="min-w-0 flex-1 space-y-2">
              <QueryEditor context def={{ where: baseWhere }} autoFocus={!def.where} onChange={(d) => !sameValue(d.where, baseWhere) && setDraft({ scope: "base", where: d.where })} />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={!!def.hideEmpty} onCheckedChange={(checked) => edit({ ...stored, hideEmpty: checked === true || undefined })} />
                {t("block.hideEmpty")}
              </label>
              {dirty && draft?.scope === "base" && <DraftBar onDiscard={() => setDraft(null)} onSave={save} className="bg-bg" />}
            </div>
          </div>
        </div>
      )}
      <div className={cn("px-4 pb-3 max-sm:px-3", (editable || !def.title) && "pt-3")}>
        <div data-handle-anchor={!editable && !def.title ? "" : undefined}>
        {showTabs && <ViewTabs tabs={tabs} active={tab.id} onPick={pickTab} edit={onChange && !readOnly ? tabEdit : undefined} />}
        {editable && (
          <ViewSettings
            flat
            tab={{ ...tab, where: tabWhere }}
            fields={fields}
            columns={tab.kind === "table" ? defaultColumns(items, ctx) : undefined}
            groups={viewGroups(items, eff, ctx)}
            onLook={(p) => patchTab(tab.id, p)}
            onClose={finish}
            filter={tabs.length > 1 ? { where: tabWhere, onChange: (x) => !sameValue(x, tabWhere) && setDraft({ scope: tab.id, where: x }), dirty: dirty && draft?.scope === tab.id, save, discard: () => setDraft(null) } : undefined}
          />
        )}
        {/* a new block shows nothing until it has a condition (not "everything") */}
        {!def.where ? (
          <p className="py-1 text-sm text-muted-foreground">{t("query.start")}</p>
        ) : (
          <InCard.Provider value>
          <Results
            def={eff}
            thisId={thisId}
            keyPrefix={`block:${thisId}`}
            look={{ key: `block:${thisId}:${n}:${tab.id}`, tab, onLook: onChange && !readOnly ? (p) => patchTab(tab.id, p) : undefined }}
            empty={<p className="px-0 py-1 text-sm text-muted-foreground">{def.where && "inbox" in def.where ? t("inbox.emptyShort") : t("query.empty")}</p>}
          />
          </InCard.Provider>
        )}
        </div>
      </div>
    </div>
    </div>
  );
}

/** The `n`th query block in the editor's current text. */
const blockAt = (view: EditorView, n: number) => findBlocks(view.state.doc.toString())[n];

/** Kept per element so a changed block keeps its React root in updateDOM. */
const roots = new WeakMap<HTMLElement, Root>();

class BlockWidget extends WidgetType {
  root?: Root;
  constructor(
    readonly src: string,
    readonly n: number,
    readonly thisId?: string,
  ) {
    super();
  }
  override eq(o: BlockWidget) {
    return o.src === this.src && o.n === this.n;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-queryblock";
    this.root = createRoot(el);
    roots.set(el, this.root);
    this.mount(view);
    return el;
  }
  /** A changed block keeps its element and React state (editing, chosen tab): only new props. */
  override updateDOM(dom: HTMLElement, view: EditorView) {
    const root = roots.get(dom);
    if (!root) return false;
    this.root = root;
    this.mount(view);
    return true;
  }
  mount(view: EditorView) {
    const replace = (text: string) => {
      const block = blockAt(view, this.n);
      if (block) view.dispatch({ changes: { from: block.from, to: block.to, insert: text } });
    };
    const { wasText, def } = readBlock(this.src, repo.index());
    if (wasText) queueMicrotask(() => replace(queryFence(blockSource(def))));
    this.root!.render(
      <StrictMode>
        <QueryBlockView
          src={this.src}
          thisId={this.thisId}
          n={this.n}
          onChange={(d) => replace(queryFence(blockSource(d)))}
          onDelete={() => {
            const block = blockAt(view, this.n);
            if (block) view.dispatch({ changes: { from: block.from, to: Math.min(view.state.doc.length, block.to + 1), insert: "" } });
          }}
        />
      </StrictMode>,
    );
  }
  override destroy() {
    const root = this.root;
    setTimeout(() => root?.unmount());
  }
  override ignoreEvent() {
    return true;
  }
}

function decos(state: EditorState, thisId?: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  findBlocks(state.doc.toString()).forEach((blk, n) => {
    builder.add(blk.from, blk.to, Decoration.replace({ widget: new BlockWidget(blk.src, n, thisId), block: true }));
  });
  return builder.finish();
}

// A heading whose section holds only query blocks that hide when empty disappears with them
// when none of them has results ("Kürzlich erledigt" on a quiet week). It comes back as soon
// as one of them finds something.

const refresh = StateEffect.define<null>();

/** The level of a Markdown heading line (1–6), or undefined. */
const headingLevel = (text: string) => /^(#{1,6})\s/.exec(text)?.[1]!.length;

function emptySections(state: EditorState, thisId?: string): DecorationSet {
  const text = state.doc.toString();
  const blocks = findBlocks(text);
  const builder = new RangeSetBuilder<Decoration>();
  if (!blocks.some((x) => x.src.includes('"hideEmpty":true'))) return builder.finish();
  const ix = repo.index();
  const empty = (src: string) => {
    const { def } = readBlock(src, ix);
    return !!def.hideEmpty && runQuery(def, { ix, thisId }).total === 0;
  };
  const doc = state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const level = headingLevel(line.text);
    if (!level) continue;
    // the section: blank lines and blocks up to the next heading of this level or higher
    let pos = line.to + 1;
    let inSection = 0;
    let allEmpty = true;
    let end = line.to;
    while (pos <= doc.length) {
      const blk = blocks.find((x) => x.from === pos);
      if (blk) {
        inSection++;
        if (!empty(blk.src)) allEmpty = false;
        end = blk.to;
        pos = blk.to + 1;
        continue;
      }
      const next = doc.lineAt(pos);
      const nextLevel = headingLevel(next.text);
      if (nextLevel && nextLevel <= level) break;
      if (next.text.trim()) {
        allEmpty = false; // the section has text of its own
        break;
      }
      pos = next.to + 1;
    }
    if (!inSection || !allEmpty) continue;
    // hide the heading and the blank lines that belong to it (the blocks hide themselves)
    let from = line.from;
    while (from > 0) {
      const prev = doc.lineAt(from - 1);
      if (prev.text.trim()) break;
      from = prev.from;
    }
    const firstBlock = blocks.find((x) => x.from > line.to && x.to <= end)!;
    const to = Math.max(line.to, firstBlock.from - 1);
    if (from < to) builder.add(from, to, Decoration.replace({ block: true }));
  }
  return builder.finish();
}

export function queryBlocks(thisId?: string): Extension {
  const field = StateField.define<DecorationSet>({
    create: (s) => decos(s, thisId),
    update: (d, tr) => (tr.docChanged ? decos(tr.state, thisId) : d),
    provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
  });
  const sections = StateField.define<DecorationSet>({
    create: (s) => emptySections(s, thisId),
    update: (d, tr) => (tr.docChanged || tr.effects.some((e) => e.is(refresh)) ? emptySections(tr.state, thisId) : d),
    provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
  });
  // data changed (not the text): check again whether the sections are still empty
  const watch = ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = repo.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => view.dispatch({ effects: refresh.of(null) }), 50);
    });
    return { destroy: () => (clearTimeout(timer), off()) };
  });
  return [field, sections, watch];
}

/** The new block opens in edit mode. */
export function insertQueryBlock(view: EditorView, def: QueryDef = {}) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const at = line.length ? line.to : pos;
  const text = (line.length ? "\n" : "") + queryFence(blockSource(def)) + "\n";
  view.dispatch({ changes: { from: at, insert: text } });
}
