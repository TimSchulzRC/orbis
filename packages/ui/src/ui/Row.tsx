import { type Item, STATUS_GROUPS } from "@obtion/core/model";
import { confirmAction, notify } from "./feedback";
import { dueOf, firstOfGroup, isDone, statusOf, statusProp } from "@obtion/core/traits";
import { fmtBytes } from "@obtion/core/i18n";
import type { Repo } from "@obtion/sync";
import { repo as current } from "../repo";
import { useItemHref, useRepo } from "../hooks";
import { tr, useT, titleOf } from "../i18n";
import { DueLabel, ItemIcon, StatusGlyph, StatusPill, pal } from "./item-look";
import { Button, MenuItem, Popover } from "./primitives";
import { cn } from "../lib/utils";
import { createStore } from "../lib/store";
import { ProgressCount } from "./progress";
import { statusShape } from "@obtion/core/input";

/** Status choice as a small menu (rows of projects; the ring there does not tick off). */
export function StatusMenu({ item, trigger }: { item: Item; trigger: (p: { onClick: () => void; "aria-expanded": boolean }) => React.ReactNode }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const schema = ix.schemaOf(item);
  const statusProperty = statusProp(schema);
  const selected = statusProperty ? item.props[statusProperty.id] : undefined;
  return (
    <Popover trigger={trigger}>
      {(close) =>
        STATUS_GROUPS.map((g) => (
          <div key={g}>
            <p className="px-2.5 pb-0.5 pt-1.5 text-xs text-muted-foreground">{t("group." + g)}</p>
            {(statusProperty?.options ?? [])
              .filter((o) => (o.group ?? "todo") === g)
              .map((o) => (
                <MenuItem key={o.id} active={o.id === selected} icon={<StatusGlyph option={o} size={14} />} onClick={() => (close(), void setStatus(item, o.id, repo))}>
                  {o.name}
                </MenuItem>
              ))}
          </div>
        ))
      }
    </Popover>
  );
}

/** Open entries with a status somewhere below (they would stay open if this is closed). */
function openBelow(item: Item, repo: Repo = current): Item[] {
  const ix = repo.index();
  return ix.items(ix.descendants(item.id)).filter((x) => {
    const s = statusOf(x, ix.schemaOf(x));
    return !!s && s.group !== "done";
  });
}

/**
 * Set a status the careful way: closing something with open entries below asks first, and
 * closing says "Erledigt · Rückgängig". Returns false if the user said no.
 */
export async function setStatus(item: Item, optionId: string, repo: Repo = current): Promise<boolean> {
  const ix = repo.index();
  const schema = ix.schemaOf(item);
  const statusProperty = statusProp(schema);
  const option = statusProperty?.options?.find((o) => o.id === optionId);
  if (!statusProperty || !option) return false;
  const before = item.props[statusProperty.id];
  const closing = (option.group ?? "todo") === "done" && !isDone(item, schema);
  if (closing) {
    const open = openBelow(item, repo);
    if (open.length) {
      const ok = await confirmAction({
        title: tr("tick.openTitle", { title: titleOf(item) }),
        body: tr("tick.openBody", { count: open.length, titles: open.slice(0, 3).map((x) => `„${x.title}“`).join(", ") }),
        yes: tr("tick.closeAnyway", { name: option.name }),
      });
      if (!ok) return false;
    }
  }
  repo.setProp(item.id, statusProperty.id, optionId);
  if (closing) notify.undo(tr("tick.done", { title: titleOf(item), name: option.name }), () => repo.setProp(item.id, statusProperty.id, (before as string) ?? null));
  return true;
}

// Ticked entries stay visible, struck through, for a moment before they leave the list.
const LINGER = 900;
const lingering = new Map<string, ReturnType<typeof setTimeout>>();
const lingerVersion = createStore(0);
const lingerEmit = () => lingerVersion.set(lingerVersion.get() + 1);
function useLingering(id: string) {
  lingerVersion.use();
  return lingering.has(id);
}

/** The write waits a moment so the row can be seen struck through. */
export function tick(item: Item, repo: Repo = current) {
  const ix = repo.index();
  const schema = ix.schemaOf(item);
  if (!statusProp(schema)) return;
  const reopening = isDone(item, schema);
  const next = firstOfGroup(schema, reopening ? "todo" : "done");
  if (!next) return;
  if (reopening || openBelow(item, repo).length) return void setStatus(item, next.id, repo);
  if (lingering.has(item.id)) return;
  lingering.set(
    item.id,
    setTimeout(() => {
      lingering.delete(item.id);
      void setStatus(repo.get(item.id) ?? item, next.id, repo);
      lingerEmit();
    }, LINGER),
  );
  lingerEmit();
}

export function Group({ heading, count, first, children }: { heading?: React.ReactNode; count?: number; first?: boolean; children: React.ReactNode }) {
  return (
    <div className={first ? undefined : "mt-2"}>
      {heading !== undefined && (
        <p className="truncate px-2 pb-1 pt-2 text-xs font-semibold text-muted-foreground">
          {heading}
          {count !== undefined && ` · ${count}`}
        </p>
      )}
      {children}
    </div>
  );
}

