// Sidebar: search, Start, Eingang; "Angeheftet" – pinned informations with their children as a
// tree, in their own order; "Typen" – the page of every type and the files, in their own order.
// Both fold; what is open is remembered on this device (first start: everything open). In the
// tree, dragging replaces the parent you come from; with Alt held a place is added. Dropping on
// the upper or lower edge of a row reorders.
import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown, LayoutDashboard, Inbox, Search, Sparkles, SlidersHorizontal, Link2, MoreHorizontal, Plus, Paperclip } from "lucide-react";
import { type Item, SETTINGS_ID, setSchemaField, setSettings } from "@obtion/core/model";
import { sidebarChildren, sidebarRoots } from "@obtion/core/placement";
import { inboxWhere } from "@obtion/core/inbox";
import { runQuery } from "@obtion/core/query";
import { keyBetween, keysFor } from "@obtion/core/sortkey";
import { useIndex, useRoute, itemHref, useLocalStorage } from "../hooks";
import { repo } from "../repo";
import { useT } from "../i18n";
import { ItemIcon, Kbd, MenuItem, Popover, TypeGlyph, cx, shortcut } from "./bits";
import { ItemPicker } from "./Picker";
import { SyncDot } from "./SyncDot";
import { createAndOpen } from "../actions";
import { NewTypeDialog } from "../views/Types";

let dragging: { id: string; from: string | null } | null = null;

