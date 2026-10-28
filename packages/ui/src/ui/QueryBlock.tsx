import { Checkbox } from "../components/ui/checkbox";
import { Button as ShadcnButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
// Live query blocks inside a text: ```abfrage … ``` is stored as JSON with ids and shown
// as its results. Text-form blocks (typed by hand or by an agent) are normalised to JSON.
import { StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StateEffect, StateField, type EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { Pencil, Trash2, Check } from "lucide-react";
import { type ViewTab, MAIN_TAB, legacyTab, shortId } from "@obtion/core/model";
import { keyBetween } from "@obtion/core/sortkey";
import { type QueryDef, andWhere, blockSource, findBlocks, readBlock, runQuery } from "@obtion/core/query";
import { repo } from "../repo";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { Results, defaultColumns, useQuery } from "./Results";
import { viewGroups } from "./Table";
import { type TabEdit, ViewSettings, ViewTabs, tabName, useTabChoice, useViewFields } from "./Views";
import { QueryEditor } from "./QueryEditor";
import { Button, SectionTitle } from "./bits";

/** A block's views: its tabs, or its one look as the only tab. */
function blockTabs(def: QueryDef): ViewTab[] {
  if (def.tabs && def.tabs.length > 1) return def.tabs;
  return [{ ...legacyTab({ display: def.view, sort: def.sort, group: def.group, columns: def.columns }), ...(def.tabs?.[0] ? { widths: def.tabs[0].widths, name: def.tabs[0].name } : {}) }];
}

export function QueryBlockView({ src, thisId, n = 0, onChange, onDelete, readOnly }: { src: string; thisId?: string; n?: number; onChange?: (def: QueryDef) => void; onDelete?: () => void; readOnly?: boolean }) {
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
  const dirty = !!draft && JSON.stringify(draft.where) !== JSON.stringify(savedWhere);
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
    if (JSON.stringify(look) !== JSON.stringify(was)) onChange?.({ ...look, where: stored.where });
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
      const base = tabs.map((x, i) => (i === 0 && x.id === MAIN_TAB ? { ...x, id: shortId("v") } : x));
      writeTabs([...base, { id, pos: keyBetween(base.at(-1)?.pos ?? null, null), kind, ...(kind === "board" ? { group: "status" } : {}) }]);
      pickTab(id);
    },
    rename: (id, name) => patchTab(id, { name: name || undefined }),
    duplicate: (id) => {
      const src = tabs.find((x) => x.id === id)!;
      const i = tabs.indexOf(src);
      const nid = shortId("v");
      writeTabs([...tabs.slice(0, i + 1), { ...src, id: nid, name: t("view.copyName", { name: tabName(src, t) }), pos: keyBetween(src.pos, tabs[i + 1]?.pos ?? null) }, ...tabs.slice(i + 1)].map((x, j) => (j === 0 && x.id === MAIN_TAB ? { ...x, id: shortId("v") } : x)));
      pickTab(nid);
    },
    remove: (id) => writeTabs(tabs.filter((x) => x.id !== id)),
    move: (id, pos) => writeTabs(tabs.map((x) => (x.id === id ? { ...x, pos } : x)).sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0))),
    settings: () => setEditing(true),
  };
  const eff: QueryDef = { ...def, where: andWhere(def.where, tabWhere), view: tab.kind, sort: tab.sort, group: tab.group, columns: tab.columns };
  const { items, ctx } = useQuery(eff, thisId);
  const fields = useViewFields(def.where, items);
  if (def.hideEmpty && !items.length && !editing) return <div className="h-0" />;
  const showTabs = tabs.length > 1 || (editing && !!onChange);
  return (
    <div className="group/qb relative my-1 rounded-xl border border-transparent px-0 py-0.5 hover:border-line" contentEditable={false}>
      {/* the same head as every section of a page: title and count */}
      {def.title && (
        <SectionTitle className="mb-1 pr-16" count={items.length || undefined}>
          {def.title}
        </SectionTitle>
      )}
      {!readOnly && (
          <span className="qb-tools absolute right-1 top-1 z-10 flex gap-0.5 rounded-md bg-bg opacity-0 transition-opacity group-hover/qb:opacity-100">
            <ShadcnButton variant="plain" size="none" onClick={() => (editing && save(), setEditing(!editing))} className="tap rounded p-1 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={editing ? t("view.save") : t("block.edit")}>
              {editing ? <Check size={13} /> : <Pencil size={13} />}
            </ShadcnButton>
            <ShadcnButton variant="plain" size="none" onClick={onDelete} className="tap rounded p-1 text-muted-foreground hover:bg-hover hover:text-danger" aria-label={t("block.delete")}>
              <Trash2 size={13} />
            </ShadcnButton>
          </span>
      )}
      {editing && onChange && (
        <div className="my-2 space-y-2">
          <Input
            defaultValue={def.title ?? ""}
            onBlur={(e) => (e.target.value.trim() || undefined) !== def.title && edit({ ...stored, title: e.target.value.trim() || undefined })}
            placeholder={t("block.title")}
            className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-sm outline-none"
          />
          <QueryEditor context def={{ where: baseWhere }} autoFocus={!def.where} onChange={(d) => JSON.stringify(d.where) !== JSON.stringify(baseWhere) && setDraft({ scope: "base", where: d.where })} />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <Checkbox  checked={!!def.hideEmpty} onCheckedChange={(checked) => edit({ ...stored, hideEmpty: (checked === true) || undefined })} className="accent-[var(--focus)]" />
            {t("block.hideEmpty")}
          </label>
          {dirty && draft?.scope === "base" && <DraftBar onDiscard={() => setDraft(null)} onSave={save} />}
        </div>
      )}
      {showTabs && <ViewTabs tabs={tabs} active={tab.id} onPick={pickTab} edit={onChange && !readOnly ? tabEdit : undefined} />}
      {editing && onChange && (
        <ViewSettings
          tab={{ ...tab, where: tabWhere }}
          fields={fields}
          columns={tab.kind === "table" ? defaultColumns(items, ctx) : undefined}
          groups={viewGroups(items, eff, ctx)}
          onLook={(p) => patchTab(tab.id, p)}
          onClose={() => (save(), setEditing(false))}
          filter={tabs.length > 1 ? { where: tabWhere, onChange: (x) => JSON.stringify(x) !== JSON.stringify(tabWhere) && setDraft({ scope: tab.id, where: x }), dirty: dirty && draft?.scope === tab.id, save, discard: () => setDraft(null) } : undefined}
        />
      )}
      {/* a new block shows nothing until it has a condition (not "everything") */}
      {!def.where ? (
        <p className="py-1 text-sm text-muted-foreground">{t("query.start")}</p>
      ) : (
      <Results
        def={eff}
        thisId={thisId}
        compact
        keyPrefix={`block:${thisId}`}
        look={{ key: `block:${thisId}:${n}:${tab.id}`, tab, onLook: onChange && !readOnly ? (p) => patchTab(tab.id, p) : undefined }}
        empty={<p className="px-0 py-1 text-sm text-muted-foreground">{def.where && "inbox" in def.where ? t("inbox.emptyShort") : t("query.empty")}</p>}
      />
      )}
    </div>
  );
}

