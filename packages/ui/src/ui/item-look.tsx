import { Badge } from "../components/ui/badge";
import type { ReactNode } from "react";
import { CircleCheck, CirclePause, CircleX } from "lucide-react";
import { type Item, type OptionDef, type StatusGroup, type TypeSchema, META_TYPE, todayISO } from "@obtion/core/model";
import { type T, fmtRelative, fmtShortDate } from "@obtion/core/i18n";
import { isInInbox, isOverview } from "@obtion/core/placement";
import type { Index } from "@obtion/core/graph";
import { statusShape } from "@obtion/core/input";
import { repo } from "../repo";
import { useIndex, useItemHref } from "../hooks";
import { tr, useT, titleOf } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./primitives";
import { ICON, INBOX_ICON, NOTE_ICON, OVERVIEW_ICON, TYPE_ICON, FILE_ICONS } from "./icons";

export const pal = (color?: string) => `var(--pal-${color ?? "slate"}, var(--pal-slate))`;

/** A chip in colour `c`: the colour mixed into the text, a light wash of it behind. */
export const tint = (c: string) => ({ color: `color-mix(in srgb, ${c} 62%, var(--text))`, background: `color-mix(in srgb, ${c} 12%, transparent)` });

export const GROUP_COLOR: Record<StatusGroup, string> = { todo: "var(--faint)", active: "var(--t-inbox)", done: "var(--ok)" };

/** The colour of a status glyph: green once done, the option's own colour, else none (the text's). */
export const statusColor = (option: OptionDef, done = option.group === "done") =>
  done ? "var(--ok)" : option.color && option.color !== "gray" ? pal(option.color) : undefined;

export interface Look {
  icon: typeof INBOX_ICON;
  color: string;
  /** "schema": an entry of a user type, named `name` */
  kind: "file" | "type" | "inbox" | "overview" | "note" | "schema";
  name?: string;
}

/** Visual identity of an item: its type, or note / inbox / file / type. */
export function itemLook(item: Item, ix: Index = repo.index()): Look {
  if (item.kind === "datei") return { icon: FILE_ICONS[item.file?.filetype ?? "sonstiges"] ?? FILE_ICONS.sonstiges!, color: "var(--t-file)", kind: "file" };
  if (item.schema && item.type === META_TYPE) return { icon: ICON[item.schema.icon] ?? TYPE_ICON, color: pal(item.schema.color), kind: "type" };
  const schema = ix.schemaOf(item);
  if (schema) return { icon: ICON[schema.icon] ?? ICON.circle!, color: pal(schema.color), kind: "schema", name: schema.name };
  if (isInInbox(item, ix)) return { icon: INBOX_ICON, color: "var(--t-inbox)", kind: "inbox" };
  if (isOverview(item, ix)) return { icon: OVERVIEW_ICON, color: "var(--pal-violet)", kind: "overview" };
  return { icon: NOTE_ICON, color: "var(--t-note)", kind: "note" };
}

/** What an entry is, in words: its type's name or "Notiz", "Datei" … `inboxAsNote`: an entry in the inbox is a note too. */
export function kindLabel(look: Look, t: T, opts: { inboxAsNote?: boolean } = {}): string {
  if (look.kind === "schema") return look.name ?? "";
  return t("kind." + (look.kind === "inbox" && opts.inboxAsNote ? "note" : look.kind));
}

/** `ix`: the index of the item's workspace, if it is not the open one (the sidebar shows others). */
export function ItemIcon({ item, size = 16, className, ix }: { item: Item; size?: number; className?: string; ix?: Index }) {
  const { t } = useT();
  const here = useIndex();
  const look = itemLook(item, ix ?? here);
  return <look.icon size={size} style={{ color: look.color }} className={cn("shrink-0", className)} aria-label={kindLabel(look, t)} />;
}

export function TypeGlyph({ schema, size = 16, className }: { schema?: TypeSchema; size?: number; className?: string }) {
  const I = (schema && ICON[schema.icon]) || ICON.circle!;
  return <I size={size} style={{ color: pal(schema?.color) }} className={cn("shrink-0", className)} aria-hidden />;
}

export function TypeChip({ schema, onClick }: { schema: TypeSchema; onClick?: () => void }) {
  const El = onClick ? "button" : "span";
  return (
    <El onClick={onClick} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", onClick && "tap-y")} style={tint(pal(schema.color))}>
      <TypeGlyph schema={schema} size={12} />
      {schema.name}
    </El>
  );
}

