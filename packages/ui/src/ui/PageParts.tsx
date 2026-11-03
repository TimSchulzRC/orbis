// Parts every page shares, information and file pages alike (design rules § 3.1).
import { ChevronRight, Pin, Plus, RotateCcw, Star, X } from "lucide-react";
import { type Item, META_TYPE } from "@obtion/core/model";
import { hasPlace, isInInbox } from "@obtion/core/placement";
import { fmtDate } from "@obtion/core/i18n";
import { repo } from "../repo";
import { itemHref, useIndex, useLocalStorage, usePhone } from "../hooks";
import { useT, titleOf } from "../i18n";
import { ItemIcon, RelTime } from "./item-look";
import { Card, Button, IconButton, MenuItem, MoreMenu, Popover, REVEAL, SectionTitle } from "./primitives";
import { cn } from "../lib/utils";
import { dateOf } from "@obtion/core/date";
import { KEYS } from "./storage";

/** Per device, because folding is a view, not a change of the page. */
function useOpen(key: string, initial: boolean): [boolean, (o: boolean) => void] {
  const [open, setOpen] = useLocalStorage(KEYS.open(key), initial);
  // stored as "1"/"0" by older versions
  return [!!open, setOpen];
}

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

interface RefKind {
  key: string;
  label: string;
  items: { item: Item; note?: React.ReactNode; tools?: React.ReactNode }[];
}

/** Rows open by default only on pages without a list of their own (design rules § 2.7). */
const OPEN_REFS_MAX = 5;

/** Design rules § 2.7. */
export function Bezuege({ item, typeArea, usedIn }: { item: Item; typeArea: boolean; usedIn?: { item: Item; note?: string }[] }) {
  const ix = useIndex();
  const { t } = useT();
  const kinds: RefKind[] = [];
  const linkingIds = new Set(ix.backlinks(item.id).filter((b) => b.kind !== "rel").map((b) => b.from));
  const from = [...linkingIds]
    .map((id) => ix.get(id)!)
    .filter((x) => x && x.kind === "info" && !x.deleted && x.type !== META_TYPE && !(usedIn ?? []).some((u) => u.item.id === x.id));
  const where = (x: Item) => {
    const homePath = ix.homePath(x.id);
    return homePath.length ? <span className="truncate">{ix.get(homePath.at(-1)!)?.title}</span> : undefined;
  };
  if (usedIn?.length) kinds.push({ key: "used", label: t("file.usedIn"), items: usedIn.map((x) => ({ item: x.item, note: x.note })) });
  if (from.length) kinds.push({ key: "linked", label: t("item.linkedFrom"), items: from.map((x) => ({ item: x, note: isInInbox(x, ix) ? undefined : where(x), tools: <PlaceHere target={x} page={item} /> })) });
  const textLinks = ix.textLinks(item);
  const fromText = textLinks.filter((l) => !l.embed).map((l) => l.to);
  const embedded = textLinks.filter((l) => l.embed).map((l) => l.to);
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
              <IconButton size="xs" icon={X} iconSize={12} onClick={(e) => (e.preventDefault(), repo.setMember(item.id, "refs", x, false))} className={cn("text-faint", REVEAL.any)} label={t("item.removeRef")} />
            )}
          </>
        ),
      })),
    });
  if (!kinds.length) return <PageFooter item={item} />;
  return (
    <section className="mt-10 max-md:mt-8">
      <SectionTitle>{t("refs.title")}</SectionTitle>
      <Card className="overflow-hidden">
        {kinds.map((k) => (
          <RefRow key={k.key} page={item} kind={k} initial={!typeArea && k.items.length <= OPEN_REFS_MAX} />
        ))}
      </Card>
      <PageFooter item={item} />
    </section>
  );
}

function RefRow({ page, kind, initial }: { page: Item; kind: RefKind; initial: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useOpen(`refs:${page.id}:${kind.key}`, initial);
  return (
    <div className="border-t border-line first:border-t-0">
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

function PageFooter({ item }: { item: Item }) {
  const { t, lang } = useT();
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      {t("item.edited")} <RelTime ts={item.updated} /> · {t("page.createdOn", { date: fmtDate(lang, dateOf(item.created), { day: "numeric", month: "long", year: "numeric" }) })}
    </p>
  );
}
