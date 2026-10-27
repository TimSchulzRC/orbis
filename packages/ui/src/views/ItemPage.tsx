// One page for every information: path, title, type properties, text, sections from
// "Teil von", and on the right the connections. Types change the properties and which
// sections appear (via their capabilities), never the layout.
import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Sparkles, Trash2, RotateCcw, MoreHorizontal, Plus, AlertTriangle, ImagePlus, Scissors, ListFilter, Languages, Pin, PinOff, FilePlus, FolderInput, Link2 } from "lucide-react";
import { type Item, META_TYPE } from "@obtion/core/model";
import { isInInbox, isOverview } from "@obtion/core/placement";
import { wouldBeInInbox } from "@obtion/core/typeops";
import { onlyBelow } from "@obtion/core/trash";
import { primaryChild, hasUpdates, progressSpec, statusOf, languageCode, translations, translationInit, translationPlan } from "@obtion/core/traits";
import { useRepo, useIndex, itemHref, go } from "../hooks";
import { repo } from "../repo";
import { useT, tr, getLang } from "../i18n";
import { Editor, insertFilesAtCursor } from "../ui/Editor";
import { Button, Dialog, ItemIcon, MenuItem, Popover, ProgressBand, StatusPill, TypeChip, TypeGlyph, cx, IconButton } from "../ui/bits";
import { ItemPicker } from "../ui/Picker";
import { PropertyBlock } from "../ui/Properties";
import { BelowCard, ChildList, Updates, mainGrouping } from "../ui/Sections";
import { Bezuege, Crumbs, PlacePicker } from "../ui/PageParts";
import { StatusMenu } from "../ui/Row";
import { pluralOf } from "@obtion/core/plural";
import { queryBlocks, insertQueryBlock } from "../ui/QueryBlock";
import { FilePage } from "./FilePage";
import { TitleField } from "../ui/TitleField";
import { TypePage } from "./TypePage";
import { askAgent, createAndOpen } from "../actions";
import { INBOX_ICON, NOTE_ICON, OVERVIEW_ICON } from "../ui/icons";
import { extractAsCard, extractType } from "../ui/extract";

export function ItemPage({ id, isNew }: { id: string; isNew: boolean }) {
  const r = useRepo();
  const { t } = useT();
  const item = r.get(id);
  if (!item || item.kind === "settings")
    return <div className="mx-auto max-w-3xl px-6 py-16 text-center text-muted">{r.status.synced ? t("item.missing") : t("item.loading")}</div>;
  if (item.kind === "op") return <div className="mx-auto max-w-3xl px-6 py-16 text-center text-muted">{item.title}</div>;
  if (item.kind === "datei") return <FilePage key={id} item={item} />;
  if (item.type === META_TYPE) return <TypePage key={id} item={item} />;
  return <InfoView key={id} item={item} isNew={isNew} />;
}

const openItems = new Set<string>();

function extractTypeName() {
  const t = extractType();
  return t ? (repo.index().typeName(t) ?? "") : "";
}

function isBlank(i: Item) {
  const ix = repo.index();
  return !i.title.trim() && !i.body.trim() && !i.tags.length && !i.refs.length && !i.updates.length && !ix.childrenOf(i.id).length && !ix.backlinks(i.id).length && !Object.keys(i.extra).length;
}

