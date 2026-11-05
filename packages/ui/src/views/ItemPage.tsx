// One page for every information. Types change the properties and which sections appear, never
// the layout.
import { Input } from "../components/ui/input";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Trash2, Plus, AlertTriangle, ImagePlus, ListFilter, Pin, PinOff, FilePlus, FolderInput, ArrowRightLeft, History, Bot } from "lucide-react";
import { type Item, META_TYPE, titleKey } from "@obtion/core/model";
import { isInInbox } from "@obtion/core/placement";
import { wouldBeInInbox } from "@obtion/core/typeops";
import { onlyBelow } from "@obtion/core/trash";
import { hasUpdates, progressSpec } from "@obtion/core/traits";
import { useRepo, useIndex, itemHref, leavePage, openItem, setParams, showTitle, useDocumentTitle } from "../hooks";
import { repo } from "../repo";
import { useT, tr, getLang, titleOf } from "../i18n";
import { Editor, insertFilesAtCursor } from "../ui/Editor";
import { Button, Dialog, MenuItem, Popover, MoreMenu, PagePlaceholder } from "../ui/primitives";
import { Tip } from "../components/ui/tooltip";
import { ItemIcon, TypeChip, TypeGlyph } from "../ui/item-look";
import { ProgressBand } from "../ui/progress";
import { cn } from "../lib/utils";
import { PropertyBlock } from "../ui/Properties";
import { Below, Updates } from "../ui/Sections";
import { AddRef, Crumbs, LinksMenu, LinksRow, PageFooter, TrashBanner, pinnedRefs } from "../ui/PageParts";
import { PlacePicker } from "../ui/Picker";
import { pluralOf } from "@obtion/core/plural";
import { queryBlocks, insertQueryBlock } from "../ui/QueryBlock";
import { FilePage } from "./FilePage";
import { openDrawing } from "../drawing/Drawing";
import { insertDrawing } from "../ui/editor/slash";
import { DRAWING_ICON } from "../ui/icons";
import { TitleField } from "../ui/TitleField";
import { HistoryDialog } from "../ui/History";
import { TypePage } from "./TypePage";
import { createAndOpen, rememberPlace } from "../actions";
import { INBOX_ICON, NOTE_ICON } from "../ui/icons";
import { toolbarExtract } from "../ui/editor/toolbar";
import { movedItems } from "@obtion/core/transfer";
import { useAccounts } from "../accounts";
import { moveTo } from "../ui/Spaces";
import type { Index } from "@obtion/core/graph";
import { AgentRulesDialog } from "../ui/AgentRules";

export function ItemPage({ id, isNew }: { id: string; isNew: boolean }) {
  const scoped = useRepo();
  const { t } = useT();
  const item = scoped.get(id);
  // the title after the id: at once when the page opens, while typing a moment later
  // (browsers limit how often an address may change)
  const hasPage = item && item.kind !== "settings" && item.kind !== "op";
  const title = !hasPage ? undefined : item.type === META_TYPE ? scoped.index().typePlural(id) : item.title;
  const shown = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (title === undefined) return;
    if (shown.current !== id) {
      shown.current = id;
      showTitle(title);
      return;
    }
    const wait = setTimeout(() => showTitle(title), 400);
    return () => clearTimeout(wait);
  }, [id, title]);
  if (!item || item.kind === "settings")
    return <PagePlaceholder>{scoped.status.synced ? t("item.missing") : t("item.loading")}</PagePlaceholder>;
  if (item.kind === "op") return <PagePlaceholder>{item.title}</PagePlaceholder>;
  if (item.kind === "datei") return <FilePage key={id} item={item} />;
  if (item.kind === "zeichnung") return <DrawingInNote key={id} item={item} />;
  if (item.type === META_TYPE) return <TypePage key={id} item={item} />;
  return <InfoView key={id} item={item} isNew={isNew} />;
}

/**
 * A drawing has no page: it is a block in a note. A link to it (search, an agent) opens that note,
 * the one whose text embeds it or else the one it is kept under, and the drawing over it.
 */
function DrawingInNote({ item }: { item: Item }) {
  const scoped = useRepo();
  const { t } = useT();
  const ix = scoped.index();
  const note = ix.backlinks(item.id).find((b) => b.kind === "embed" && ix.get(b.from)?.kind === "info")?.from ?? ix.parentsOf(item.id)[0];
  useEffect(() => {
    if (note) openItem(note, { replace: true });
    openDrawing(item.id);
  }, [item.id]);
  return <PagePlaceholder>{note ? t("drawing.loading") : titleOf(item, t)}</PagePlaceholder>;
}

const openItems = new Set<string>();

function isBlank(item: Item) {
  const ix = repo.index();
  return !item.title.trim() && !item.body.trim() && !item.rules.trim() && !item.tags.length && !item.refs.length && !item.updates.length && !ix.childrenOf(item.id).length && !ix.backlinks(item.id).length && !Object.keys(item.extra).length;
}