export function pathLabel(ids: string[], repo: Repo = current) {
  return repo.index().pathText(ids);
}

/** Where an entry lives, short: the last two places of its home path ("… › Frankreich › Nordlicht"). */
export function shortPath(ids: string[], keep = 2, repo: Repo = current): string {
  const label = pathLabel(ids.slice(-keep), repo);
  return ids.length > keep ? "… › " + label : label;
}

export function ItemRow({
  item,
  path,
  sub,
  note,
}: {
  item: Item;
  path?: string[]; // ancestors to show under the title
  sub?: number; // depth as sub-item
  note?: React.ReactNode; // a second line, e.g. a project's next task
}) {
  const { t, lang } = useT();
  const repo = useRepo();
  const hrefOf = useItemHref();
  const ix = repo.index();
  const schema = ix.schemaOf(item);
  const status = statusOf(item, schema);
  const ticked = useLingering(item.id);
  const done = status?.group === "done" || ticked;
  const due = dueOf(item, schema);
  const progress = ix.progressOf(item);
  const blocked = !!status && !done && ix.isBlocked(item);
  return (
    <div
      data-id={item.id}
      className={cn("tap-row group flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-hover max-md:min-h-[52px]", !!sub && "pl-[calc(8px+var(--depth)*24px)] max-sm:pl-[calc(8px+var(--depth)*14px)]")}
      style={sub ? ({ "--depth": sub } as React.CSSProperties) : undefined}
    >
      <RowStatus item={item} />
      <a href={hrefOf(item.id)} className="flex min-w-0 flex-1 flex-col justify-center self-stretch">
        {/* on a phone the title may take two lines: its telling part is often at the end */}
        <span className={cn("block text-sm max-md:text-[15px] max-sm:line-clamp-2 sm:truncate", done && "text-muted-foreground line-through")}>{titleOf(item, t)}</span>
        {path && path.length > 0 && (
          <span className="block truncate text-xs text-muted-foreground" title={pathLabel(path)}>
            {shortPath(path)}
          </span>
        )}
        {note && <span className="block truncate text-xs text-muted-foreground">{note}</span>}
      </a>
      {/* the shape tells the status; words only for what deviates */}
      {blocked && <span className="shrink-0 text-xs text-warn">{t("row.blocked")}</span>}
      {status && !done && statusShape(status.option) === "paused" && <StatusPill option={status.option} group={status.group} small />}
      {progress && progress.total > 0 && (
        <ProgressCount done={progress.done} total={progress.total} className="w-10 shrink-0 text-right text-xs text-muted-foreground" />
      )}
      {due && <DueLabel due={due} done={done} />}
      {item.file && <span className="shrink-0 text-xs text-muted-foreground">{fmtBytes(lang, item.file.size)}</span>}
    </div>
  );
}

/** A click ticks the entry off (and back), whatever its type; the type's icon follows. Without a status only the icon. */
export function RowStatus({ item, size = 17 }: { item: Item; size?: number }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const schema = ix.schemaOf(item);
  const st = statusOf(item, schema);
  const ticked = useLingering(item.id);
  const done = st?.group === "done" || ticked;
  if (!st) return <ItemIcon item={item} size={size - 1} />;
  // the shape in the option's colour (as on its pill): open grey, running amber, done green …
  const option = ticked ? (firstOfGroup(schema, "done") ?? st.option) : st.option;
  const color = done ? "var(--ok)" : option.color && option.color !== "gray" ? pal(option.color) : undefined;
  const glyph = <span style={{ color }}><StatusGlyph option={option} size={size} /></span>;
  // every entry with a status is ticked off here; other options are set on its page. The type's
  // icon follows, so a project and a task look different
  return (
    <>
      <Button variant="plain" onClick={() => tick(item, repo)} className="tap-edge shrink-0 text-muted-foreground hover:text-ok" aria-label={done ? t("row.reopen") : t("row.done")} title={done ? t("row.reopen") : t("row.done")}>
        {glyph}
      </Button>
      <ItemIcon item={item} size={size - 3} />
    </>
  );
}

/** Keep the given order, but put sub-items right after their listed parent (any depth). */
export function treeOrder(items: Item[], repo: Repo = current): { item: Item; depth: number }[] {
  const ix = repo.index();
  const ids = new Set(items.map((i) => i.id));
  const parentOf = (i: Item) => ix.parentsOf(i.id).find((p) => ids.has(p));
  const kids = new Map<string, Item[]>();
  const roots: Item[] = [];
  for (const i of items) {
    const p = parentOf(i);
    if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(i);
    else roots.push(i);
  }
  const out: { item: Item; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (i: Item, depth: number) => {
    if (seen.has(i.id)) return;
    seen.add(i.id);
    out.push({ item: i, depth });
    for (const k of kids.get(i.id) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const i of items) walk(i, 0); // cycles or parents outside: never lose an item
  return out;
}