function InfoView({ item, isNew }: { item: Item; isNew: boolean }) {
  const r = useRepo();
  const ix = useIndex();
  const { t } = useT();
  const doc = useMemo(() => r.getDoc(item.id), [item.id]);
  const schema = ix.schemaOf(item);
  const [view, setView] = useState<EditorView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [refPicking, setRefPicking] = useState(false);
  const [placesOpen, setPlacesOpen] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // An item created with "New …" and left empty is discarded, not left as "Untitled".
  useEffect(() => {
    if (!isNew) return;
    openItems.add(item.id);
    return () => {
      openItems.delete(item.id);
      setTimeout(() => {
        if (openItems.has(item.id)) return;
        const cur = repo.get(item.id);
        if (cur && !cur.deleted && isBlank(cur)) repo.remove(item.id);
      }, 50);
    };
  }, [item.id, isNew]);

  const ct = primaryChild(schema);
  const mainType = ct && ix.types.has(ct) ? ct : undefined;
  const cycles = ix.cycleEdgesOf(item.id);
  // a page that gathers its tasks over all levels (main action or progress) gathers its notes too
  const gathers = !!mainType || !!progressSpec(schema);
  // the type's own area: the main list and updates (§ 3.1, zone 3)
  const typeArea = !!mainType || hasUpdates(schema);
  // what "Darunter" leaves out: the main list's type, and sub-projects while they are groups of it
  const exclude = new Set<string>(mainType ? ["type:" + mainType] : []);
  if (mainType && mainType !== item.type && mainGrouping(item) === "sub") for (const c of ix.childrenOf(item.id)) if (ix.get(c)?.type === item.type) exclude.add(c);
  const pr = progressSpec(schema) ? ix.progressOf(item) : undefined;
  const st = statusOf(item, schema);

  const tools = (
    <>
      <IconButton onClick={() => askAgent()} label={t("item.askAgent")} icon={Sparkles} />
      <Popover align="right" trigger={(p) => <IconButton {...p} label={t("more")} icon={MoreHorizontal} />}>
        {(close) => (
          <>
            <MenuItem icon={<FolderInput size={14} />} onClick={() => (close(), setPlacing(true))}>
              {ix.parentsOf(item.id).length ? t("place.addAnother") : t("place.place")}
            </MenuItem>
            <MenuItem icon={<Link2 size={14} />} onClick={() => (close(), setRefPicking(true))}>
              {t("item.addRef")}
            </MenuItem>
            <MenuItem icon={<ImagePlus size={14} />} onClick={() => (close(), fileInput.current?.click())}>
              {t("editor.addFile")}
            </MenuItem>
            {view && (
              <MenuItem icon={<ListFilter size={14} />} onClick={() => (close(), insertQueryBlock(view))}>
                {t("item.insertQuery")}
              </MenuItem>
            )}
            {view && (
              <MenuItem icon={<Scissors size={14} />} onClick={() => (close(), extractAsCard(item, view))}>
                {t("item.extract", { name: extractTypeName() })}
              </MenuItem>
            )}
            <MenuItem icon={item.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => (close(), repo.pin(item.id, !item.pinned))}>
              {item.pinned ? t("item.unpin") : t("item.pin")}
            </MenuItem>
            <MenuItem icon={<FilePlus size={14} />} onClick={() => (close(), createAndOpen({ parents: [item.id] }))}>
              {t("item.newBelow")}
            </MenuItem>
            {/* a language version of its own: same type and places, the other language, linked */}
            {translationPlan(item, ix)?.missing.map((o) => (
              <MenuItem key={o.id} icon={<Languages size={14} />} onClick={() => (close(), createAndOpen(translationInit(item, ix, o.id)!))}>
                {t("item.newTranslation", { lang: languageCode(o.name) })}
              </MenuItem>
            ))}
            <MenuItem icon={<Languages size={14} />} onClick={() => (close(), askAgent(t("item.translatePrompt", { title: item.title, id: item.id }), t("item.translateShown", { title: item.title })))}>
              {t("item.translate")}
            </MenuItem>
            {!item.deleted && (
              <MenuItem danger icon={<Trash2 size={14} />} onClick={() => (close(), setDeleting(true))}>
                {t("item.delete")}
              </MenuItem>
            )}
          </>
        )}
      </Popover>
    </>
  );
  const mainAction = mainType && mainType !== item.type && !item.deleted;

  return (
    <div className="page-read">
      {item.deleted && (
        <div className="mb-4 flex items-center gap-3 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-danger">
          {t("item.inTrash")}
          <Button onClick={() => r.restore(item.id)} className="ml-auto">
            <RotateCcw size={14} /> {t("item.restore")}
          </Button>
        </div>
      )}
      {/* 1 · head: path, title with the main action, type and status, progress, properties */}
      <Crumbs item={item} tools={tools} onPlaces={() => setPlacesOpen((n) => n + 1)} onPlace={() => setPlacing(true)} />
      <div className="mt-1.5 flex items-start gap-4">
        <div data-page-title className="min-w-0 flex-1 rounded-lg">
          <TitleField item={item} autoFocus={isNew && !item.title} />
        </div>
        {mainAction && (
          <Button variant="primary" onClick={() => createAndOpen({ type: mainType, parents: [item.id] })} className="shrink-0 max-md:hidden">
            <Plus size={15} /> {ix.typeName(mainType)}
          </Button>
        )}
      </div>
      <TitleClash item={item} />
      {cycles.length > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-warn">
          <AlertTriangle size={12} /> {t("item.cycle", { titles: cycles.map((c) => ix.get(c)?.title).join(", ") })}
        </p>
      )}
      <div className="mt-2.5 flex min-h-[22px] flex-wrap items-center gap-2">
        <TypeSwitch item={item} />
        {st && <StatusMenu item={item} trigger={(p) => <button {...p} className="tap-y inline-flex" aria-label={t("row.status", { name: st.option.name })}><StatusPill option={st.option} group={st.group} /></button>} />}
        <LangSwitch item={item} />
      </div>
      {pr && <ProgressBand done={pr.done} total={pr.total} desc={progressText(item, ix, pr.done, pr.total)} />}
      <PropertyBlock item={item} schema={schema} />
      <div className="mt-5 border-t border-line" />

      {/* 2 · text */}
      <PageText item={item} doc={doc} long={typeArea} isNew={isNew} onView={setView} hasMore={typeArea || ix.childrenOf(item.id).length > 0} />
      <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => view && insertFilesAtCursor(view, [...(e.target.files ?? [])])} />

      {/* 3 · the type's area: main list, updates */}
      {mainType && <ChildList item={item} typeId={mainType} />}
      {hasUpdates(schema) && <Updates item={item} />}

      {/* 4 · below, 5 · connections and footer */}
      <BelowCard item={item} exclude={exclude} gathers={gathers} quietAdd={!typeArea} />
      <Bezuege item={item} typeArea={typeArea} placesOpen={placesOpen} />

      {/* on a phone the main action floats above the bottom bar */}
      {mainAction && (
        <button onClick={() => createAndOpen({ type: mainType, parents: [item.id] })} className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-20 flex h-12 items-center gap-1.5 rounded-full bg-ink pl-3.5 pr-[18px] text-[15px] font-semibold text-ink-text shadow-lg md:hidden">
          <Plus size={18} /> {ix.typeName(mainType)}
        </button>
      )}
      {placing && <PlacePicker item={item} onClose={() => setPlacing(false)} />}
      {refPicking && (
        <ItemPicker
          title={t("item.addRef")}
          exclude={(x) => x.id === item.id || item.refs.includes(x.id)}
          onPick={(x) => (repo.setMember(item.id, "refs", x, true), setRefPicking(false))}
          onClose={() => setRefPicking(false)}
        />
      )}
      {deleting && <DeleteDialog item={item} onClose={() => setDeleting(false)} />}
    </div>
  );
}

