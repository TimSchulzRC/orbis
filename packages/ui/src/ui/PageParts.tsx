// Parts every page shares (design rules § 3.1): the path line on top, the card of connections
// ("Bezüge") and the quiet footer. Information pages and file pages use the same ones.
import { useEffect, useState } from "react";
import { ChevronRight, MoreHorizontal, Pin, Star, X } from "lucide-react";
import { type Item, META_TYPE } from "@obtion/core/model";
import { canPlaceIn, hasPlace, isInInbox } from "@obtion/core/placement";
import { fmtDate } from "@obtion/core/i18n";
import { repo } from "../repo";
import { itemHref, useIndex, useMediaQuery } from "../hooks";
import { useT, titleOf } from "../i18n";
import { ItemIcon, RelTime } from "./item-look";
import { Button, MenuItem, Popover, SectionTitle } from "./primitives";
import { cn } from "../lib/utils";
import { ItemPicker } from "./Picker";
import { placeSuggestions } from "./suggest";
import { rememberPlace } from "../actions";
import { dateOf } from "@obtion/core/date";

/** Remember per device whether a row of a page is open (folding is a view, not a change of the page). */
function useOpen(key: string, initial: boolean): [boolean, (o: boolean) => void] {
  const k = `obtion.open.${key}`;
  const [open, setOpenState] = useState(() => {
    const v = localStorage.getItem(k);
    return v === null ? initial : v === "1";
  });
  return [open, (o) => (localStorage.setItem(k, o ? "1" : "0"), setOpenState(o))];
}

// ---------- path line ----------

/**
 * The line above the title: the home path (13 muted, chevrons faint), on a phone "… › last".
 * Without a place: the list of its type ("Karten"), "Angeheftet" for a pinned top entry,
 * "Eingang" with "Einordnen" in the inbox. More places: "+1" opens them in "Bezüge".
 */
