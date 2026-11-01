// Fold state is remembered per device. In the tree, dragging replaces the parent you come from;
// with Alt held a place is added. Dropping on a row's upper or lower edge reorders. Dropped into
// another workspace's block, an item moves there.
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, ChevronDown, History, Inbox, Search, Settings, Link2, Plus, Paperclip, Sun, Trash2 } from "lucide-react";
import { type Item, META_TYPE, SETTINGS_ID, setSchemaField, setSettings } from "@obtion/core/model";
import { sidebarChildren, sidebarRoots } from "@obtion/core/placement";
import { keyBetween, keysFor, cmpKey } from "@obtion/core/sortkey";
import { useRepo, useRoute, useSpaceId, itemPath, spaceHref, useLocalStorage, leavePage } from "../hooks";
import { type Space, useAccounts } from "../accounts";
import { useT } from "../i18n";
import { Button, IconButton, Kbd, MenuItem, MoreMenu, REVEAL, useContextMenu } from "./primitives";
import { TypeGlyph, ItemIcon } from "./item-look";
import { cn, moveInArray } from "../lib/utils";
import { shortcut } from "../lib/platform";
import { StatusButton } from "./StatusButton";
import { createAndOpen } from "../actions";
import { NewTypeDialog } from "../views/Types";
import { DeleteDialog, deleteOrAsk } from "../views/ItemPage";
import { NewSpaceDialog, SpaceScope, SpaceSelector, moveTo } from "./Spaces";
import { useInboxItems } from "./inbox";
import { KEYS } from "./storage";
import { notify } from "./toasts";
import { openSettings } from "./settings-open";
import { Tip } from "../components/ui/tooltip";

/**
 * What is being dragged in the sidebar: an item (from below `from`, null: pinned; `type`: a pinned
 * type page, which only changes its place among the pinned) or a row of "Typen", and from which workspace.
 */
let dragging: { id: string; from: string | null; space: string; type?: boolean } | null = null;
/**
 * Carries only the title as text. The URL the browser adds for a link is dropped, or the drag
 * would be taken as a link to open elsewhere (a new tab, a split view).
 */
