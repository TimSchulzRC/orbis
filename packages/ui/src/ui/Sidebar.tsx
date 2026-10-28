// Sidebar: the workspace selector (which workspaces are seen), search and the inbox (of
// the workspaces seen), then each of them as a block of its own (as teamspaces in Notion): its
// name, the pinned items (informations with their children as a tree, also type pages), and its
// types with the files. Blocks and what is open in them fold; that is remembered on
// this device. In the tree, dragging replaces the parent you come from; with Alt held a place is
// added. Dropping on the upper or lower edge of a row reorders. Dropped into another workspace's
// block, an item moves there.
import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown, Inbox, Search, Sparkles, SlidersHorizontal, Link2, MoreHorizontal, Plus, Paperclip } from "lucide-react";
import { type Item, META_TYPE, SETTINGS_ID, setSchemaField, setSettings } from "@obtion/core/model";
import { sidebarChildren, sidebarRoots } from "@obtion/core/placement";
import { inboxWhere } from "@obtion/core/inbox";
import { runQuery } from "@obtion/core/query";
import { keyBetween, keysFor } from "@obtion/core/sortkey";
import { useRepo, useRoute, useSpaceId, itemHref, spaceHref, useLocalStorage } from "../hooks";
import { type Space, onServer, useAccounts } from "../accounts";
import { useT } from "../i18n";
import { Kbd, MenuItem, Popover, TypeGlyph, ItemIcon, cx, shortcut } from "./bits";
import { ItemPicker } from "./Picker";
import { SyncDot } from "./SyncDot";
import { createAndOpen } from "../actions";
import { NewTypeDialog } from "../views/Types";
import { NewSpaceDialog, SpaceScope, SpaceSelector, moveTo, useReplicas } from "./Spaces";

/**
 * What is being dragged in the sidebar: an item (from below `from`, null: pinned; `type`: a pinned
 * type page, which only changes its place among the pinned) or a row of "Typen", and from which workspace.
 */
let dragging: { id: string; from: string | null; space: string; type?: boolean } | null = null;
/** Can it go into another workspace? Items can (a move), type pages and rows of "Typen" not. */
const movable = (d: typeof dragging) => !!d && d.from !== "types" && !d.type;

/** How many entries wait in the inboxes of the workspaces seen. */
export function useInboxTotal() {
  const { shown } = useAccounts();
  return useReplicas(shown.map((s) => s.id)).reduce((n, r) => {
    const ix = r.index();
    return n + (r.get(SETTINGS_ID) ? runQuery({ where: inboxWhere(ix) }, { ix }).total : 0);
  }, 0);
}

