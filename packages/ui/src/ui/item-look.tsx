import { Badge } from "../components/ui/badge";
import type { ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { type Item, type OptionDef, type StatusGroup, type TypeSchema, META_TYPE, todayISO } from "@obtion/core/model";
import { type T, fmtRelative, fmtShortDate } from "@obtion/core/i18n";
import { isInInbox } from "@obtion/core/placement";
import type { Index } from "@obtion/core/graph";
import { repo } from "../repo";
import { useIndex, useItemHref } from "../hooks";
import { tr, useT, titleOf } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./primitives";
import { ICON, INBOX_ICON, NOTE_ICON, TYPE_ICON, FILE_ICONS, DRAWING_ICON } from "./icons";

export const pal = (color?: string) => `var(--pal-${color ?? "slate"}, var(--pal-slate))`;

export const tint = (c: string) => ({ color: `color-mix(in srgb, ${c} 62%, var(--text))`, background: `color-mix(in srgb, ${c} 12%, transparent)` });

export const GROUP_COLOR: Record<StatusGroup, string> = { todo: "var(--faint)", active: "var(--t-inbox)", done: "var(--ok)" };

export const statusColor = (option: OptionDef, done = option.group === "done") =>
  done ? "var(--ok)" : option.color && option.color !== "gray" ? pal(option.color) : undefined;

export interface Look {
  icon: typeof INBOX_ICON;
  color: string;
  /** "schema" is an entry of a user type, named by `name` */
  kind: "file" | "drawing" | "type" | "inbox" | "note" | "schema";
  name?: string;
}

export function itemLook(item: Item, ix: Index = repo.index()): Look {
  if (item.kind === "file") return { icon: FILE_ICONS[item.file?.filetype ?? "other"] ?? FILE_ICONS.other!, color: "var(--t-file)", kind: "file" };
  if (item.kind === "drawing") return { icon: DRAWING_ICON, color: "var(--t-drawing)", kind: "drawing" };
  if (item.schema && item.type === META_TYPE) return { icon: ICON[item.schema.icon] ?? TYPE_ICON, color: pal(item.schema.color), kind: "type" };
  const schema = ix.schemaOf(item);
  if (schema) return { icon: ICON[schema.icon] ?? ICON.circle!, color: pal(schema.color), kind: "schema", name: schema.name };
  if (isInInbox(item, ix)) return { icon: INBOX_ICON, color: "var(--t-inbox)", kind: "inbox" };
  return { icon: NOTE_ICON, color: "var(--t-note)", kind: "note" };
}

/** `inboxAsNote` labels inbox entries as notes. */
export function kindLabel(look: Look, t: T, opts: { inboxAsNote?: boolean } = {}): string {
  if (look.kind === "schema") return look.name ?? "";
  return t("kind." + (look.kind === "inbox" && opts.inboxAsNote ? "note" : look.kind));
}

/** Pass `ix` when the item is in another workspace than the open one (the sidebar shows others). */
export function ItemIcon({ item, size = 16, className, ix }: { item: Item; size?: number; className?: string; ix?: Index }) {
  const { t } = useT();
  const here = useIndex();
  const look = itemLook(item, ix ?? here);
  return <look.icon size={size} style={{ color: look.color }} className={cn("shrink-0", className)} aria-label={kindLabel(look, t)} />;
}

export function TypeGlyph({ schema, size = 16, className }: { schema?: TypeSchema; size?: number; className?: string }) {
  const Icon = (schema && ICON[schema.icon]) || ICON.circle!;
  return <Icon size={size} style={{ color: pal(schema?.color) }} className={cn("shrink-0", className)} aria-hidden />;
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

/** Distinct shapes per group, so a status reads without colour: ring, half circle, check. */
export function StatusGlyph({ option, size = 16, className }: { option: OptionDef; size?: number; className?: string }) {
  const group = option.group ?? "todo";
  if (group === "done") return <CircleCheck size={size} className={className} aria-hidden />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      {group === "active" && <path d="M12 6a6 6 0 0 0 0 12z" fill="currentColor" stroke="none" />}
    </svg>
  );
}

export function StatusPill({ option, small, group, label }: { option?: OptionDef; small?: boolean; group?: StatusGroup; label?: ReactNode }) {
  if (!option) return null;
  const statusGroup = group ?? option.group;
  const color = option.color ? pal(option.color) : GROUP_COLOR[statusGroup ?? "todo"];
  return (
    <Badge className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium", small ? "px-1.5 py-0 text-xs" : "px-2 py-0.5 text-xs")} style={tint(color)}>
      {statusGroup ? <StatusGlyph option={{ ...option, group: statusGroup }} size={12} /> : <span className="size-1.5 rounded-full" style={{ background: color }} />}
      {label ?? option.name}
    </Badge>
  );
}

/** A tag; `onOpen` makes its name a button (the page's tags open the palette with "#tag"). */
export function Tag({ tag, onRemove, onOpen }: { tag: string; onRemove?: () => void; onOpen?: () => void }) {
  const { t } = useT();
  const name = (
    <>
      <span className="text-muted-foreground">#</span>
      {tag}
    </>
  );
  return (
    <span className="group/tag inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-muted-foreground">
      {onOpen ? (
        <Button variant="plain" onClick={onOpen} className="hover:text-fg">
          {name}
        </Button>
      ) : (
        name
      )}
      {onRemove && (
        <Button variant="plain"
          className="-mr-1 ml-0.5 rounded px-1 text-muted-foreground opacity-0 transition-opacity hover:bg-hover hover:text-fg focus:opacity-100 group-hover/tag:opacity-100 pointer-coarse:opacity-100"
          onClick={onRemove}
          aria-label={t("tag.remove", { tag })}
        >
          ×
        </Button>
      )}
    </span>
  );
}

/** `draggable={false}` where the link sits in something dragged itself (the browser would drag the link). */
export function ItemLink({ item, className, draggable }: { item: Item; className?: string; draggable?: boolean }) {
  const { t } = useT();
  const hrefOf = useItemHref();
  return (
    <a href={hrefOf(item.id)} draggable={draggable} className={cn("inline-flex min-w-0 items-center gap-1.5 hover:underline", className)}>
      <ItemIcon item={item} size={14} />
      <span className="truncate">{titleOf(item, t)}</span>
    </a>
  );
}

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

/** `cell`: sized like the other values in a table column. */
export function DueLabel({ due, done, cell }: { due?: string; done?: boolean; cell?: boolean }) {
  const { t, lang } = useT();
  if (!due) return null;
  const today = todayISO();
  const overdue = !done && due < today;
  const isToday = due === today;
  const tone = overdue ? "text-danger" : isToday ? "text-warn" : cell ? "text-fg" : "text-muted-foreground";
  return (
    <span className={cn("whitespace-nowrap tabular-nums", !cell && "text-xs", !cell && (overdue || isToday) && "font-medium", tone)}>
      {isToday ? t("time.today") : fmtShortDate(lang, due)}
    </span>
  );
}

export const EmptyDash = () => <span className="text-faint">–</span>;
