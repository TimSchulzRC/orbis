// Parts every page shares, information and file pages alike (design rules § 3.1).
import { ChevronRight, Link2, Pin, PinOff, Plus, RotateCcw, Star, X } from "lucide-react";
import { useState } from "react";
import { type Item, META_TYPE } from "@obtion/core/model";
import { hasPlace, isInInbox } from "@obtion/core/placement";
import { fmtDate, type T } from "@obtion/core/i18n";
import type { Index } from "@obtion/core/graph";
import { repo } from "../repo";
import { itemHref, useIndex, usePhone } from "../hooks";
import { useT, titleOf } from "../i18n";
import { ItemIcon, ItemLink, RelTime } from "./item-look";
import { Button, IconButton, MenuItem, MoreMenu, Popover, REVEAL } from "./primitives";
import { Tip } from "../components/ui/tooltip";
import { ItemPicker } from "./Picker";
import { cn } from "../lib/utils";
import { dateOf } from "@obtion/core/date";

export function Crumbs({ item, tools, onPlace }: { item: Item; tools: React.ReactNode; onPlace: () => void }) {
  const ix = useIndex();
  const { t } = useT();
  const narrow = usePhone();
  const path = ix.homePath(item.id);
  const others = ix.parentsOf(item.id).length - 1;
  const link = "max-w-[16rem] truncate hover:text-fg hover:underline";
  let lead: React.ReactNode = null;
  if (path.length) {
    const shown = narrow && path.length > 1 ? path.slice(-1) : path;
    lead = (
      <>
        {narrow && path.length > 1 && (
          <>
            <span aria-hidden>…</span>
            <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden />
          </>
        )}
        {shown.map((id, i) => (
          <span key={id} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden />}
            <a href={itemHref(id)} className={link}>
              {ix.get(id)?.title || t("untitled")}
            </a>
          </span>
        ))}
        {others > 0 && <PlacesMenu item={item} count={others} onPlace={onPlace} />}
      </>
    );
  } else if (isInInbox(item, ix)) {
    lead = (
      <>
        <a href="#/inbox" className={link}>
          {t("kind.inbox")}
        </a>
        <Button variant="plain" onClick={onPlace} className="tap-y ml-1 text-link hover:underline">
          {t("triage.place")}
        </Button>
      </>
    );
  } else if (item.pinned) {
    lead = (
      <span className="flex items-center gap-1">
        <Pin size={12} className="text-faint" aria-hidden /> {t("place.pinned")}
      </span>
    );
  } else if (item.type && ix.types.has(item.type)) {
    lead = (
      <a href={itemHref(item.type)} className={link}>
        {ix.typePlural(item.type)}
      </a>
    );
  }
  return (
    <div className="page-bar flex min-h-7 items-center gap-1 text-[13px] text-muted-foreground max-md:min-h-8">
      <nav className="flex min-w-0 items-center gap-1" aria-label={t("item.path")}>
        {lead}
      </nav>
      <div className="ml-auto flex shrink-0 items-center">{tools}</div>
    </div>
  );
}