export function Sidebar({ onSearch, onAgent }: { onSearch: () => void; onAgent: () => void }) {
  const { t, lang } = useT();
  const route = useRoute();
  const { shown } = useAccounts();
  const inbox = useInboxTotal();
  const [creating, setCreating] = useState(false);
  const navCls = (active: boolean) => cx("flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm", active ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg");

  return (
    <aside className="flex w-[256px] shrink-0 flex-col border-r border-line bg-surface-2/50 pt-safe">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <SpaceSelector className="flex-1" onNew={() => setCreating(true)} />
        <SyncDot />
      </div>
      <button onClick={onSearch} className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-muted hover:text-fg">
        <Search size={15} />
        <span className="flex-1 text-left">{t("nav.searchPlaceholder")}</span>
        <Kbd>{shortcut("K", lang)}</Kbd>
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <nav className="flex flex-col gap-0.5 px-2" aria-label={t("nav.main")}>
          <a href="#/inbox" className={navCls(route.path.startsWith("/inbox"))}>
            <Inbox size={16} /> <span className="flex-1">{t("nav.inbox")}</span>
            {inbox > 0 && <span className="text-xs tabular-nums text-muted">{inbox}</span>}
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
      {/* below: the agent and the settings (the account, its workspaces, this device) */}
      <div className="flex flex-col gap-0.5 border-t border-line p-2">
        <button onClick={onAgent} className={navCls(false)}>
          <Sparkles size={16} /> <span className="flex-1 text-left">{t("nav.agent")}</span> <Kbd>{shortcut("J", lang)}</Kbd>
        </button>
        <a href="#/settings" className={navCls(route.path.startsWith("/settings"))}>
          <SlidersHorizontal size={16} /> {t("nav.settings")}
        </a>
      </div>
    </aside>
  );
}

/**
 * One workspace in the sidebar (and the phone menu, `touch`: taller rows, no drag and drop, no
 * hover buttons): its name folds the block, its menu leads to its settings, activity and trash.
 * Dropping an item of another workspace onto the name moves it here.
 */
export function SpaceTree({ space, touch }: { space: Space; touch?: boolean }) {
  const { t } = useT();
  const repo = useRepo();
  const { active, shown } = useAccounts();
  const here = active?.id === space.id;
  const [open, setOpen] = useLocalStorage<boolean>(`obtion.sidebar.space.${space.id}`, true);
  const [typesOpen, setTypesOpen] = useLocalStorage<boolean>(`obtion.sidebar.types.${space.id}`, shown.length === 1);
  const [over, setOver] = useState(false);
  const ix = repo.index();
  const roots = sidebarRoots(ix);
  const ready = !!repo.get(SETTINGS_ID);
  const go = (path: string) => (location.hash = spaceHref(space.id, path));
  const row = cx("flex items-center gap-2 rounded-lg pr-2", touch ? "py-2 text-[15px]" : "py-1 text-sm");
  return (
    <section className="mt-2" aria-label={space.name}>
      <div
        className={cx("group/space flex h-7 items-center gap-0.5 rounded-lg", touch ? "px-3" : "mx-2 px-2", over && "bg-hover ring-1 ring-[var(--focus)]")}
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
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="-ml-1 flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted hover:text-fg">
          <ChevronRight size={13} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
          <span className="truncate">{space.name}</span>
        </button>
        {ready && (
          <button
            title={t("nav.newPinned")}
            aria-label={t("nav.newPinned")}
            onClick={() => createAndOpen({ pinned: keyBetween(roots.at(-1)?.pinned ?? null, null) }, repo, space.id)}
            className={cx("tap rounded text-muted hover:bg-hover hover:text-fg", touch ? "p-1.5" : "p-0.5 opacity-0 focus:opacity-100 group-hover/space:opacity-100")}
          >
            <Plus size={14} />
          </button>
        )}
        <Popover
          align="right"
          trigger={(p) => (
            <button {...p} className={cx("tap rounded text-muted hover:bg-hover hover:text-fg", touch ? "p-1.5" : "p-0.5 opacity-0 focus:opacity-100 group-hover/space:opacity-100 aria-expanded:opacity-100")} aria-label={t("space.menu", { name: space.name })}>
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem onClick={() => (close(), go("/workspace"))}>{t("space.settings")}</MenuItem>
              {onServer(space.id) && <MenuItem onClick={() => (close(), go("/activity"))}>{t("nav.activity")}</MenuItem>}
              <MenuItem onClick={() => (close(), go("/trash"))}>{t("nav.trash")}</MenuItem>
            </>
          )}
        </Popover>
      </div>
      {open && !ready && (
        <a href={spaceHref(space.id, "/setup")} className={cx(row, "pl-[30px] text-muted hover:bg-hover hover:text-fg", !touch && "mx-2")}>
          {repo.status.loaded && (repo.status.synced || !repo.status.online) ? t("space.setUp") : t("app.syncing")}
        </a>
      )}
      {open && ready && (
        <div className={cx(!touch && "px-2")}>
          <PinnedTree touch={touch} here={here} />
          <button onClick={() => setTypesOpen(!typesOpen)} aria-expanded={typesOpen} className={cx(row, "w-full pl-2.5 text-muted hover:bg-hover hover:text-fg")}>
            <ChevronRight size={touch ? 17 : 15} className={cx("shrink-0 text-faint transition-transform", typesOpen && "rotate-90")} />
            {t("nav.types")}
          </button>
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
export function PinnedTree({ touch, here }: { touch?: boolean; here: boolean }) {
  const repo = useRepo();
  const space = useSpaceId()!;
  const ix = repo.index();
  const route = useRoute();
  const [open, setOpen] = useLocalStorage<Record<string, boolean>>("obtion.sidebar.tree", {});
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
export function TypeNav({ touch, here }: { touch?: boolean; here: boolean }) {
  const { t } = useT();
  const repo = useRepo();
  const space = useSpaceId()!;
  const ix = repo.index();
  const route = useRoute();
  const [creating, setCreating] = useState(false);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
  const filesPos = ix.all.get(SETTINGS_ID)?.settings?.filesPos;
  const rows = [
    ...ix.typesInOrder().map((x) => ({ id: x.id, key: x.schema!.pos, label: ix.typePlural(x.id), href: itemHref(x.id), icon: <TypeGlyph schema={x.schema} size={touch ? 17 : 15} /> })),
    { id: "files", key: filesPos, label: t("nav.files"), href: "#/files", icon: <Paperclip size={touch ? 17 : 15} className="shrink-0" /> },
  ].sort((a, b) => (a.key ?? "~") < (b.key ?? "~") ? -1 : (a.key ?? "~") > (b.key ?? "~") ? 1 : 0);
  const active = (id: string) => here && (id === "files" ? route.path.startsWith("/files") : route.parts[0] === "i" && route.parts[1] === id);
  // a new order: every row gets a fresh key, written only where it changed
  const move = (id: string, to: string, before: boolean) => {
    const order = rows.filter((r) => r.id !== id);
    order.splice(order.findIndex((r) => r.id === to) + (before ? 0 : 1), 0, rows.find((r) => r.id === id)!);
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
          onDragStart={(e) => ((dragging = { id: r.id, from: "types", space }), e.dataTransfer.setData("text/plain", r.label))}
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
          className={cx("relative flex items-center gap-2 rounded-lg pl-[30px] pr-2", touch ? "py-2 text-[15px]" : "py-1 text-sm", active(r.id) ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}
        >
          {drop?.id === r.id && <span className={cx("absolute inset-x-1 h-0.5 rounded bg-[var(--focus)]", drop.before ? "-top-px" : "-bottom-px")} />}
          {r.icon}
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
        </a>
      ))}
      <button onClick={() => setCreating(true)} className={cx("flex items-center gap-2 rounded-lg pl-[30px] pr-2 text-muted hover:bg-hover hover:text-fg", touch ? "py-2 text-[15px]" : "py-1 text-sm")}>
        <Plus size={touch ? 17 : 15} className="shrink-0" /> {t("types.new")}
      </button>
      {creating && <NewTypeDialog onClose={() => setCreating(false)} />}
    </nav>
  );
}

/**
 * A child that repeats its parent's title ("Relaunch Frankreich" below "Relaunch") shows
 * only what it adds: "… Frankreich". Anything else keeps its title and is cut at the end (the
 * full title is the tooltip) – never stumps like "… im Alltag".
 */
export function distinctLabel(title: string, parentTitle?: string): string {
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
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);

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
          dragging = { id: item.id, from: parent, space, type: isType };
          e.dataTransfer.effectAllowed = "copyMove";
          e.dataTransfer.setData("text/plain", item.title);
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
        className={cx(
          "group/row relative flex items-center gap-1 rounded-lg pr-1",
          touch ? "py-2 text-[15px]" : "py-1 text-sm",
          activeId === item.id ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
          drop === "inside" && "ring-2 ring-[var(--focus)]",
        )}
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        {drop === "before" && <span className="absolute inset-x-1 -top-px h-0.5 rounded bg-[var(--focus)]" />}
        {drop === "after" && <span className="absolute inset-x-1 -bottom-px h-0.5 rounded bg-[var(--focus)]" />}
        <button
          tabIndex={-1}
          onClick={() => kids.length && toggle(key, depth)}
          className={cx("flex shrink-0 items-center justify-center rounded text-muted", touch ? "tap -my-1.5 size-8" : "size-5", kids.length ? "hover:bg-surface-2" : "invisible")}
          aria-label={isOpen ? t("tree.collapse") : t("tree.expand")}
          aria-expanded={isOpen}
        >
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {isType ? <TypeGlyph schema={item.schema} size={touch ? 17 : 15} /> : <ItemIcon item={item} size={touch ? 17 : 15} />}
        <a href={itemHref(item.id)} className="min-w-0 flex-1 truncate" title={item.title} aria-current={activeId === item.id ? "page" : undefined}>
          {isType ? ix.typePlural(item.id) : distinctLabel(item.title, parent ? ix.get(parent)?.title : undefined) || t("untitled")}
        </a>
        {secondary && (
          <span title={t("tree.secondary", { home: ix.get(home)?.title ?? "" })} className="text-muted">
            <Link2 size={12} />
          </span>
        )}
        {/* on a phone there is no hover: no invisible buttons to hit by accident */}
        {!touch && !isType && (
          <button
            onClick={() => {
              if (!isOpen) toggle(key, depth);
              createAndOpen({ parents: [item.id] }, repo, space);
            }}
            tabIndex={-1}
            className="rounded p-0.5 text-muted opacity-0 hover:bg-surface-2 hover:text-fg group-hover/row:opacity-100 focus:opacity-100"
            aria-label={t("tree.newBelow")}
            title={t("tree.newBelow")}
          >
            <Plus size={13} />
          </button>
        )}
        {!touch && <Popover
          open={menu}
          onOpenChange={setMenu}
          align="right"
          trigger={(p) => (
            <button {...p} tabIndex={-1} className="tap rounded p-0.5 text-muted opacity-0 pointer-coarse:opacity-100 hover:bg-surface-2 hover:text-fg group-hover/row:opacity-100 focus:opacity-100" aria-label={t("more")}>
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem onClick={() => (close(), repo.pin(item.id, !item.pinned))}>{item.pinned ? t("item.unpin") : t("item.pin")}</MenuItem>
              {!isType && <MenuItem onClick={() => (close(), setPicking(true))}>{item.kind === "datei" ? t("place.change") : t("place.add")}</MenuItem>}
              {parent && <MenuItem onClick={() => (close(), repo.removeParent(item.id, parent))}>{t("place.removeHere")}</MenuItem>}
              {parent && secondary && <MenuItem onClick={() => (close(), repo.setHome(item.id, parent))}>{t("place.makeHome")}</MenuItem>}
            </>
          )}
        </Popover>}
      </div>
      {picking && (
        <ItemPicker
          title={t("place.add")}
          exclude={(x) => x.id === item.id || ix.wouldCycle(item.id, x.id) || !!item.parents[x.id]}
          onPick={(id) => {
            repo.addParent(item.id, id);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {isOpen &&
        kids.map((k, i) => <TreeNode key={k.id} item={k} parent={item.id} siblings={kids} index={i} depth={depth + 1} isOpen={opened} toggle={toggle} activeId={activeId} keep={keep} touch={touch} />)}
    </div>
  );
}