const startDrag = (e: React.DragEvent, d: NonNullable<typeof dragging>, text: string) => {
  dragging = d;
  e.dataTransfer.clearData();
  e.dataTransfer.setData("text/plain", text);
};
/** Can it go into another workspace? Items can (a move), type pages and rows of "Typen" not. */
const movable = (d: typeof dragging) => !!d && d.from !== "types" && !d.type;
/** Icons of tree rows: larger in the phone menu. */
const rowIconSize = (touch?: boolean) => (touch ? 17 : 15);
/** Where a row takes what is dropped on it: its upper quarter before it, its lower quarter after it, else into it. */
function dropZone(y: number, height: number): "before" | "inside" | "after" {
  if (y < height * 0.25) return "before";
  if (y > height * 0.75) return "after";
  return "inside";
}

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { t, lang } = useT();
  const route = useRoute();
  const { shown } = useAccounts();
  const inbox = useInboxItems().length;
  const [creating, setCreating] = useState(false);
  const iconCls = (active: boolean) => cn("tap inline-flex size-8 shrink-0 items-center justify-center rounded-md", active ? "bg-hover text-fg" : "text-muted-foreground hover:bg-hover hover:text-fg");
  const navCls = (active: boolean) => cn("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm", active ? "bg-hover font-medium text-fg" : "text-muted-foreground hover:bg-hover hover:text-fg");

  return (
    <aside className="flex w-[256px] shrink-0 flex-col border-r border-line bg-surface-2/50 pt-safe">
      <div className="flex items-center px-2 pb-px pt-2">
        <SpaceSelector className="flex-1" onNew={() => setCreating(true)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <nav className="flex flex-col gap-px px-2" aria-label={t("nav.main")}>
          <Button variant="plain" onClick={onSearch} className={cn(navCls(false), "group/search")}>
            <Search size={16} /> <span className="flex-1 text-left">{t("nav.search")}</span>
            <span className="opacity-0 transition-opacity group-hover/search:opacity-100">
              <Kbd>{shortcut("K", lang)}</Kbd>
            </span>
          </Button>
          <a href="#/" className={navCls(route.path === "/")}>
            <Sun size={16} /> {t("nav.today")}
          </a>
          <a href="#/review" className={navCls(route.path.startsWith("/review"))}>
            <Inbox size={16} /> <span className="flex-1">{t("nav.inbox")}</span>
            {inbox > 0 && <span className="text-xs tabular-nums text-muted-foreground">{inbox}</span>}
          </a>
        </nav>
        {shown.map((s) => (
          <SpaceScope key={s.id} id={s.id}>
            <div className="mx-4 mt-3 border-t border-line" />
            <SpaceTree space={s} />
          </SpaceScope>
        ))}
        {creating && <NewSpaceDialog onClose={() => setCreating(false)} />}
      </div>
      {/* below, as icons: the settings and the pages about all workspaces seen (activity, trash) –
          on those pages the way back instead; at the right how sync and version stand */}
      <div className="flex items-center gap-1 border-t border-line p-2">
        {route.parts[0] === "activity" || route.parts[0] === "trash" ? (
          <Button variant="plain" onClick={leavePage} className={cn(navCls(false), "min-w-0 flex-1")}>
            <ArrowLeft size={16} /> {t("nav.back")}
          </Button>
        ) : (
          <>
            <Tip label={t("nav.settings")}>
              <Button variant="plain" onClick={openSettings} aria-label={t("nav.settings")} className={iconCls(false)}>
                <Settings size={17} />
              </Button>
            </Tip>
            <Tip label={t("nav.activity")}>
              <a href="#/activity" aria-label={t("nav.activity")} className={iconCls(false)}>
                <History size={17} />
              </a>
            </Tip>
            <Tip label={t("nav.trash")}>
              <a href="#/trash" aria-label={t("nav.trash")} className={iconCls(false)}>
                <Trash2 size={17} />
              </a>
            </Tip>
          </>
        )}
        <StatusButton className="ml-auto" />
      </div>
    </aside>
  );
}

/** `touch` (phone menu): taller rows, no drag and drop, no hover buttons. */
export function SpaceTree({ space, touch }: { space: Space; touch?: boolean }) {
  const { t } = useT();
  const repo = useRepo();
  const { active, shown } = useAccounts();
  const here = active?.id === space.id;
  const [open, setOpen] = useLocalStorage<boolean>(KEYS.sidebarSpace(space.id), true);
  const [typesOpen, setTypesOpen] = useLocalStorage<boolean>(KEYS.sidebarTypes(space.id), shown.length === 1);
  const [over, setOver] = useState(false);
  const ix = repo.index();
  const roots = sidebarRoots(ix);
  const ready = !!repo.get(SETTINGS_ID);
  const row = cn("flex items-center gap-2 rounded-lg pr-2", touch ? "py-2 text-[15px]" : "py-1 text-sm");
  return (
    <section className="mt-3" aria-label={space.name}>
      <div
        className={cn("group/space flex h-7 items-center gap-0.5 rounded-lg", touch ? "px-3" : "mx-2 px-2", over && "bg-hover ring-1 ring-focus")}
        onDragOver={(e) => {
          if (!movable(dragging) || dragging!.space === space.id) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dragged = dragging;
          dragging = null;
          if (movable(dragged) && dragged!.space !== space.id) void moveTo(dragged!.id, dragged!.space, space.id);
        }}
      >
        <Button variant="plain" onClick={() => setOpen(!open)} aria-expanded={open} className="-ml-1 flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground hover:text-fg">
          <ChevronRight size={13} className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")} />
          <span className="truncate">{space.name}</span>
        </Button>
        {ready && (
          <IconButton
            size="xs"
            icon={Plus}
            iconSize={14}
            label={t("nav.newPinned")}
            onClick={() => createAndOpen({ pinned: keyBetween(roots.at(-1)?.pinned ?? null, null) }, repo, space.id)}
            className={touch ? "p-1.5" : "opacity-0 focus:opacity-100 group-hover/space:opacity-100"}
          />
        )}
      </div>
      {/* set up as soon as it is in step with the server */}
      {open && !ready && <p className={cn(row, "pl-[30px] text-muted-foreground", !touch && "mx-2")}>{t("app.syncing")}</p>}
      {open && ready && (
        <div className={cn(!touch && "px-2")}>
          <PinnedTree touch={touch} here={here} />
          {/* a label over the types, not a row like the pinned: smaller, no hover */}
          <Button variant="plain" onClick={() => setTypesOpen(!typesOpen)} aria-expanded={typesOpen} className={cn("mt-2 flex w-full items-center gap-1 pl-2.5 font-medium text-muted-foreground hover:text-fg", touch ? "py-1.5 text-[13px]" : "py-1 text-xs")}>
            <ChevronRight size={12} className={cn("shrink-0 text-faint transition-transform", typesOpen && "rotate-90")} />
            {t("nav.types")}
          </Button>
          {typesOpen && <TypeNav touch={touch} here={here} />}
        </div>
      )}
    </section>
  );
}