/** "2 von 9 Tasks erledigt, alle Ebenen" / "1 von 2 Unteraufgaben erledigt". */
function progressText(item: Item, ix: ReturnType<typeof useIndex>, done: number, total: number): string {
  const of = progressSpec(ix.schemaOf(item))?.of;
  if (of && of === item.type) return tr("progress.subtasks", { done, total });
  const name = of ? (ix.typeName(of) ?? "") : "";
  return tr(of ? "progress.allLevelsOf" : "progress.allLevels", { done, total, name: name && pluralOf(name, getLang()) });
}

/**
 * The text (zone 2). Long text on a page with its own list is cut to 8 lines with "Ganzen Text
 * zeigen"; a click into it opens it. "Bild oder Datei" shows only while writing.
 */
function PageText({ item, doc, long, isNew, onView, hasMore }: { item: Item; doc: ReturnType<typeof repo.getDoc>; long: boolean; isNew: boolean; onView: (v: EditorView | null) => void; hasMore: boolean }) {
  const { t } = useT();
  const schema = useIndex().schemaOf(item);
  const [view, setView] = useState<EditorView | null>(null);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  useEffect(() => {
    if (!long || !box.current) return;
    const check = () => setTall((box.current?.scrollHeight ?? 0) > 12 * 25 + 8);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(box.current.firstElementChild ?? box.current);
    return () => ro.disconnect();
  }, [long, item.id]);
  const cut = long && tall && !expanded;
  return (
    <div
      className="relative mt-6"
      onFocus={() => (setFocused(true), setExpanded(true))}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setFocused(false)}
    >
      <div ref={box} className={cut ? "max-h-[200px] overflow-hidden" : undefined}>
        <Editor
          doc={doc}
          nodeId={item.id}
          autoFocus={isNew && !!item.title}
          onView={(v) => (setView(v), onView(v))}
          extra={[queryBlocks(item.id)]}
          // room to start writing only while the text is empty and nothing else follows
          minHeight={item.body.trim() || hasMore ? "min-h-6" : "min-h-[30vh]"}
          placeholder={t(schema ? "editor.placeholderTyped" : "editor.placeholder")}
        />
      </div>
      {cut && (
        <div className="absolute inset-x-0 bottom-0 flex h-20 items-end bg-gradient-to-t from-[var(--bg)] to-transparent">
          <button onClick={() => setExpanded(true)} className="tap-y text-[13px] font-medium text-muted hover:text-fg">
            {t("page.showText")}
          </button>
        </div>
      )}
      {view && focused && (
        // while writing: a way to add a picture or a file (pasting and dragging work too)
        <label onMouseDown={(e) => e.preventDefault()} className="tap mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted focus-within:ring-2 focus-within:ring-[var(--focus)] hover:bg-hover hover:text-fg">
          <ImagePlus size={14} /> {t("editor.addFile")}
          <input type="file" multiple className="sr-only" onChange={(e) => insertFilesAtCursor(view, [...(e.target.files ?? [])])} />
        </label>
      )}
    </div>
  );
}

// ---------- header ----------

/**
 * "DE · EN": the versions of this page in other languages (a symmetric relation such as
 * "Übersetzung" between entries with a language). Nothing without a translation.
 */