/** A status by its shape, so it reads without colour: ring, half circle, pause, check, cross. */
export function StatusGlyph({ option, size = 16, className }: { option: OptionDef; size?: number; className?: string }) {
  const shape = statusShape(option);
  if (shape === "paused") return <CirclePause size={size} className={className} aria-hidden />;
  if (shape === "done") return <CircleCheck size={size} className={className} aria-hidden />;
  if (shape === "dropped") return <CircleX size={size} className={className} aria-hidden />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      {shape === "active" && <path d="M12 6a6 6 0 0 0 0 12z" fill="currentColor" stroke="none" />}
    </svg>
  );
}

export function StatusPill({ option, small, group, label }: { option?: OptionDef; small?: boolean; group?: StatusGroup; label?: ReactNode }) {
  if (!option) return null;
  const c = option.color ? pal(option.color) : GROUP_COLOR[group ?? option.group ?? "todo"];
  // status options have a group and show their shape; plain select options a dot
  const isStatus = !!(group ?? option.group);
  return (
    <Badge className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium", small ? "px-1.5 py-0 text-xs" : "px-2 py-0.5 text-xs")} style={tint(c)}>
      {isStatus ? <StatusGlyph option={{ ...option, group: group ?? option.group }} size={12} /> : <span className="size-1.5 rounded-full" style={{ background: c }} />}
      {label ?? option.name}
    </Badge>
  );
}

export function Tag({ tag, onRemove, href }: { tag: string; onRemove?: () => void; href?: string }) {
  const { t } = useT();
  const inner = (
    <>
      <span className="text-muted-foreground">#</span>
      {tag}
      {onRemove && (
        <Button variant="plain"
          className="-mr-1 ml-0.5 rounded px-1 text-muted-foreground hover:bg-hover hover:text-fg"
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
          aria-label={t("tag.remove", { tag })}
        >
          ×
        </Button>
      )}
    </>
  );
  const cls = "inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-muted-foreground";
  return href ? (
    <a href={href} className={cn(cls, "hover:text-fg")}>
      {inner}
    </a>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

/** A link to an entry. */
export function ItemLink({ item, className }: { item: Item; className?: string }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  return (
    <a href={hrefOf(item.id)} className={cn("inline-flex min-w-0 items-center gap-1.5 hover:underline", className)}>
      <ItemIcon item={item} size={14} />
      <span className="truncate">{titleOf(item, t)}</span>
    </a>
  );
}

/** "Darunter": the entries below one, as plain links (the inbox's views of an entry). */
export function BelowList({ items, className }: { items: Item[]; className?: string }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  if (!items.length) return null;
  return (
    <div className={className}>
      <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{t("below.title")}</p>
      <ul className="space-y-1 text-sm">
        {items.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <ItemIcon item={c} size={14} /> <a href={hrefOf(c.id)} className="truncate hover:underline">{titleOf(c, t)}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A quiet amber mark on a hit that still waits in the inbox ("Im Eingang"); nothing otherwise. */
export function InTray({ item, ix }: { item: Item; ix: Index }) {
  if (!isInInbox(item, ix)) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-inbox/45 px-1.5 text-[11px] font-medium leading-[18px] text-warn">
      <span className="size-1.5 rounded-full bg-inbox" aria-hidden /> {tr("tray.inTray")}
    </span>
  );
}

export function RelTime({ ts }: { ts: number }) {
  const { lang } = useT();
  return <time dateTime={new Date(ts).toISOString()}>{fmtRelative(lang, ts)}</time>;
}

/** A due date: red once overdue (unless done), amber today. `cell`: in a table's column, as big as the other values. */
export function DueLabel({ due, done, cell }: { due?: string; done?: boolean; cell?: boolean }) {
  const { t, lang } = useT();
  if (!due) return null;
  const today = todayISO();
  const overdue = !done && due < today;
  const isToday = due === today;
  return (
    <span className={cn("whitespace-nowrap tabular-nums", !cell && "text-xs", !cell && (overdue || isToday) && "font-medium", overdue ? "text-danger" : isToday ? "text-warn" : cell ? "text-fg" : "text-muted-foreground")}>
      {isToday ? t("time.today") : fmtShortDate(lang, due)}
    </span>
  );
}

/** An empty value in a cell or field. */
export const EmptyDash = () => <span className="text-faint">–</span>;
