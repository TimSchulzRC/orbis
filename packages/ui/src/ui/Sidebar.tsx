// Sidebar: the workspace selector (which workspaces are seen), search and Heute (the inbox is the
// tray's, below every page), then each of them as a block of its own (as teamspaces in Notion): its
// name, the pinned items (informations with their children as a tree, also type pages), and its
// types with the files. At the bottom: activity and trash (of the workspaces seen) and the settings. Blocks and what is open in them fold; that is remembered on
// this device. In the tree, dragging replaces the parent you come from; with Alt held a place is
// added. Dropping on the upper or lower edge of a row reorders. Dropped into another workspace's
// block, an item moves there.
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, ChevronDown, History, Search, Settings, Link2, Plus, Paperclip, Sun, Trash2 } from "lucide-react";
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
 * Starts a drag of the sidebar's own: only the title as text. The address the browser adds for a
 * link is dropped, or it takes the drag for a link to open elsewhere (a new tab, a split view).
 */
const startDrag = (e: React.DragEvent, d: NonNullable<typeof dragging>, text: string) => {
  dragging = d;
  e.dataTransfer.clearData();
  e.dataTransfer.setData("text/plain", text);
};
/** Can it go into another workspace? Items can (a move), type pages and rows of "Typen" not. */
const movable = (d: typeof dragging) => !!d && d.from !== "types" && !d.type;

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { t, lang } = useT();
  const route = useRoute();
  const { shown } = useAccounts();
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
        </nav>
        {/* a line above each workspace: where one ends and the next begins */}
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

/**
 * One workspace in the sidebar (and the phone menu, `touch`: taller rows, no drag and drop, no
 * hover buttons): its name folds the block, "+" pins a new information. Dropping an item of
 * another workspace onto the name moves it here.
 */
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
          const d = dragging;
          dragging = null;
          if (movable(d) && d!.space !== space.id) void moveTo(d!.id, d!.space, space.id);
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
      {/* set up as soon as it is in step with the server (accounts.ts) */}
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