function InfoView({ item, isNew: created }: { item: Item; isNew: boolean }) {
  const repo = useRepo();
  // "?new=1" is for opening it once: gone from the address, so a reload or Back later does not take it as new
  const [isNew] = useState(created);
  useEffect(() => void setParams({ new: null }), []);
  const ix = useIndex();
  const { t } = useT();
  useDocumentTitle(titleOf(item, t));
  const doc = useMemo(() => repo.getDoc(item.id), [item.id]);
  const schema = ix.schemaOf(item);
  const [view, setView] = useState<EditorView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [history, setHistory] = useState(false);
  const others = useAccounts().spaces.length > 1;
  const [rulesOpen, setRulesOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // An item created with "New …" and left empty is discarded, not left as "Untitled".
  useEffect(() => {
    if (!isNew) return;
    openItems.add(item.id);
    return () => {
      openItems.delete(item.id);
      setTimeout(() => {
        if (openItems.has(item.id)) return;
        const current = repo.get(item.id);
        if (current && !current.deleted && isBlank(current)) repo.remove(item.id);
      }, 50);
    };
  }, [item.id, isNew]);

  const cycles = ix.cycleEdgesOf(item.id);
  // the type's area (§ 3.1, zone 3): long texts fold so the updates stay in sight
  const typeArea = hasUpdates(schema);
  const progress = progressSpec(schema) ? ix.progressOf(item) : undefined;

  const tools = (
    <MoreMenu>
      {(close) => (
        <>
          <MenuItem icon={<FolderInput size={14} />} onClick={() => (close(), setPlacing(true))}>
            {ix.parentsOf(item.id).length ? t("place.addAnother") : t("place.place")}
          </MenuItem>
          <MenuItem icon={<ImagePlus size={14} />} onClick={() => (close(), fileInput.current?.click())}>
            {t("editor.addFile")}
          </MenuItem>
          {view && (
            <MenuItem icon={<DRAWING_ICON size={14} />} onClick={() => (close(), insertDrawing(view))}>
              {t("drawing.insert")}
            </MenuItem>
          )}
          {view && (
            <MenuItem icon={<ListFilter size={14} />} onClick={() => (close(), insertQueryBlock(view))}>
              {t("item.insertQuery")}
            </MenuItem>
          )}
          <MenuItem icon={item.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => (close(), repo.pin(item.id, !item.pinned))}>
            {item.pinned ? t("item.unpin") : t("item.pin")}
          </MenuItem>
          <MenuItem icon={<FilePlus size={14} />} onClick={() => (close(), createAndOpen({ parents: [item.id] }))}>
            {t("item.newBelow")}
          </MenuItem>
          <MenuItem icon={<History size={14} />} onClick={() => (close(), setHistory(true))}>
            {t("item.history")}
          </MenuItem>
          {others && !item.deleted && item.type !== META_TYPE && (
            <MenuItem icon={<ArrowRightLeft size={14} />} onClick={() => (close(), setMoving(true))}>
              {t("move.menu")}
            </MenuItem>
          )}
          {!item.deleted && (
            <MenuItem danger icon={<Trash2 size={14} />} onClick={() => (close(), deleteOrAsk(repo, item.id, () => setDeleting(true)))}>
              {t("item.delete")}
            </MenuItem>
          )}
        </>
      )}
    </MoreMenu>
  );

  return (
    <div className="page-read">
      {item.deleted && (
        <TrashBanner onRestore={() => repo.restore(item.id)} />
      )}
      {/* 1 · head: path, title, type and status, progress, properties */}
      <Crumbs item={item} tools={tools} onPlace={() => setPlacing(true)} />
      <div className="mt-6 flex items-start gap-4 max-md:mt-3">
        <div data-page-title className="min-w-0 flex-1 rounded-lg">
          <TitleField item={item} autoFocus={isNew && !item.title} />
        </div>
      </div>
      <TitleClash item={item} />
      {cycles.length > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-warn">
          <AlertTriangle size={12} /> {t("item.cycle", { titles: cycles.map((c) => ix.get(c)?.title).join(", ") })}
        </p>
      )}
      <div className="mt-3 border-t border-line" />
      {/* what the page is as badges, the links, its dates, its progress, then the properties with their names */}
      <PropertyBlock
        item={item}
        schema={schema}
        head={{
          first: <TypeSwitch item={item} />,
          // "+ Ref" next to "+ Tags" until refs are pinned; then the "+" follows their chips
          afterTags: !pinnedRefs(item, ix).length && <AddRef item={item} text />,
          end: (
            <>
              <LinksMenu item={item} />
              {!item.deleted && (
                <Tip label={t("rules.title")}>
                  <Button variant="plain" onClick={() => setRulesOpen(true)} aria-label={t("rules.title")} className={cn("tap inline-flex items-center justify-center rounded-lg p-1.5 transition-colors hover:bg-hover hover:text-fg", item.rules.trim() ? "text-fg" : "text-muted-foreground")}>
                    <Bot size={16} />
                  </Button>
                </Tip>
              )}
            </>
          ),
          links: <LinksRow item={item} />,
          progress: progress && <ProgressBand done={progress.done} total={progress.total} desc={progressText(item, ix, progress.done, progress.total)} />,
        }}
      />

      {/* 2 · text */}
      <PageText item={item} doc={doc} long={typeArea} isNew={isNew} onView={setView} hasMore={typeArea || ix.childrenOf(item.id).length > 0} />
      <Input variant="bare" ref={fileInput} type="file" multiple className="hidden" onChange={(e) => view && insertFilesAtCursor(view, [...(e.target.files ?? [])])} />

      {/* a line between the text one writes and what the page adds below it;
          mt-7, not mt-6: the editor has 4px padding on top only, so the text sits in the middle */}
      <div className="mt-7 border-t border-line" />
      <div className="page-below [&>:first-child]:mt-6">
        {/* 3 · below: everything under the page, the same for every type (the links are in the head) */}
        <Below item={item} />
        {/* 4 · the type's area: updates */}
        {hasUpdates(schema) && <Updates item={item} />}
      </div>
      {/* one more line above the dates, unless nothing came between */}
      <PageFooter item={item} className="mt-10 border-t border-line pt-4 max-md:mt-8 [.page-below:empty+&]:mt-4 [.page-below:empty+&]:border-t-0 [.page-below:empty+&]:pt-0" />

      {placing && <PlacePicker list={[item]} title={t("place.add")} onPick={(pid) => (repo.addParent(item.id, pid), rememberPlace(pid), setPlacing(false))} onClose={() => setPlacing(false)} />}
      {deleting && <DeleteDialog item={item} onClose={() => setDeleting(false)} />}
      {rulesOpen && <AgentRulesDialog item={item} onClose={() => setRulesOpen(false)} />}
      {moving && <MoveDialog item={item} onClose={() => setMoving(false)} />}
      {history && <HistoryDialog item={item} onClose={() => setHistory(false)} />}
    </div>
  );
}