/** "+N" in the path: every place of the entry, the home first, each with its path. */
function PlacesMenu({ item, count, onPlace }: { item: Item; count: number; onPlace: () => void }) {
  const ix = useIndex();
  const { t } = useT();
  const home = ix.home(item.id);
  const parents = [...ix.parentsOf(item.id)].sort((a, b) => (a === home ? -1 : b === home ? 1 : 0));
  return (
    <Popover
      trigger={(p) => (
        <Button variant="plain" {...p} className="tap-y ml-1 shrink-0 whitespace-nowrap rounded-full border border-line px-1.5 text-xs hover:text-fg aria-expanded:border-faint aria-expanded:text-fg" title={t("refs.places")}>
          +{count}
        </Button>
      )}
    >
      {(close) => (
        <div className="w-80 max-w-[calc(100vw-2rem)]">
          <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-muted-foreground">
            {t("refs.places")} <span className="font-normal tabular-nums">{parents.length}</span>
          </p>
          {parents.map((p) => {
            const place = ix.get(p);
            if (!place) return null;
            const above = ix.homePath(p).map((id) => titleOf(ix.get(id)!, t));
            return (
              <div key={p} className="group flex min-h-9 items-center gap-2 rounded-lg px-2.5 hover:bg-hover">
                <ItemIcon item={place} size={14} className="shrink-0" />
                <a href={itemHref(p)} onClick={close} className="flex min-w-0 flex-1 flex-col py-1">
                  <span className="truncate text-sm text-fg">{titleOf(place, t)}</span>
                  {above.length > 0 && <span className="truncate text-xs text-muted-foreground">{above.join(" › ")}</span>}
                </a>
                {p === home && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Star size={11} aria-hidden /> {t("place.home")}
                  </span>
                )}
                <MoreMenu size="xs" iconSize={13} className={cn("text-faint", REVEAL.any)}>
                  {(closeMenu) => (
                    <>
                      {p !== home && <MenuItem onClick={() => (closeMenu(), repo.setHome(item.id, p))}>{t("place.makeHome")}</MenuItem>}
                      <MenuItem onClick={() => (closeMenu(), close(), repo.removeParent(item.id, p))}>{t("place.removeHere")}</MenuItem>
                    </>
                  )}
                </MoreMenu>
              </div>
            );
          })}
          <div className="mt-1 border-t border-line pt-1">
            <MenuItem icon={<Plus size={14} />} onClick={() => (close(), onPlace())}>
              {t("place.addAnother")}
            </MenuItem>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function TrashBanner({ onRestore }: { onRestore: () => void }) {
  const { t } = useT();
  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-danger">
      {t("item.inTrash")}
      <Button onClick={onRestore} className="ml-auto">
        <RotateCcw size={14} /> {t("item.restore")}
      </Button>
    </div>
  );
}

interface LinkGroup {
  key: string;
  label: string;
  items: { item: Item; note?: React.ReactNode; tools?: React.ReactNode }[];
}

/** Everything linked with the page, both ways (design rules § 2.7): what points here, and where it points. */
function linkGroups(item: Item, ix: Index, t: T, usedIn: { item: Item; note?: string }[]): LinkGroup[] {
  const groups: LinkGroup[] = [];
  const linkingIds = new Set(ix.backlinks(item.id).filter((b) => b.kind !== "rel").map((b) => b.from));
  const from = [...linkingIds]
    .map((id) => ix.get(id)!)
    .filter((x) => x && x.kind === "info" && !x.deleted && x.type !== META_TYPE && !usedIn.some((u) => u.item.id === x.id));
  const where = (x: Item) => {
    const homePath = ix.homePath(x.id);
    return homePath.length ? <span className="truncate">{ix.get(homePath.at(-1)!)?.title}</span> : undefined;
  };
  if (usedIn.length) groups.push({ key: "used", label: t("file.usedIn"), items: usedIn.map((x) => ({ item: x.item, note: x.note })) });
  if (from.length) groups.push({ key: "linked", label: t("item.linkedFrom"), items: from.map((x) => ({ item: x, note: isInInbox(x, ix) ? undefined : where(x), tools: <PlaceHere target={x} page={item} /> })) });
  const textLinks = ix.textLinks(item);
  const fromText = textLinks.filter((l) => !l.embed).map((l) => l.to);
  const embedded = textLinks.filter((l) => l.embed).map((l) => l.to);
  const toIds = [...new Set([...fromText, ...embedded, ...item.refs])].filter((x) => ix.get(x) && !ix.get(x)!.deleted && x !== item.id);
  if (toIds.length)
    groups.push({
      key: "to",
      label: t("links.to"),
      items: toIds.map((x) => ({
        item: ix.get(x)!,
        note: fromText.includes(x) ? t("item.inText") : embedded.includes(x) ? t("refs.embedded") : undefined,
        tools: (
          <>
            <PlaceHere target={ix.get(x)!} page={item} />
            {fromText.includes(x) || embedded.includes(x) ? (
              // a link in the text shows in the head too once pinned
              item.refs.includes(x) ? (
                <IconButton size="xs" icon={PinOff} iconSize={12} onClick={() => repo.setMember(item.id, "refs", x, false)} className="text-muted-foreground" label={t("links.unpin")} />
              ) : (
                <IconButton size="xs" icon={Pin} iconSize={12} onClick={() => repo.setMember(item.id, "refs", x, true)} className={cn("text-faint", REVEAL.any)} label={t("links.pin")} />
              )
            ) : (
              <IconButton size="xs" icon={X} iconSize={12} onClick={() => repo.setMember(item.id, "refs", x, false)} className={cn("text-faint", REVEAL.any)} label={t("item.removeRef")} />
            )}
          </>
        ),
      })),
    });
  return groups;
}

/** The link button in the page head: the number of all links, both ways; a click lists them. None, no button. */
export function LinksMenu({ item, usedIn = [] }: { item: Item; usedIn?: { item: Item; note?: string }[] }) {
  const ix = useIndex();
  const { t } = useT();
  const groups = linkGroups(item, ix, t, usedIn);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  if (!count) return null;
  return (
    <Popover
      align="right"
      trigger={(p) => (
        <Tip label={t("links.title")}>
          <Button variant="plain" {...p} aria-label={t("links.count", { count })} className="tap inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-[13px] tabular-nums text-muted-foreground transition-colors hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg">
            <Link2 size={16} /> {count}
          </Button>
        </Tip>
      )}
    >
      {(close) => (
        <div className="w-80 max-w-[calc(100vw-2rem)]">
          {groups.map((g, i) => (
            <div key={g.key} className={cn(i > 0 && "mt-1 border-t border-line pt-1")}>
              <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-muted-foreground">
                {g.label} <span className="font-normal tabular-nums">{g.items.length}</span>
              </p>
              {g.items.map(({ item: x, note, tools }) => (
                <div key={x.id} className="group flex min-h-9 items-center gap-2 rounded-lg px-2.5 hover:bg-hover">
                  <ItemIcon item={x} size={14} className="shrink-0" />
                  <a href={itemHref(x.id)} onClick={close} className="min-w-0 flex-1 truncate py-1 text-sm text-fg">
                    {titleOf(x, t)}
                  </a>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {note}
                    {tools}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

function PlaceHere({ target, page }: { target: Item; page: Item }) {
  const ix = useIndex();
  const { t } = useT();
  if (!isInInbox(target, ix) || hasPlace(target, ix) || target.type === META_TYPE || ix.wouldCycle(target.id, page.id)) return null;
  return (
    <Button variant="plain" onClick={(e) => (e.preventDefault(), repo.addParent(target.id, page.id))} className="tap-y rounded-md px-1.5 py-0.5 text-xs text-link hover:bg-hover">
      {t("links.placeHere")}
    </Button>
  );
}

/** The refs shown in the head: set by hand, or links from the text that were pinned. */
export function pinnedRefs(item: Item, ix: Index): Item[] {
  return item.refs.map((id) => ix.get(id)).filter((x): x is Item => !!x && !x.deleted && x.id !== item.id);
}

/** "+" for another ref, with the item picker. `text` names it ("+ Ref"), for where no chip says what it adds. */
function AddRef({ item, text }: { item: Item; text?: boolean }) {
  const { t } = useT();
  const [picking, setPicking] = useState(false);
  if (item.deleted) return null;
  return (
    <>
      <Tip label={t("item.addRef")}>
        <Button
          variant="plain"
          onClick={() => setPicking(true)}
          aria-label={t("item.addRef")}
          className={cn("tap inline-flex items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-fg", text ? "h-6 gap-0.5 px-1 text-xs" : "justify-center p-1")}
        >
          <Plus size={text ? 12 : 14} className="shrink-0" />
          {text && <span className="px-1">{t("links.ref")}</span>}
        </Button>
      </Tip>
      {picking && (
        <ItemPicker
          title={t("item.addRef")}
          exclude={(x) => x.id === item.id || item.refs.includes(x.id)}
          onPick={(x) => (repo.setMember(item.id, "refs", x, true), setPicking(false))}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

/** Without pinned refs, the links go after the tags: the link button (if anything is linked), then "+ Ref". */
export function LinksInline({ item }: { item: Item }) {
  return (
    <>
      <LinksMenu item={item} />
      <AddRef item={item} text />
    </>
  );
}

/**
 * With pinned refs, a row of its own under type and tags: the link button first, then the refs as
 * chips, then "+" for another one.
 */
export function LinksRow({ item }: { item: Item }) {
  const ix = useIndex();
  const { t } = useT();
  const inText = new Set(ix.textLinks(item).map((l) => l.to));
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <LinksMenu item={item} />
      {pinnedRefs(item, ix).map((x) => (
        <span key={x.id} className="group inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-1.5 pr-0.5 text-[13px]">
          <ItemLink item={x} className="min-w-0" />
          <IconButton
            size="xs"
            icon={X}
            iconSize={11}
            onClick={() => repo.setMember(item.id, "refs", x.id, false)}
            className={cn("text-muted-foreground", REVEAL.any)}
            label={inText.has(x.id) ? t("links.unpin") : t("item.removeRef")}
          />
        </span>
      ))}
      <AddRef item={item} />
    </div>
  );
}

export function PageFooter({ item }: { item: Item }) {
  const { t, lang } = useT();
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      {t("item.edited")} <RelTime ts={item.updated} /> · {t("page.createdOn", { date: fmtDate(lang, dateOf(item.created), { day: "numeric", month: "long", year: "numeric" }) })}
    </p>
  );
}