function DraftBar({ onDiscard, onSave }: { onDiscard: () => void; onSave: () => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--focus)] px-2.5 py-1.5 text-sm" role="status">
      <span className="mr-auto text-muted-foreground">{t("view.draft")}</span>
      <Button variant="outline" onClick={onDiscard}>
        {t("view.discard")}
      </Button>
      <Button variant="primary" onClick={onSave}>
        {t("view.save")}
      </Button>
    </div>
  );
}

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
    (el as any).qbRoot = this.root;
    this.mount(view);
    return el;
  }
  /** A changed block keeps its element and React state (editing, chosen tab): only new props. */
  override updateDOM(dom: HTMLElement, view: EditorView) {
    const root = (dom as any).qbRoot as Root | undefined;
    if (!root) return false;
    this.root = root;
    this.mount(view);
    return true;
  }
  mount(view: EditorView) {
    const replace = (text: string) => {
      const b = findBlocks(view.state.doc.toString())[this.n];
      if (b) view.dispatch({ changes: { from: b.from, to: b.to, insert: text } });
    };
    const { wasText, def } = readBlock(this.src, repo.index());
    if (wasText) queueMicrotask(() => replace("```abfrage\n" + blockSource(def) + "\n```"));
    this.root!.render(
      <StrictMode>
        <QueryBlockView
          src={this.src}
          thisId={this.thisId}
          n={this.n}
          onChange={(d) => replace("```abfrage\n" + blockSource(d) + "\n```")}
          onDelete={() => {
            const b = findBlocks(view.state.doc.toString())[this.n];
            if (b) view.dispatch({ changes: { from: b.from, to: Math.min(view.state.doc.length, b.to + 1), insert: "" } });
          }}
        />
      </StrictMode>,
    );
  }
  override destroy() {
    const r = this.root;
    setTimeout(() => r?.unmount());
  }
  override ignoreEvent() {
    return true;
  }
}

function decos(state: EditorState, thisId?: string): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  findBlocks(state.doc.toString()).forEach((blk, n) => {
    b.add(blk.from, blk.to, Decoration.replace({ widget: new BlockWidget(blk.src, n, thisId), block: true }));
  });
  return b.finish();
}

// ---------- empty sections ----------
// A heading whose section holds only query blocks that hide when empty disappears with them
// when none of them has results ("Kürzlich erledigt" on a quiet week). It comes back as soon
// as one of them finds something.

const refresh = StateEffect.define<null>();

function emptySections(state: EditorState, thisId?: string): DecorationSet {
  const text = state.doc.toString();
  const blocks = findBlocks(text);
  const b = new RangeSetBuilder<Decoration>();
  if (!blocks.some((x) => x.src.includes('"hideEmpty":true'))) return b.finish();
  const ix = repo.index();
  const empty = (src: string) => {
    const { def } = readBlock(src, ix);
    return !!def.hideEmpty && runQuery(def, { ix, thisId }).total === 0;
  };
  const doc = state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const level = /^(#{1,6})\s/.exec(line.text)?.[1]!.length;
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
      const l = doc.lineAt(pos);
      const h = /^(#{1,6})\s/.exec(l.text)?.[1]!.length;
      if (h && h <= level) break;
      if (l.text.trim()) {
        allEmpty = false; // the section has text of its own
        break;
      }
      pos = l.to + 1;
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
    if (from < to) b.add(from, to, Decoration.replace({ block: true }));
  }
  return b.finish();
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

/** Insert an empty block at the cursor (it opens in edit mode). */
export function insertQueryBlock(view: EditorView, def: QueryDef = {}) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const at = line.length ? line.to : pos;
  const text = (line.length ? "\n" : "") + "```abfrage\n" + blockSource(def) + "\n```\n";
  view.dispatch({ changes: { from: at, insert: text } });
}