/** "2 von 9 Tasks erledigt, alle Ebenen". */
function progressText(item: Item, ix: Index, done: number, total: number): string {
  const of = progressSpec(ix.schemaOf(item))?.of;
  const name = of ? (ix.typeName(of) ?? "") : "";
  return tr(of ? "progress.allLevelsOf" : "progress.allLevels", { done, total, name: name && pluralOf(name, getLang()) });
}

/** Text taller than this (about 12 lines) is cut on a page with its own list. */
const TALL_TEXT = 12 * 25 + 8;

/** Zone 2. Long text on a page with its own list is cut to 8 lines until clicked. */
function PageText({ item, doc, long, isNew, onView, hasMore }: { item: Item; doc: ReturnType<typeof repo.getDoc>; long: boolean; isNew: boolean; onView: (v: EditorView | null) => void; hasMore: boolean }) {
  const { t } = useT();
  const schema = useIndex().schemaOf(item);
  const [expanded, setExpanded] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  useEffect(() => {
    if (!long || !box.current) return;
    const check = () => setTall((box.current?.scrollHeight ?? 0) > TALL_TEXT);
    check();
    const resize = new ResizeObserver(check);
    resize.observe(box.current.firstElementChild ?? box.current);
    return () => resize.disconnect();
  }, [long, item.id]);
  const cut = long && tall && !expanded;
  return (
    <div className="relative mt-6" onFocus={() => setExpanded(true)}>
      <div ref={box} className={cut ? "max-h-[200px] overflow-hidden" : undefined}>
        <Editor
          doc={doc}
          nodeId={item.id}
          autoFocus={isNew && !!item.title}
          onView={onView}
          extra={[queryBlocks(item.id), toolbarExtract.of(true)]}
          // room to start writing only while the text is empty and nothing else follows
          minHeight={item.body.trim() || hasMore ? "min-h-6" : "min-h-[30vh]"}
          placeholder={t(schema ? "editor.placeholderTyped" : "editor.placeholder")}
        />
      </div>
      {cut && (
        <div className="absolute inset-x-0 bottom-0 flex h-20 items-end bg-gradient-to-t from-[var(--bg)] to-transparent">
          <Button variant="plain" onClick={() => setExpanded(true)} className="tap-y text-[13px] font-medium text-muted-foreground hover:text-fg">
            {t("page.showText")}
          </Button>
        </div>
      )}
    </div>
  );
}