export function Crumbs({ item, tools, onPlaces, onPlace }: { item: Item; tools: React.ReactNode; onPlaces: () => void; onPlace: () => void }) {
  const ix = useIndex();
  const { t } = useT();
  const narrow = useMediaQuery("(max-width: 767px)");
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
        {others > 0 && (
          <Button variant="plain" onClick={onPlaces} className="tap-y ml-1 shrink-0 whitespace-nowrap rounded-full border border-line px-1.5 text-xs hover:text-fg" title={t("refs.places")}>
            +{others}
          </Button>
        )}
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
  } else {
    // the list of its type ("Karten", "Bücher")
    if (item.type && ix.types.has(item.type))
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

/** Choosing a place for an entry (from the path line, the page menu or "Orte"). */
export function PlacePicker({ item, onClose }: { item: Item; onClose: () => void }) {
  const ix = useIndex();
  const { t } = useT();
  return (
    <ItemPicker
      title={t("place.add")}
      suggestions={placeSuggestions(item)}
      exclude={(x) => !canPlaceIn(item, x, ix)}
      onPick={(pid) => {
        repo.addParent(item.id, pid);
        rememberPlace(pid);
        onClose();
      }}
      onCreate={(title) => {
        const pid = repo.create({ title });
        repo.addParent(item.id, pid);
        onClose();
      }}
      onClose={onClose}
    />
  );
}

// ---------- Bezüge ----------

interface RefKind {
  key: string;
  label: string;
  items: { item: Item; note?: React.ReactNode; tools?: React.ReactNode }[];
}

/**
 * "Bezüge" (design rules § 2.7): one card, a row per kind – "Verlinkt von", "Refs", "Orte" (only
 * with more than one place), "Verwendet in" (files). Closed they show the count and the first
 * titles; open a list. Open by default only where the page has no list of its own and the kind has
 * at most five entries. Kinds without entries are left out; without any, the card is gone.
 */
export function Bezuege({ item, typeArea, usedIn, placesOpen }: { item: Item; typeArea: boolean; usedIn?: { item: Item; note?: string }[]; placesOpen?: number }) {
  const ix = useIndex();
  const { t } = useT();
  const kinds: RefKind[] = [];
  const seen = new Set<string>();
  const from = ix
    .backlinks(item.id)
    .filter((b) => b.kind !== "rel" && (seen.has(b.from) ? false : (seen.add(b.from), true)))
    .map((b) => ix.get(b.from)!)
    .filter((x) => x && x.kind === "info" && !x.deleted && x.type !== META_TYPE && !(usedIn ?? []).some((u) => u.item.id === x.id));
  const where = (x: Item) => {
    const p = ix.homePath(x.id);
    return p.length ? <span className="truncate">{ix.get(p.at(-1)!)?.title}</span> : undefined;
  };
  if (usedIn?.length) kinds.push({ key: "used", label: t("file.usedIn"), items: usedIn.map((x) => ({ item: x.item, note: x.note })) });
  if (from.length) kinds.push({ key: "linked", label: t("item.linkedFrom"), items: from.map((x) => ({ item: x, note: isInInbox(x, ix) ? undefined : where(x), tools: <PlaceHere target={x} page={item} /> })) });
  const fromText = ix.textLinks(item).filter((l) => !l.embed).map((l) => l.to);
  const embedded = ix.textLinks(item).filter((l) => l.embed).map((l) => l.to);
  const refIds = [...new Set([...fromText, ...item.refs])].filter((x) => ix.get(x) && x !== item.id);
  if (refIds.length)
    kinds.push({
      key: "refs",
      label: t("item.refs"),
      items: refIds.map((x) => ({
        item: ix.get(x)!,
        note: fromText.includes(x) ? t("item.inText") : embedded.includes(x) ? t("refs.embedded") : undefined,
        tools: (
          <>
            <PlaceHere target={ix.get(x)!} page={item} />
            {!fromText.includes(x) && (
              <Button variant="plain" onClick={(e) => (e.preventDefault(), repo.setMember(item.id, "refs", x, false))} className="tap rounded p-0.5 text-faint opacity-0 pointer-coarse:opacity-100 hover:bg-hover hover:text-fg group-hover:opacity-100 focus:opacity-100" aria-label={t("item.removeRef")}>
                <X size={12} />
              </Button>
            )}
          </>
        ),
      })),
    });
  const parents = ix.parentsOf(item.id);
  const home = ix.home(item.id);
  if (parents.length > 1)
    kinds.push({
      key: "places",
      label: t("refs.places"),
      items: [...parents]
        .sort((a, b) => (a === home ? -1 : b === home ? 1 : 0))
        .map((p) => ({
          item: ix.get(p)!,
          note: p === home ? <span className="flex items-center gap-1"><Star size={11} aria-hidden /> {t("place.home")}</span> : undefined,
          tools: (
            <Popover
              align="right"
              trigger={(pp) => (
                <Button variant="plain" {...pp} onClickCapture={(e) => e.preventDefault()} className="tap rounded p-0.5 text-faint opacity-0 pointer-coarse:opacity-100 hover:bg-hover group-hover:opacity-100 focus:opacity-100" aria-label={t("more")}>
                  <MoreHorizontal size={13} />
                </Button>
              )}
            >
              {(close) => (
                <>
                  {p !== home && <MenuItem onClick={() => (close(), repo.setHome(item.id, p))}>{t("place.makeHome")}</MenuItem>}
                  <MenuItem onClick={() => (close(), repo.removeParent(item.id, p))}>{t("place.removeHere")}</MenuItem>
                </>
              )}
            </Popover>
          ),
        })),
    });
  if (!kinds.length) return <PageFooter item={item} />;
  return (
    <section className="mt-10 max-md:mt-8">
      <SectionTitle>{t("refs.title")}</SectionTitle>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {kinds.map((k) => (
          <RefRow key={k.key} page={item} kind={k} initial={!typeArea && k.items.length <= 5} force={k.key === "places" ? placesOpen : undefined} />
        ))}
      </div>
      <PageFooter item={item} />
    </section>
  );
}

function RefRow({ page, kind, initial, force }: { page: Item; kind: RefKind; initial: boolean; force?: number }) {
  const { t } = useT();
  const [open, setOpen] = useOpen(`refs:${page.id}:${kind.key}`, initial);
  // "+1" in the path line opens the places
  useEffect(() => {
    if (force) (setOpen(true), document.getElementById(`refs-${kind.key}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [force]);
  return (
    <div className="border-t border-line first:border-t-0" id={`refs-${kind.key}`}>
      <Button variant="plain" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-11 w-full items-center gap-2.5 px-3.5 text-left hover:bg-hover max-md:min-h-12">
        <ChevronRight size={13} className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")} aria-hidden />
        <span className="whitespace-nowrap text-sm font-medium">{kind.label}</span>
        <span className="text-[13px] tabular-nums text-muted-foreground">{kind.items.length}</span>
        {!open && <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{kind.items.map((x) => titleOf(x.item, t)).join(", ")}</span>}
      </Button>
      {open && (
        <ul className="pb-2.5 pl-10 pr-3.5">
          {kind.items.map(({ item: x, note, tools }) => (
            <li key={x.id} className="group relative flex min-h-8 items-center gap-2 text-sm">
              <ItemIcon item={x} size={14} className="shrink-0" />
              <a href={itemHref(x.id)} className="min-w-0 truncate hover:underline">
                {titleOf(x, t)}
              </a>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                {note}
                {tools}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A linked entry that waits in the inbox can be put below this page with one click. */
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

/** "Geändert vor 2 Std. · erstellt am 1. März 2026" – the last line of a page. */
function PageFooter({ item }: { item: Item }) {
  const { t, lang } = useT();
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      {t("item.edited")} <RelTime ts={item.updated} /> · {t("page.createdOn", { date: fmtDate(lang, dateOf(item.created), { day: "numeric", month: "long", year: "numeric" }) })}
    </p>
  );
}