/**
 * The pinned informations of a workspace with their children as a tree. What is open stays open
 * (on this device); the way to the open page unfolds by itself, nothing closes by itself. Done
 * entries are left out, except the open page. `here`: the workspace is the open one.
 */
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
        const d = dragging;
        if (!d || d.from === "types" || e.defaultPrevented) return;
        dragging = null;
        if (d.space !== space) return void (movable(d) && moveTo(d.id, d.space, space));
        if (d.from && !e.altKey) repo.removeParent(d.id, d.from);
        repo.setSort(d.id, null, keyBetween(roots.at(-1)?.pinned ?? null, null));
      }}
    >
      {roots.map((r, i) => (
        <TreeNode key={r.id} item={r} parent={null} siblings={roots} index={i} depth={0} {...tree} />
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
    ...ix.typesInOrder().map((x) => ({ id: x.id, key: x.schema.pos, label: ix.typePlural(x.id), href: spaceHref(space, itemPath(x.id)), icon: <TypeGlyph schema={x.schema} size={touch ? 17 : 15} /> })),
    { id: "files", key: filesPos, label: t("nav.files"), href: spaceHref(space, "/files"), icon: <Paperclip size={touch ? 17 : 15} className="shrink-0" /> },
  ].sort((a, b) => cmpKey(a.key ?? "~", b.key ?? "~"));
  const active = (id: string) => here && (id === "files" ? route.path.startsWith("/files") : route.parts[0] === "i" && route.parts[1] === id);
  // a new order: every row gets a fresh key, written only where it changed
  const move = (id: string, to: string, before: boolean) => {
    const order = moveInArray(rows, rows.findIndex((r) => r.id === id), rows.findIndex((r) => r.id === to) + (before ? 0 : 1));
    keysFor(order.length).forEach((k, i) => {
      const r = order[i]!;
      if (r.key === k) return;
      if (r.id === "files") repo.change(SETTINGS_ID, (d) => setSettings(d, { filesPos: k }));
      else repo.change(r.id, (d) => setSchemaField(d, "pos", k));
    });
  };
  const ours = () => dragging?.from === "types" && dragging.space === space;
  return (
    <nav className="flex flex-col gap-px" aria-label={t("nav.types")}>
      {rows.map((r) => (
        <a
          key={r.id}
          href={r.href}
          draggable={!touch}
          onDragStart={(e) => startDrag(e, { id: r.id, from: "types", space }, r.label)}
          onDragOver={(e) => {
            if (!ours() || dragging!.id === r.id) return;
            e.preventDefault();
            const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setDrop({ id: r.id, before: e.clientY < box.top + box.height / 2 });
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={(e) => {
            e.preventDefault();
            if (ours() && drop) move(dragging!.id, r.id, drop.before);
            dragging = null;
            setDrop(null);
          }}
          aria-current={active(r.id) ? "page" : undefined}
          className={cn("relative flex items-center gap-2 rounded-lg pl-[30px] pr-2", touch ? "py-2 text-[15px]" : "py-1 text-sm", active(r.id) ? "bg-hover font-medium text-fg" : "text-muted-foreground hover:bg-hover hover:text-fg")}
        >
          {drop?.id === r.id && <span className={cn("absolute inset-x-1 h-0.5 rounded bg-focus", drop.before ? "-top-px" : "-bottom-px")} />}
          {r.icon}
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
        </a>
      ))}
      <Button variant="plain" onClick={() => setCreating(true)} className={cn("flex items-center gap-2 rounded-lg pl-[30px] pr-2 text-muted-foreground hover:bg-hover hover:text-fg", touch ? "py-2 text-[15px]" : "py-1 text-sm")}>
        <Plus size={touch ? 17 : 15} className="shrink-0" /> {t("types.new")}
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
  const p = parentTitle?.trim();
  if (!p || title.length <= p.length) return title;
  if (title.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return title;
  const rest = title.slice(p.length);
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
    const d = dragging;
    dragging = null;
    setDrop(null);
    if (!d || d.id === item.id) return;
    if (d.space !== space) return void (movable(d) && !isType && moveTo(d.id, d.space, space, item.id));
    if ((d.type || isType) && drop === "inside") return;
    if (drop === "inside") {
      if (e.altKey) repo.addParent(d.id, item.id);
      else if (d.from) repo.moveParent(d.id, d.from, item.id);
      else if (repo.addParent(d.id, item.id)) repo.pin(d.id, false); // from the top: no longer pinned
      if (!isOpen) toggle(key, depth);
      return;
    }
    // reorder among the siblings of this row
    const before = drop === "before";
    const neighbour = siblings[before ? index - 1 : index + 1];
    const a = before ? (neighbour ? sortOf(neighbour) : null) : sortOf(item);
    const b = before ? sortOf(item) : neighbour ? sortOf(neighbour) : null;
    const sort = keyBetween(a, b);
    if (parent) {
      if (d.from !== parent) {
        if (e.altKey ? !repo.addParent(d.id, parent, sort) : !repo.moveParent(d.id, d.from, parent, sort)) return;
      } else repo.setSort(d.id, parent, sort);
    } else {
      // to the top level: pinned at this position
      if (d.from && !e.altKey) repo.removeParent(d.id, d.from);
      repo.setSort(d.id, null, sort);
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
          const d = dragging;
          if (!d || d.id === item.id || d.from === "types") return;
          const other = d.space !== space;
          // from another workspace only into this item (a move), never into a type page; a type
          // page only changes its place among the pinned
          if (other ? !movable(d) || isType : d.type && parent !== null) return;
          e.preventDefault();
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const y = e.clientY - r.top;
          const edge = y < r.height / 2 ? "before" : "after";
          setDrop(other ? "inside" : d.type || isType ? edge : y < r.height * 0.25 ? "before" : y > r.height * 0.75 ? "after" : "inside");
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
        {isType ? <TypeGlyph schema={item.schema} size={touch ? 17 : 15} /> : <ItemIcon item={item} size={touch ? 17 : 15} />}
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