export function Sidebar({ onSearch, onAgent }: { onSearch: () => void; onAgent: () => void }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const route = useRoute();
  const inbox = runQuery({ where: inboxWhere(ix) }, { ix }).total;
  const navCls = (active: boolean) => cx("flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm", active ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg");

  return (
    <aside className="flex w-[256px] shrink-0 flex-col border-r border-line bg-surface-2/50 pt-safe">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <img src="/icon.svg" alt="" className="size-6" />
        <span className="font-semibold tracking-tight">Obtion</span>
        <SyncDot />
      </div>
      <button onClick={onSearch} className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-muted hover:text-fg">
        <Search size={15} />
        <span className="flex-1 text-left">{t("nav.searchPlaceholder")}</span>
        <Kbd>{shortcut("K", lang)}</Kbd>
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <nav className="flex flex-col gap-0.5 px-2" aria-label={t("nav.main")}>
          <a href="#/" className={navCls(route.path === "/")}>
            <LayoutDashboard size={16} /> <span className="flex-1">{t("nav.start")}</span>
          </a>
          <a href="#/inbox" className={navCls(route.path.startsWith("/inbox"))}>
            <Inbox size={16} /> <span className="flex-1">{t("nav.inbox")}</span>
            {inbox > 0 && <span className="text-xs tabular-nums text-muted">{inbox}</span>}
          </a>
        </nav>
        <PinnedTree />
        <TypeNav />
      </div>
      {/* below: the agent and the settings (activity, graph, trash and the language live there) */}
      <div className="flex flex-col gap-0.5 border-t border-line p-2">
        <button onClick={onAgent} className={navCls(false)}>
          <Sparkles size={16} /> <span className="flex-1 text-left">{t("nav.agent")}</span> <Kbd>{shortcut("J", lang)}</Kbd>
        </button>
        <a href="#/settings" className={navCls(["/settings", "/types", "/activity", "/trash", "/graph"].some((x) => route.path.startsWith(x)))}>
          <SlidersHorizontal size={16} /> {t("nav.settings")}
        </a>
      </div>
    </aside>
  );
}

/** A block of the sidebar with a heading that folds it (remembered on this device; open at first). */
function Section({ id, title, add, touch, children }: { id: string; title: string; add: { label: string; run: () => void }; touch?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useLocalStorage<boolean>(`obtion.sidebar.${id}`, true);
  return (
    <section className="mt-3.5" aria-label={title}>
      <div className={cx("flex h-7 items-center gap-0.5", touch ? "px-3" : "px-4")}>
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="-ml-1 flex flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted hover:text-fg">
          <ChevronRight size={13} className={cx("text-faint transition-transform", open && "rotate-90")} />
          {title}
        </button>
        <button title={add.label} aria-label={add.label} onClick={add.run} className={cx("tap rounded text-muted hover:bg-hover hover:text-fg", touch ? "p-1.5" : "p-0.5")}>
          <Plus size={14} />
        </button>
      </div>
      {open && children}
    </section>
  );
}

/**
 * "Angeheftet": the pinned informations with their children as a tree. What is open stays open
 * (on this device); the way to the open page unfolds by itself, nothing closes by itself. Done
 * entries are left out, except the open page. The same block in the sidebar and the phone menu
 * (`touch`: taller rows, no drag and drop, no hover buttons).
 */
export function PinnedTree({ touch }: { touch?: boolean }) {
  const { t } = useT();
  const ix = useIndex();
  const route = useRoute();
  const [open, setOpen] = useLocalStorage<Record<string, boolean>>("obtion.sidebar.tree", {});
  const activeId = route.parts[0] === "i" ? route.parts[1] : undefined;
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
    <Section id="pinned" title={t("nav.pinned")} touch={touch} add={{ label: t("nav.newPinned"), run: () => createAndOpen({ pinned: keyBetween(roots.at(-1)?.pinned ?? null, null) }) }}>
      <div
        className={cx("min-h-6", !touch && "px-2")}
        onDragOver={(e) => dragging && dragging.from !== "types" && e.preventDefault()}
        onDrop={(e) => {
          // dropped on empty space: pinned at the end (moving away from the parent it came from)
          if (!dragging || dragging.from === "types" || e.defaultPrevented) return;
          if (dragging.from && !e.altKey) repo.removeParent(dragging.id, dragging.from);
          repo.setSort(dragging.id, null, keyBetween(roots.at(-1)?.pinned ?? null, null));
          dragging = null;
        }}
      >
        {roots.map((r, i) => (
          <TreeNode key={r.id} item={r} parent={null} siblings={roots} index={i} depth={0} {...tree} />
        ))}
        {!roots.length && <p className="px-2.5 py-1 text-xs text-muted">{t("nav.noPinned")}</p>}
      </div>
    </Section>
  );
}

/** "Typen": the page of every type and the files, in an order of their own (synced); a new type comes last. */
export function TypeNav({ touch }: { touch?: boolean }) {
  const { t } = useT();
  const ix = useIndex();
  const route = useRoute();
  const [creating, setCreating] = useState(false);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
  const filesPos = ix.all.get(SETTINGS_ID)?.settings?.filesPos;
  const rows = [
    ...ix.typesInOrder().map((x) => ({ id: x.id, key: x.schema!.pos, label: ix.typePlural(x.id), href: itemHref(x.id), icon: <TypeGlyph schema={x.schema} size={touch ? 17 : 15} /> })),
    { id: "files", key: filesPos, label: t("nav.files"), href: "#/files", icon: <Paperclip size={touch ? 17 : 15} className="shrink-0" /> },
  ].sort((a, b) => (a.key ?? "~") < (b.key ?? "~") ? -1 : (a.key ?? "~") > (b.key ?? "~") ? 1 : 0);
  const active = (id: string) => (id === "files" ? route.path.startsWith("/files") : route.parts[0] === "i" && route.parts[1] === id);
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
  return (
    <Section id="types" title={t("nav.types")} touch={touch} add={{ label: t("types.new"), run: () => setCreating(true) }}>
      <nav className={cx("flex flex-col gap-px", !touch && "px-2")}>
        {rows.map((r) => (
          <a
            key={r.id}
            href={r.href}
            draggable={!touch}
            onDragStart={(e) => ((dragging = { id: r.id, from: "types" }), e.dataTransfer.setData("text/plain", r.label))}
            onDragOver={(e) => {
              if (dragging?.from !== "types" || dragging.id === r.id) return;
              e.preventDefault();
              const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDrop({ id: r.id, before: e.clientY < box.top + box.height / 2 });
            }}
            onDragLeave={() => setDrop(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging?.from === "types" && drop) move(dragging.id, r.id, drop.before);
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
      </nav>
      {creating && <NewTypeDialog onClose={() => setCreating(false)} />}
    </Section>
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
  const ix = useIndex();
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
          dragging = { id: item.id, from: parent };
          e.dataTransfer.effectAllowed = "copyMove";
          e.dataTransfer.setData("text/plain", item.title);
        }}
        onDragOver={(e) => {
          if (!dragging || dragging.id === item.id || dragging.from === "types") return;
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const y = e.clientY - r.top;
          setDrop(y < r.height * 0.25 ? "before" : y > r.height * 0.75 ? "after" : "inside");
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
        <ItemIcon item={item} size={touch ? 17 : 15} />
        <a href={itemHref(item.id)} className="min-w-0 flex-1 truncate" title={item.title} aria-current={activeId === item.id ? "page" : undefined}>
          {distinctLabel(item.title, parent ? ix.get(parent)?.title : undefined) || t("untitled")}
        </a>
        {secondary && (
          <span title={t("tree.secondary", { home: ix.get(home)?.title ?? "" })} className="text-muted">
            <Link2 size={12} />
          </span>
        )}
        {/* on a phone there is no hover: no invisible buttons to hit by accident */}
        {!touch && (
          <button
            onClick={() => {
              if (!isOpen) toggle(key, depth);
              createAndOpen({ parents: [item.id] });
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
              <MenuItem onClick={() => (close(), setPicking(true))}>{item.kind === "datei" ? t("place.change") : t("place.add")}</MenuItem>
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