function TypeSwitch({ item }: { item: Item }) {
  const repo = useRepo();
  const ix = useIndex();
  const { t } = useT();
  const schema = ix.schemaOf(item);
  const inbox = isInInbox(item, ix);
  const types = ix.typesByName();
  const deletedType = item.type && !schema ? ix.all.get(item.type)?.schema?.name : undefined;
  return (
    <Popover
      trigger={(p) =>
        schema ? (
          <span {...p} className="inline-flex">
            <TypeChip schema={schema} onClick={p.onClick} />
          </span>
        ) : (
          // no type: a plain line, not a chip – "Notiz" is no type
          <Button variant="plain" {...p} className={cn("tap-y inline-flex items-center gap-1 rounded px-0.5 text-[13px] hover:underline", inbox ? "text-warn" : "text-muted-foreground")} title={t("item.giveType")}>
            {inbox ? <INBOX_ICON size={12} /> : <NOTE_ICON size={12} />}
            {inbox ? t("kind.inbox") : t("kind.note")}
            {deletedType && <span className="text-muted-foreground">· {t("type.deletedName", { name: deletedType })}</span>}
          </Button>
        )
      }
    >
      {(close) => (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">{t("item.giveType")}</p>
          <MenuItem active={!item.type} icon={<NOTE_ICON size={14} style={{ color: "var(--t-note)" }} />} onClick={() => (repo.setType(item.id, null), close())}>
            {t("kind.note")}
          </MenuItem>
          {types.map((type) => (
            <MenuItem key={type.id} active={type.id === item.type} icon={<TypeGlyph schema={type.schema} size={14} />} onClick={() => (repo.setType(item.id, type.id), close())}>
              {type.schema.name}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

function TitleClash({ item }: { item: Item }) {
  const scoped = useRepo();
  const { t } = useT();
  if (!item.title.trim()) return null;
  const other = scoped.live().find((x) => x.id !== item.id && titleKey(x.title) === titleKey(item.title));
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

function removeAndLeave(inRepo: typeof repo, id: string, withChildren: boolean, leave = true) {
  inRepo.remove(id, withChildren ? "trash" : "inbox");
  if (leave) leavePage();
}

/**
 * With children that only hang here, the dialog asks first. `leave`: the item is the open page,
 * which then goes back. True when it went to the trash right away.
 */
export function deleteOrAsk(inRepo: typeof repo, id: string, ask: () => void, leave = true): boolean {
  if (onlyBelow(inRepo.index(), id).length) return (ask(), false);
  removeAndLeave(inRepo, id, false, leave);
  return true;
}

/** Children that only hang here: delete them too, or let them lose this place. */
export function DeleteDialog({ item, onClose, leave = true }: { item: Item; onClose: () => void; leave?: boolean }) {
  const scoped = useRepo();
  const ix = scoped.index();
  const { t } = useT();
  const only = onlyBelow(ix, item.id);
  const finish = (withChildren: boolean) => {
    removeAndLeave(scoped, item.id, withChildren, leave);
    onClose();
  };
  // Kept children lose this place; whether they land in the inbox is the inbox's own query.
  const untyped = wouldBeInInbox(ix, only, (i) => i, [{ ...item, deleted: true }]);
  return (
    <Dialog title={t("delete.title", { title: titleOf(item, t) })} onClose={onClose}>
      <p className="text-sm">{t("delete.children", { count: only.length })}</p>
      {untyped > 0 && <p className="mt-1 text-sm text-muted-foreground">{t("delete.toInbox", { count: untyped })}</p>}
      <ul className="mt-3 max-h-48 space-y-0.5 overflow-y-auto">
        {only.slice(0, 30).map((c) => (
          <li key={c} className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <ItemIcon item={ix.get(c)!} size={13} /> {titleOf(ix.get(c)!, t)}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={() => finish(false)}>
          {t("delete.keep")}
        </Button>
        <Button variant="danger" onClick={() => finish(true)}>
          {t("delete.all", { count: only.length + 1 })}
        </Button>
      </div>
    </Dialog>
  );
}

/** "In anderen Workspace verschieben": with what hangs only below it; here it goes to the trash. */
function MoveDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const repo = useRepo();
  const { t } = useT();
  const { spaces, active } = useAccounts();
  const count = movedItems(repo.index(), item.id).length - 1;
  return (
    <Dialog title={t("move.title", { title: titleOf(item, t) })} onClose={onClose}>
      <p className="text-sm text-muted-foreground">{count > 0 ? t("move.introBelow", { count }) : t("move.intro")}</p>
      <ul className="mt-3 space-y-1">
        {spaces
          .filter((s) => s.id !== active?.id)
          .map((s) => (
            <li key={s.id}>
              <Button variant="plain"
                onClick={() => (onClose(), void moveTo(item.id, active!.id, s.id))}
                className="tap-row flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
              </Button>
            </li>
          ))}
      </ul>
    </Dialog>
  );
}