/** The path to the open page unfolds by itself; nothing closes by itself. `here`: the open workspace. */
function PinnedTree({ touch, here }: { touch?: boolean; here: boolean }) {
  const repo = useRepo();
  const space = useSpaceId()!;
  const ix = repo.index();
  const route = useRoute();
  const [open, setOpen] = useLocalStorage<Record<string, boolean>>(KEYS.sidebarTree, {});
  const activeId = here && route.parts[0] === "i" ? route.parts[1] : undefined;
  useEffect(() => {
    if (!activeId) return;
    const chain = [...ix.homePath(activeId), activeId];
    const root = chain.findIndex((id) => !!ix.get(id)?.pinned);
    if (root < 0) return;
    const keys = chain.slice(root, -1).map((id, i) => `${i === 0 ? "" : chain[root + i - 1]}>${id}`);
    if (keys.some((k) => !open[k])) setOpen({ ...open, ...Object.fromEntries(keys.map((k) => [k, true])) });
  }, [activeId]);
  const roots = sidebarRoots(ix);
  const isOpen = (key: string, depth: number) => open[key] ?? depth === 0;
  const toggle = (key: string, depth: number) => setOpen({ ...open, [key]: !isOpen(key, depth) });
  // done entries stay out of the tree – except the open page and the way to it
  const keep = activeId ? [...ix.homePath(activeId), activeId] : [];
  const tree = { isOpen, toggle, activeId, keep, touch };
  return (
    <div
      className="min-h-1"
      onDragOver={(e) => dragging && dragging.from !== "types" && e.preventDefault()}
      onDrop={(e) => {
        // dropped on empty space: pinned at the end (moving away from the parent it came from)
        const dragged = dragging;
        if (!dragged || dragged.from === "types" || e.defaultPrevented) return;
        dragging = null;
        if (dragged.space !== space) return void (movable(dragged) && moveTo(dragged.id, dragged.space, space));
        if (dragged.from && !e.altKey) repo.removeParent(dragged.id, dragged.from);
        repo.setSort(dragged.id, null, keyBetween(roots.at(-1)?.pinned ?? null, null));
      }}
    >
      {roots.map((root, i) => (
        <TreeNode key={root.id} item={root} parent={null} siblings={roots} index={i} depth={0} {...tree} />
      ))}
    </div>
  );
}