function LangSwitch({ item }: { item: Item }) {
  const { t } = useT();
  const ix = useIndex();
  const versions = translations(item, ix);
  if (!versions.length) return null;
  return (
    <div role="group" aria-label={t("item.languages")} className="ml-auto inline-flex rounded-lg bg-surface-2 p-0.5 text-xs">
      {versions.map((v) => {
        const here = v.item.id === item.id;
        return (
          <button
            key={v.item.id}
            onClick={() => !here && go(itemHref(v.item.id).slice(1))}
            aria-pressed={here}
            title={here ? v.lang : `${v.lang}: ${v.item.title}`}
            className={cx("tap rounded-md px-2 py-0.5 font-medium tabular-nums", here ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
          >
            {languageCode(v.lang)}
          </button>
        );
      })}
    </div>
  );
}

function TypeSwitch({ item }: { item: Item }) {
  const ix = useIndex();
  const { t } = useT();
  const schema = ix.schemaOf(item);
  const inbox = isInInbox(item, ix);
  const overview = isOverview(item, ix);
  const types = [...ix.types.values()].sort((a, b) => a.schema!.name.localeCompare(b.schema!.name));
  const deletedType = item.type && !schema ? ix.all.get(item.type)?.schema?.name : undefined;
  return (
    <Popover
      trigger={(p) =>
        schema ? (
          <span {...p} className="inline-flex">
            <TypeChip schema={schema} onClick={p.onClick} />
          </span>
        ) : (
          // no type: a plain line, not a chip – "Übersicht" and "Notiz" are no types
          <button {...p} className={cx("tap-y inline-flex items-center gap-1 rounded px-0.5 text-[13px] hover:underline", inbox ? "text-warn" : "text-muted")} title={t("item.giveType")}>
            {inbox ? <INBOX_ICON size={12} /> : overview ? <OVERVIEW_ICON size={12} /> : <NOTE_ICON size={12} />}
            {inbox ? t("kind.inbox") : overview ? t("kind.overviewCount", { count: ix.childrenOf(item.id).length }) : t("kind.note")}
            {deletedType && <span className="text-muted">· {t("type.deletedName", { name: deletedType })}</span>}
          </button>
        )
      }
    >
      {(close) => (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted">{t("item.giveType")}</p>
          <MenuItem active={!item.type} icon={<NOTE_ICON size={14} />} onClick={() => (repo.setType(item.id, null), close())}>
            {t("type.none")}
          </MenuItem>
          {types.map((tp) => (
            <MenuItem key={tp.id} active={tp.id === item.type} icon={<TypeGlyph schema={tp.schema} size={14} />} onClick={() => (repo.setType(item.id, tp.id), close())}>
              {tp.schema!.name}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}


function TitleClash({ item }: { item: Item }) {
  const r = useRepo();
  const { t } = useT();
  if (!item.title.trim()) return null;
  const other = r.live().find((x) => x.id !== item.id && x.title.trim().toLowerCase() === item.title.trim().toLowerCase());
  if (!other) return null;
  return (
    <p className="mt-1 text-xs text-warn">
      {t("item.titleClash")}{" "}
      <a className="tap-y underline" href={itemHref(other.id)}>
        {t("item.openOther")}
      </a>
    </p>
  );
}

// ---------- delete ----------

/** Children that only hang here: delete them too, or let them lose this place. */
function DeleteDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const ix = useIndex();
  const { t } = useT();
  const only = onlyBelow(ix, item.id);
  const finish = (withChildren: boolean) => {
    repo.remove(item.id, withChildren ? "trash" : "inbox");
    onClose();
    history.length > 1 ? history.back() : go("/");
  };
  if (!only.length) {
    finish(false);
    return null;
  }
  // Kept children lose this place; whether they land in the inbox is the inbox's own query.
  const untyped = wouldBeInInbox(ix, only, (i) => i, [{ ...item, deleted: true }]);
  return (
    <Dialog title={t("delete.title", { title: item.title || t("untitled") })} onClose={onClose}>
      <p className="text-sm">{t("delete.children", { count: only.length })}</p>
      {untyped > 0 && <p className="mt-1 text-sm text-muted">{t("delete.toInbox", { count: untyped })}</p>}
      <ul className="mt-3 max-h-48 space-y-0.5 overflow-y-auto">
        {only.slice(0, 30).map((c) => (
          <li key={c} className="flex items-center gap-1.5 text-sm text-muted">
            <ItemIcon item={ix.get(c)!} size={13} /> {ix.get(c)!.title || t("untitled")}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={() => finish(false)}>
          {t("delete.keep")}
        </Button>
        <Button variant="primary" className="!bg-danger" onClick={() => finish(true)}>
          {t("delete.all", { count: only.length + 1 })}
        </Button>
      </div>
    </Dialog>
  );
}
