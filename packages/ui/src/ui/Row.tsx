import { useSyncExternalStore } from "react";
import type { Item } from "@obtion/core/model";
import { tr } from "../i18n";
import { confirmAction, notify } from "./feedback";
import { dueOf, firstOfGroup, isDone, primaryChild, statusOf, statusProp } from "@obtion/core/traits";
import { fmtBytes } from "@obtion/core/i18n";
import type { Repo } from "@obtion/sync";
import { repo as current } from "../repo";
import { itemHref, useRepo } from "../hooks";
import { useT } from "../i18n";
import { DueLabel, ItemIcon, MenuItem, Popover, StatusGlyph, StatusPill, cx, pal, ProgressCount } from "./bits";
import { statusShape } from "@obtion/core/input";

/** Status choice as a small menu (rows of projects; the ring there does not tick off). */
export function StatusMenu({ item, trigger }: { item: Item; trigger: (p: { onClick: () => void; "aria-expanded": boolean }) => React.ReactNode }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const schema = ix.schemaOf(item);
  const sp = statusProp(schema);
  const cur = sp ? item.props[sp.id] : undefined;
  return (
    <Popover trigger={trigger}>
      {(close) =>
        (["todo", "active", "done"] as const).map((g) => (
          <div key={g}>
            <p className="px-2.5 pb-0.5 pt-1.5 text-xs text-muted">{t("group." + g)}</p>
            {(sp?.options ?? [])
              .filter((o) => (o.group ?? "todo") === g)
              .map((o) => (
                <MenuItem key={o.id} active={o.id === cur} icon={<StatusGlyph option={o} size={14} />} onClick={() => (close(), void setStatus(item, o.id, repo))}>
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
export function openBelow(item: Item, repo: Repo = current): Item[] {
  const ix = repo.index();
  return [...ix.descendants(item.id)].map((d) => ix.get(d)!).filter((x) => {
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
  const sp = statusProp(schema);
  const opt = sp?.options?.find((o) => o.id === optionId);
  if (!sp || !opt) return false;
  const before = item.props[sp.id];
  const closing = (opt.group ?? "todo") === "done" && !isDone(item, schema);
  if (closing) {
    const open = openBelow(item, repo);
    if (open.length) {
      const ok = await confirmAction({
        title: tr("tick.openTitle", { title: item.title || tr("untitled") }),
        body: tr("tick.openBody", { count: open.length, titles: open.slice(0, 3).map((x) => `„${x.title}“`).join(", ") }),
        yes: tr("tick.closeAnyway", { name: opt.name }),
      });
      if (!ok) return false;
    }
  }
  repo.setProp(item.id, sp.id, optionId);
  if (closing) notify(tr("tick.done", { title: item.title || tr("untitled"), name: opt.name }), () => repo.setProp(item.id, sp.id, (before as string) ?? null));
  return true;
}

// Ticked entries stay visible, struck through, for a moment before they leave the list.
const lingering = new Map<string, ReturnType<typeof setTimeout>>();
const lingerListeners = new Set<() => void>();
let lingerVersion = 0;
const lingerEmit = () => (lingerVersion++, lingerListeners.forEach((l) => l()));
function useLingering(id: string) {
  useSyncExternalStore(
    (l) => (lingerListeners.add(l), () => void lingerListeners.delete(l)),
    () => lingerVersion,
  );
  return lingering.has(id);
}
addEventListener("beforeunload", () => {
  for (const [, t] of lingering) clearTimeout(t);
});

/**
 * The ring in a list: ticks a task off (or reopens it). Entries with open entries below ask
 * first. The write waits a moment so the row can be seen struck through.
 */
export function tick(item: Item, repo: Repo = current) {
  const ix = repo.index();
  const schema = ix.schemaOf(item);
  const sp = statusProp(schema);
  if (!sp) return;
  const next = isDone(item, schema) ? firstOfGroup(schema, "todo") : firstOfGroup(schema, "done");
  if (!next) return;
  if (isDone(item, schema) || openBelow(item, repo).length) return void setStatus(item, next.id, repo);
  if (lingering.has(item.id)) return;
  lingering.set(
    item.id,
    setTimeout(() => {
      lingering.delete(item.id);
      void setStatus(repo.get(item.id) ?? item, next.id, repo);
      lingerEmit();
    }, 900),
  );
  lingerEmit();
}

/**
 * A group in a list (by path, status, type …): a quiet heading with its count, then the rows.
 * The same in query blocks, task lists and note lists.
 */
export function Group({ heading, count, first, children }: { heading?: React.ReactNode; count?: number; first?: boolean; children: React.ReactNode }) {
  return (
    <div className={first ? undefined : "mt-2"}>
      {heading !== undefined && (
        <p className="truncate px-2 pb-1 pt-2 text-xs font-semibold text-muted">
          {heading}
          {count !== undefined && ` · ${count}`}
        </p>
      )}
      {children}
    </div>
  );
}

export function pathLabel(ids: string[], repo: Repo = current) {
  const ix = repo.index();
  return ids.map((id) => ix.get(id)?.title ?? "").join(" › ");
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
  compact,
  right,
  note,
}: {
  item: Item;
  path?: string[]; // ancestors to show under the title
  sub?: boolean | number; // indent as sub-item (or depth)
  compact?: boolean;
  right?: React.ReactNode;
  note?: React.ReactNode; // a second line, e.g. a project's next task
}) {
  const { t, lang } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const schema = ix.schemaOf(item);
  const st = statusOf(item, schema);
  const ticked = useLingering(item.id);
  const done = st?.group === "done" || ticked;
  const due = dueOf(item, schema);
  const prog = ix.progressOf(item);
  const blocked = !!st && !done && ix.isBlocked(item);
  return (
    <div
      data-id={item.id}
      className={cx("tap-row group flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-hover max-md:min-h-[52px]", !!sub && "pl-[calc(8px+var(--depth)*24px)] max-sm:pl-[calc(8px+var(--depth)*14px)]")}
      style={sub ? ({ "--depth": sub === true ? 1 : sub } as React.CSSProperties) : undefined}
    >
      <RowStatus item={item} />
      <a href={itemHref(item.id)} className="flex min-w-0 flex-1 flex-col justify-center self-stretch">
        {/* on a phone the title may take two lines: its telling part is often at the end */}
        <span className={cx("block text-sm max-md:text-[15px] max-sm:line-clamp-2 sm:truncate", done && "text-muted line-through")}>{item.title || t("untitled")}</span>
        {path && path.length > 0 && (
          <span className="block truncate text-xs text-muted" title={pathLabel(path)}>
            {shortPath(path)}
          </span>
        )}
        {note && <span className="block truncate text-xs text-muted">{note}</span>}
      </a>
      {right}
      {/* the shape tells the status; words only for what deviates */}
      {blocked && <span className="shrink-0 text-xs text-warn">{t("row.blocked")}</span>}
      {st && !done && statusShape(st.option) === "paused" && <StatusPill option={st.option} group={st.group} small />}
      {prog && prog.total > 0 && (
        <ProgressCount done={prog.done} total={prog.total} className="w-10 shrink-0 text-right text-xs text-muted" />
      )}
      {due && <DueLabel due={due} done={done} />}
      {item.file && <span className="shrink-0 text-xs text-muted">{fmtBytes(lang, item.file.size)}</span>}
    </div>
  );
}

/**
 * The status shape at the start of a row: a click ticks a task off (and back); containers
 * (their "+" creates another type, e.g. a project's tasks) open the status menu instead.
 * Without a status: the entry's icon.
 */
export function RowStatus({ item, size = 17 }: { item: Item; size?: number }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const schema = ix.schemaOf(item);
  const st = statusOf(item, schema);
  const ticked = useLingering(item.id);
  const done = st?.group === "done" || ticked;
  if (!st) return <ItemIcon item={item} size={size - 1} />;
  const pc = primaryChild(schema);
  const viaMenu = !!pc && pc !== item.type;
  // the shape in the option's colour (as on its pill): open grey, running amber, done green …
  const opt = ticked ? (firstOfGroup(schema, "done") ?? st.option) : st.option;
  const glyph = <span style={{ color: done ? "var(--ok)" : opt.color && opt.color !== "gray" ? pal(opt.color) : undefined }}><StatusGlyph option={opt} size={size} /></span>;
  return viaMenu ? (
    <StatusMenu item={item} trigger={(p) => (
      <button {...p} className="tap-edge shrink-0 text-muted hover:text-fg" aria-label={t("row.status", { name: st.option.name })} title={st.option.name}>
        {glyph}
      </button>
    )} />
  ) : (
    <button onClick={() => tick(item, repo)} className="tap-edge shrink-0 text-muted hover:text-ok" aria-label={done ? t("row.reopen") : t("row.done")} title={done ? t("row.reopen") : t("row.done")}>
      {glyph}
    </button>
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