/** The page of every type of a workspace and the files, in an order of their own (synced); a new type comes last. */
function TypeNav({ touch, here }: { touch?: boolean; here: boolean }) {
  const { t } = useT();
  const repo = useRepo();
  const space = useSpaceId()!;
  const ix = repo.index();
  const route = useRoute();
  const [creating, setCreating] = useState(false);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
  const filesPos = ix.all.get(SETTINGS_ID)?.settings?.filesPos;
  const rows = [
    ...ix.typesInOrder().map((type) => ({ id: type.id, key: type.schema.pos, label: ix.typePlural(type.id), href: spaceHref(space, itemPath(type.id)), icon: <TypeGlyph schema={type.schema} size={rowIconSize(touch)} /> })),
    { id: "files", key: filesPos, label: t("nav.files"), href: spaceHref(space, "/files"), icon: <Paperclip size={rowIconSize(touch)} className="shrink-0" /> },
  ].sort((a, b) => cmpKey(a.key ?? "~", b.key ?? "~"));
  const active = (id: string) => here && (id === "files" ? route.path.startsWith("/files") : route.parts[0] === "i" && route.parts[1] === id);
  // a new order: every row gets a fresh key, written only where it changed
  const move = (id: string, to: string, before: boolean) => {
    const order = moveInArray(rows, rows.findIndex((row) => row.id === id), rows.findIndex((row) => row.id === to) + (before ? 0 : 1));
    keysFor(order.length).forEach((pos, i) => {
      const row = order[i]!;
      if (row.key === pos) return;
      if (row.id === "files") repo.change(SETTINGS_ID, (d) => setSettings(d, { filesPos: pos }));
      else repo.change(row.id, (d) => setSchemaField(d, "pos", pos));
    });
  };
  const ours = () => dragging?.from === "types" && dragging.space === space;
  return (
    <nav className="flex flex-col gap-px" aria-label={t("nav.types")}>
      {rows.map((row) => (
        <a
          key={row.id}
          href={row.href}
          draggable={!touch}
          onDragStart={(e) => startDrag(e, { id: row.id, from: "types", space }, row.label)}
          onDragOver={(e) => {
            if (!ours() || dragging!.id === row.id) return;
            e.preventDefault();
            const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setDrop({ id: row.id, before: e.clientY < box.top + box.height / 2 });
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={(e) => {
            e.preventDefault();
            if (ours() && drop) move(dragging!.id, row.id, drop.before);
            dragging = null;
            setDrop(null);
          }}
          aria-current={active(row.id) ? "page" : undefined}
          className={cn("relative flex items-center gap-2 rounded-lg pl-[30px] pr-2", touch ? "py-2 text-[15px]" : "py-1 text-sm", active(row.id) ? "bg-hover font-medium text-fg" : "text-muted-foreground hover:bg-hover hover:text-fg")}
        >
          {drop?.id === row.id && <span className={cn("absolute inset-x-1 h-0.5 rounded bg-focus", drop.before ? "-top-px" : "-bottom-px")} />}
          {row.icon}
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
        </a>
      ))}
      <Button variant="plain" onClick={() => setCreating(true)} className={cn("flex items-center gap-2 rounded-lg pl-[30px] pr-2 text-muted-foreground hover:bg-hover hover:text-fg", touch ? "py-2 text-[15px]" : "py-1 text-sm")}>
        <Plus size={rowIconSize(touch)} className="shrink-0" /> {t("types.new")}
      </Button>
      {creating && <NewTypeDialog onClose={() => setCreating(false)} />}
    </nav>
  );
}

/**
 * A child that repeats its parent's title ("Relaunch Frankreich" below "Relaunch") shows
 * only what it adds: "… Frankreich". Anything else keeps its title and is cut at the end (the
 * full title is the tooltip) – never stumps like "… im Alltag".
 */
function distinctLabel(title: string, parentTitle?: string): string {
  const prefix = parentTitle?.trim();
  if (!prefix || title.length <= prefix.length) return title;
  if (title.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return title;
  const rest = title.slice(prefix.length);
  if (!/^[\s:·–-]/.test(rest)) return title; // "RelaunchX" is no repetition
  const words = rest.replace(/^[\s:·–-]+/, "");
  return words.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 ? "… " + words : title;
}

function TreeNode({
  item,
  parent,
  siblings,
  index,
  depth,
  isOpen: opened,
  toggle,
  activeId,
  keep,
  touch,
}: {
  item: Item;
  parent: string | null;
  siblings: Item[];
  index: number;
  depth: number;
  isOpen: (k: string, depth: number) => boolean;
  toggle: (k: string, depth: number) => void;
  activeId?: string;
  keep: string[];
  touch?: boolean;
}) {
  const { t } = useT();
  const repo = useRepo();
  const space = useSpaceId()!;
  const ix = repo.index();
  const isType = item.type === META_TYPE;
  const key = `${parent ?? ""}>${item.id}`;
  const kids = sidebarChildren(item.id, ix, keep);
  const isOpen = opened(key, depth);
  const home = ix.home(item.id);
  // a second place of the same item: below a non-home parent, or at the top while it also has a parent
  const secondary = parent !== null ? home !== parent : !!home;
  const [drop, setDrop] = useState<"before" | "inside" | "after" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const menu = useContextMenu();
  // the open page goes back when it goes to the trash; anything else stays where it is
  const toTrash = () => {
    const title = item.title || t("untitled");
    if (deleteOrAsk(repo, item.id, () => setDeleting(true), activeId === item.id)) notify.undo(t("item.trashed", { title }), () => repo.restore(item.id));
  };

  const sortOf = (x: Item) => (parent ? (x.parents[parent]?.sort ?? "") : (x.pinned ?? ""));
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dragged = dragging;
    dragging = null;
    setDrop(null);
    if (!dragged || dragged.id === item.id) return;
    if (dragged.space !== space) return void (movable(dragged) && !isType && moveTo(dragged.id, dragged.space, space, item.id));
    if ((dragged.type || isType) && drop === "inside") return;
    if (drop === "inside") {
      if (e.altKey) repo.addParent(dragged.id, item.id);
      else if (dragged.from) repo.moveParent(dragged.id, dragged.from, item.id);
      else if (repo.addParent(dragged.id, item.id)) repo.pin(dragged.id, false); // from the top: no longer pinned
      if (!isOpen) toggle(key, depth);
      return;
    }
    // reorder among the siblings of this row
    const before = drop === "before";
    const neighbour = siblings[before ? index - 1 : index + 1];
    const neighbourSort = neighbour ? sortOf(neighbour) : null;
    const sort = before ? keyBetween(neighbourSort, sortOf(item)) : keyBetween(sortOf(item), neighbourSort);
    if (parent) {
      if (dragged.from !== parent) {
        if (e.altKey ? !repo.addParent(dragged.id, parent, sort) : !repo.moveParent(dragged.id, dragged.from, parent, sort)) return;
      } else repo.setSort(dragged.id, parent, sort);
    } else {
      // to the top level: pinned at this position
      if (dragged.from && !e.altKey) repo.removeParent(dragged.id, dragged.from);
      repo.setSort(dragged.id, null, sort);
    }
  };

  return (
    <div>
      <div
        draggable={!touch}
        onDragStart={(e) => {
          startDrag(e, { id: item.id, from: parent, space, type: isType }, item.title);
          e.dataTransfer.effectAllowed = "copyMove";
        }}
        onDragOver={(e) => {
          const dragged = dragging;
          if (!dragged || dragged.id === item.id || dragged.from === "types") return;
          const other = dragged.space !== space;
          // from another workspace only into this item (a move), never into a type page; a type
          // page only changes its place among the pinned
          if (other ? !movable(dragged) || isType : dragged.type && parent !== null) return;
          e.preventDefault();
          e.stopPropagation();
          const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const y = e.clientY - box.top;
          const edge = y < box.height / 2 ? "before" : "after";
          setDrop(other ? "inside" : dragged.type || isType ? edge : dropZone(y, box.height));
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
        onContextMenu={touch ? undefined : menu.onContextMenu}
        className={cn(
          "group/row relative flex items-center gap-1 rounded-lg pr-1",
          touch ? "py-2 text-[15px]" : "py-1 text-sm",
          activeId === item.id ? "bg-hover font-medium text-fg" : "text-muted-foreground hover:bg-hover hover:text-fg",
          drop === "inside" && "ring-2 ring-focus",
        )}
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        {drop === "before" && <span className="absolute inset-x-1 -top-px h-0.5 rounded bg-focus" />}
        {drop === "after" && <span className="absolute inset-x-1 -bottom-px h-0.5 rounded bg-focus" />}
        <Button variant="plain"
          tabIndex={-1}
          onClick={() => kids.length && toggle(key, depth)}
          className={cn("relative z-10 flex shrink-0 items-center justify-center rounded text-muted-foreground", touch ? "tap -my-1.5 size-8" : "size-5", kids.length ? "hover:bg-surface-2" : "invisible")}
          aria-label={isOpen ? t("tree.collapse") : t("tree.expand")}
          aria-expanded={isOpen}
        >
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </Button>
        {isType ? <TypeGlyph schema={item.schema} size={rowIconSize(touch)} /> : <ItemIcon item={item} size={rowIconSize(touch)} />}
        {/* the row is dragged, not the link in it; the link covers the whole row (::after), only
            the buttons lie above it */}
        <a href={spaceHref(space, itemPath(item.id))} draggable={false} className="min-w-0 flex-1 truncate after:absolute after:inset-0 after:rounded-lg" title={secondary ? `${item.title}\n${t("tree.secondary", { home: ix.get(home)?.title ?? "" })}` : item.title} aria-current={activeId === item.id ? "page" : undefined}>
          {isType ? ix.typePlural(item.id) : distinctLabel(item.title, parent ? ix.get(parent)?.title : undefined) || t("untitled")}
        </a>
        {secondary && (
          <span className="pointer-events-none text-muted-foreground">
            <Link2 size={12} />
          </span>
        )}
        {/* on a phone there is no hover: no invisible buttons to hit by accident */}
        {!touch && !isType && (
          <Button variant="plain"
            onClick={() => {
              if (!isOpen) toggle(key, depth);
              createAndOpen({ parents: [item.id] }, repo, space);
            }}
            tabIndex={-1}
            className="relative z-10 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-surface-2 hover:text-fg group-hover/row:opacity-100 focus:opacity-100"
            aria-label={t("tree.newBelow")}
            title={t("tree.newBelow")}
          >
            <Plus size={13} />
          </Button>
        )}
        {!touch && <MoreMenu menu={menu} size="xs" iconSize={14} tabIndex={-1} className={cn("relative z-10 hover:bg-surface-2", REVEAL.row)}>
          {(close) => (
            <>
              <MenuItem onClick={() => (close(), repo.pin(item.id, !item.pinned))}>{item.pinned ? t("item.unpin") : t("item.pin")}</MenuItem>
              {parent && secondary && <MenuItem onClick={() => (close(), repo.setHome(item.id, parent))}>{t("place.makeHome")}</MenuItem>}
              {/* types are deleted on their page, with the preview of what becomes of the values */}
              {!isType && <MenuItem danger onClick={() => (close(), toTrash())}>{t("item.delete")}</MenuItem>}
            </>
          )}
        </MoreMenu>}
      </div>
      {deleting && <DeleteDialog item={item} leave={activeId === item.id} onClose={() => setDeleting(false)} />}
      {isOpen &&
        kids.map((k, i) => <TreeNode key={k.id} item={k} parent={item.id} siblings={kids} index={i} depth={depth + 1} isOpen={opened} toggle={toggle} activeId={activeId} keep={keep} touch={touch} />)}
    </div>
  );
}
