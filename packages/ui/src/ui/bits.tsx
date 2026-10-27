import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check, ChevronDown, ChevronRight, CircleCheck, CirclePause, CircleX, CalendarDays, Plus } from "lucide-react";
import { type Item, type OptionDef, type StatusGroup, type TypeSchema, META_TYPE, todayISO } from "@obtion/core/model";
import { fmtRelative, fmtShortDate } from "@obtion/core/i18n";
import { isInInbox, isOverview } from "@obtion/core/placement";
import type { Index } from "@obtion/core/graph";
import { parseDate, statusShape } from "@obtion/core/input";
import { repo } from "../repo";
import { itemHref } from "../hooks";
import { tr, useT } from "../i18n";
import { ICON, INBOX_ICON, NOTE_ICON, OVERVIEW_ICON, TYPE_ICON, FILE_ICONS } from "./icons";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export const pal = (color?: string) => `var(--pal-${color ?? "slate"}, var(--pal-slate))`;

export const GROUP_COLOR: Record<StatusGroup, string> = { todo: "var(--faint)", active: "var(--t-inbox)", done: "var(--ok)" };

/** Visual identity of an item: its type, or note / inbox / file / type. */
export function itemLook(item: Item, ix: Index = repo.index()): { icon: typeof INBOX_ICON; color: string; label: string } {
  if (item.kind === "datei") return { icon: FILE_ICONS[item.file?.filetype ?? "sonstiges"] ?? FILE_ICONS.sonstiges!, color: "var(--t-file)", label: "file" };
  if (item.schema && item.type === META_TYPE) return { icon: ICON[item.schema.icon] ?? TYPE_ICON, color: pal(item.schema.color), label: "type" };
  const schema = ix.schemaOf(item);
  if (schema) return { icon: ICON[schema.icon] ?? ICON.circle!, color: pal(schema.color), label: schema.name };
  if (isInInbox(item, ix)) return { icon: INBOX_ICON, color: "var(--t-inbox)", label: "inbox" };
  if (isOverview(item, ix)) return { icon: OVERVIEW_ICON, color: "var(--pal-violet)", label: "overview" };
  return { icon: NOTE_ICON, color: "var(--t-note)", label: "note" };
}

/** `ix`: the index of the item's workspace, if it is not the open one (the sidebar shows others). */
export function ItemIcon({ item, size = 16, className, ix }: { item: Item; size?: number; className?: string; ix?: Index }) {
  const { t } = useT();
  const look = itemLook(item, ix);
  const label = ["file", "inbox", "note", "type", "overview"].includes(look.label) ? t("kind." + look.label) : look.label;
  return <look.icon size={size} style={{ color: look.color }} className={cx("shrink-0", className)} aria-label={label} />;
}

export function TypeGlyph({ schema, size = 16, className }: { schema?: TypeSchema; size?: number; className?: string }) {
  const I = (schema && ICON[schema.icon]) || ICON.circle!;
  return <I size={size} style={{ color: pal(schema?.color) }} className={cx("shrink-0", className)} aria-hidden />;
}

export function TypeChip({ schema, onClick }: { schema: TypeSchema; onClick?: () => void }) {
  const c = pal(schema.color);
  const El = onClick ? "button" : "span";
  return (
    <El
      onClick={onClick}
      className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", onClick && "tap-y")}
      style={{ color: `color-mix(in srgb, ${c} 62%, var(--text))`, background: `color-mix(in srgb, ${c} 12%, transparent)` }}
    >
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

export function StatusPill({ option, small, group }: { option?: OptionDef; small?: boolean; group?: StatusGroup }) {
  if (!option) return null;
  const c = option.color ? pal(option.color) : GROUP_COLOR[group ?? option.group ?? "todo"];
  // status options have a group and show their shape; plain select options a dot
  const isStatus = !!(group ?? option.group);
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium", small ? "px-1.5 py-0 text-xs" : "px-2 py-0.5 text-xs")}
      style={{ color: `color-mix(in srgb, ${c} 62%, var(--text))`, background: `color-mix(in srgb, ${c} 13%, transparent)` }}
    >
      {isStatus ? <StatusGlyph option={{ ...option, group: group ?? option.group }} size={12} /> : <span className="size-1.5 rounded-full" style={{ background: c }} />}
      {option.name}
    </span>
  );
}

export function Tag({ tag, onRemove, href }: { tag: string; onRemove?: () => void; href?: string }) {
  const { t } = useT();
  const inner = (
    <>
      <span className="text-muted">#</span>
      {tag}
      {onRemove && (
        <button
          className="-mr-1 ml-0.5 rounded px-1 text-muted hover:bg-hover hover:text-fg"
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
          aria-label={t("tag.remove", { tag })}
        >
          ×
        </button>
      )}
    </>
  );
  const cls = "inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-muted";
  return href ? (
    <a href={href} className={cx(cls, "hover:text-fg")}>
      {inner}
    </a>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

export function Progress({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className={cx("h-1.5 overflow-hidden rounded-full bg-surface-2", className)} role="progressbar" title={tr("progress.title", { done, total })} aria-label={tr("progress.label")} aria-valuetext={`${done}/${total}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: "var(--ok)" }} />
    </div>
  );
}

/** Progress as "done/total" – the same everywhere (row, board, table, page); "–" without entries. */
export function ProgressCount({ done, total, className }: { done: number; total: number; className?: string }) {
  return (
    <span className={cx("tabular-nums", className)} title={total ? tr("progress.title", { done, total }) : undefined}>
      {total ? `${done}/${total}` : "–"}
    </span>
  );
}

/** A link to an entry; `wrap`: long titles break into lines instead of being cut off (narrow columns). */
export function ItemLink({ item, className, showIcon = true, wrap }: { item: Item; className?: string; showIcon?: boolean; wrap?: boolean }) {
  const { t } = useT();
  return (
    <a href={itemHref(item.id)} className={cx("inline-flex min-w-0 gap-1.5 hover:underline", wrap ? "items-start" : "items-center", className)}>
      {showIcon && <ItemIcon item={item} size={14} className={wrap ? "mt-0.5 shrink-0" : undefined} />}
      <span className={wrap ? "min-w-0 break-words" : "truncate"}>{item.title || t("untitled")}</span>
    </a>
  );
}

export function Button({
  children,
  onClick,
  variant = "ghost",
  className,
  title,
  type = "button",
  disabled,
  autoFocus,
  ...rest
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: "ghost" | "primary" | "outline" | "danger";
  className?: string;
  title?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  autoFocus?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type" | "className" | "title" | "disabled" | "autoFocus" | "children">) {
  const v = {
    ghost: "text-muted hover:bg-hover hover:text-fg",
    primary: "bg-ink text-ink-text hover:opacity-90",
    outline: "border border-line bg-surface text-fg hover:bg-hover",
    danger: "text-danger hover:bg-hover",
  }[variant];
  return (
    <button
      {...rest}
      type={type}
      title={title}
      aria-label={rest["aria-label"] ?? title}
      disabled={disabled}
      autoFocus={autoFocus}
      onClick={onClick}
      className={cx("tap inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors disabled:opacity-40", v, className)}
    >
      {children}
    </button>
  );
}

/**
 * A button that is only an icon: 16 px icon, its name as tooltip and for screen readers, the
 * shared focus ring, 44 px to tap on touch screens. Passes all button props on (popover triggers).
 */
export function IconButton({ label, icon: Icon, className, ...rest }: { label: string; icon: React.ComponentType<{ size?: number }> } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button type="button" title={label} aria-label={label} {...rest} className={cx("tap inline-flex items-center justify-center rounded-lg p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40", className)}>
      <Icon size={16} />
    </button>
  );
}

/** The quiet "+ …" entry point (a place, a ref, a property, a tag): one look everywhere. Passes all button props on, so it works as a popover trigger too. */
export function AddButton({ children, className, icon: Icon = Plus, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ComponentType<{ size?: number }> }) {
  return (
    <button type="button" {...rest} className={cx("tap-y inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg", className)}>
      <Icon size={12} /> {children}
    </button>
  );
}

/**
 * A whole surface with nothing to show (inbox, an empty list, a start without anything):
 * centred, one sentence, at most one button. Never for a single section – that one is left out.
 */
export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <div className="text-[15px] text-muted">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

/**
 * The one section head (design rules § 2.1): title 15/600, a count in muted, at most one quiet
 * action or one switch on the right. Collapsible: the whole head is the button, a chevron in
 * front of the title. No capitals, no symbol before the title.
 */
export function SectionTitle({ children, count, right, open, onToggle, className }: { children: ReactNode; count?: ReactNode; right?: ReactNode; open?: boolean; onToggle?: () => void; className?: string }) {
  const head = (
    <>
      {onToggle && <ChevronRight size={14} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} aria-hidden />}
      <h2 className="truncate text-[15px] font-semibold leading-[22px] text-fg">{children}</h2>
      {count !== undefined && count !== null && count !== "" && <span className="shrink-0 text-[13px] tabular-nums text-muted">{count}</span>}
    </>
  );
  return (
    <div className={cx("mb-2.5 flex min-h-8 items-center gap-2", className)}>
      {onToggle ? (
        <button type="button" onClick={onToggle} aria-expanded={!!open} className="tap-y -ml-1 flex min-w-0 items-center gap-2 rounded-md px-1 text-left hover:bg-hover">
          {head}
        </button>
      ) : (
        head
      )}
      {right && <div className="ml-auto flex shrink-0 items-center gap-1.5">{right}</div>}
    </div>
  );
}

/** A frame for one block (design rules § 2.9): surface, 1 px border, radius 12. Never a card in a card. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-line bg-surface", className)}>{children}</div>;
}

/**
 * Progress of a page (design rules § 2.3): bar 8 high, the share in percent 15/600 and what it
 * counts in muted ("2 von 9 Tasks erledigt, alle Ebenen"). Not shown without entries.
 */
export function ProgressBand({ done, total, desc }: { done: number; total: number; desc: string }) {
  const { lang } = useT();
  if (!total) return null;
  const share = done / total;
  return (
    <div className="mt-[18px] flex flex-wrap items-center gap-x-3 gap-y-1">
      <div
        className="h-2 w-[280px] overflow-hidden rounded-full bg-surface-2 max-md:w-auto max-md:flex-1 dark:bg-hover"
        role="progressbar"
        aria-valuenow={Math.round(share * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={desc}
      >
        <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: "var(--ok)" }} />
      </div>
      <span className="text-[15px] font-semibold tabular-nums">{new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(share)}</span>
      <span className="text-[13px] text-muted">{desc}</span>
    </div>
  );
}

/** The modifier key as this platform names it: ⌘ on Apple devices, Strg/Ctrl elsewhere. */
export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

/** A key hint as this platform and language name it: "⌘J" on Apple devices, "Strg J" / "Ctrl J" elsewhere. */
export function shortcut(key: string, lang: string): string {
  return MOD === "⌘" ? `⌘${key}` : `${modName(lang)} ${key}`;
}
export function modName(lang: string): string {
  return MOD === "⌘" ? "⌘" : lang === "de" ? "Strg" : "Ctrl";
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

export function RelTime({ ts }: { ts: number }) {
  const { lang } = useT();
  return <time dateTime={new Date(ts).toISOString()}>{fmtRelative(lang, ts)}</time>;
}

export function DueLabel({ due, done }: { due?: string; done?: boolean }) {
  const { t, lang } = useT();
  if (!due) return null;
  const today = todayISO();
  const overdue = !done && due < today;
  const isToday = due === today;
  return (
    <span className={cx("whitespace-nowrap text-xs tabular-nums", overdue ? "font-medium text-danger" : isToday ? "font-medium text-warn" : "text-muted")}>
      {isToday ? t("time.today") : fmtShortDate(lang, due)}
    </span>
  );
}

/** Inline-editable text that commits on blur/Enter. */
export function InlineText({
  value,
  onCommit,
  placeholder,
  className,
  multiline,
  autoFocus,
  label,
  large,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  autoFocus?: boolean;
  label?: string;
  /** a heading-sized field: keeps its size on phones */
  large?: boolean;
}) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  const commit = () => {
    focused.current = false;
    if (v !== value) onCommit(v);
  };
  const props = {
    value: v,
    placeholder,
    autoFocus,
    "data-large": large || undefined,
    "aria-label": label ?? placeholder,
    onFocus: () => (focused.current = true),
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    className: cx("field w-full bg-transparent outline-none placeholder:text-muted", className),
  };
  if (multiline) return <textarea {...props} rows={Math.max(2, v.split("\n").length)} className={cx(props.className, "resize-none [field-sizing:content]")} />;
  return (
    <input
      {...props}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

/** Date input that only commits complete, plausible dates. */
/** An ISO date as the app language writes it: 30.10.2026 (de) or 10/30/2026 (en). */
export function dateText(lang: string, iso?: string): string {
  const m = iso && /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  return lang === "de" ? `${m[3]}.${m[2]}.${m[1]}` : `${m[2]}/${m[3]}/${m[1]}`;
}

/**
 * A date in the app language (not the browser's): typed as 30.10.2026, 10/30/2026, morgen,
 * Freitag … (read like the agent's input), or picked from the calendar.
 */
export function DateField({ value, onChange, label, className, autoFocus }: { value?: string; onChange: (v: string) => void; label: string; className?: string; autoFocus?: boolean }) {
  const { t, lang } = useT();
  const [text, setText] = useState(dateText(lang, value));
  const [bad, setBad] = useState(false);
  const focused = useRef(false);
  const [editing, setEditing] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focused.current) setText(dateText(lang, value));
  }, [value, lang]);
  const commit = () => {
    focused.current = false;
    setEditing(false);
    const raw = text.trim();
    if (!raw) {
      setBad(false);
      if (value) onChange("");
      return;
    }
    const iso = parseDate(raw, todayISO());
    if (!iso) {
      setBad(true);
      setTimeout(() => (setBad(false), setText(dateText(lang, value))), 1500);
      return;
    }
    setBad(false);
    setText(dateText(lang, iso));
    if (iso !== value) onChange(iso);
  };
  return (
    <span className={cx("field-within group/date -ml-1 inline-flex items-center rounded-md hover:bg-hover", className)}>
      <input
        value={text}
        autoFocus={autoFocus}
        aria-label={label}
        aria-invalid={bad || undefined}
        placeholder={editing ? t("date.placeholder") : "–"}
        onFocus={() => ((focused.current = true), setEditing(true))}
        // on a touch screen an empty date opens the date picker right away (typing a date there is awkward)
        onClick={() => !value && matchMedia("(pointer: coarse)").matches && picker.current?.showPicker?.()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(dateText(lang, value));
            setTimeout(() => (e.target as HTMLInputElement).blur());
          }
        }}
        className={cx("w-[6.6rem] bg-transparent px-1 py-0.5 tabular-nums outline-none placeholder:text-muted", bad && "text-danger")}
      />
      <button type="button" onClick={() => picker.current?.showPicker?.()} className="tap relative rounded p-0.5 text-muted opacity-60 hover:text-fg focus-visible:opacity-100 group-hover/date:opacity-100" aria-label={t("date.calendar")}>
        <CalendarDays size={13} />
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden
          value={value ?? ""}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          className="pointer-events-none absolute inset-0 opacity-0"
        />
      </button>
    </span>
  );
}

const modals: HTMLElement[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * What every modal surface does (dialogs, palette, phone menu, agent sheet, full view): focus
 * moves in and stays in (Tab wraps), Escape closes the top-most one (not while a popover in it
 * is open), the page behind is inert, and focus goes back to where it came from.
 */
export function useModal(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = document.activeElement as HTMLElement | null;
    modals.push(el);
    // everything beside the way from this surface up to <body> is inert: the page behind can't be tabbed or tapped
    const behind: HTMLElement[] = [];
    for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement)
      for (const s of n.parentElement?.children ?? []) if (s !== n && s instanceof HTMLElement && !(s instanceof HTMLScriptElement) && !s.hasAttribute("data-popover")) behind.push(s);
    const wasInert = behind.map((b) => b.inert);
    behind.forEach((b) => (b.inert = true));
    // focus moves in: to the field marked for it, else to the surface itself (not to some first control)
    if (!el.contains(document.activeElement)) {
      const target = el.querySelector<HTMLElement>("[data-autofocus]:not([disabled])");
      if (!target && !el.hasAttribute("tabindex")) (el.tabIndex = -1), el.classList.add("outline-none");
      (target ?? el).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (modals.at(-1) !== el) return;
      if (e.key === "Escape") {
        if (document.querySelector("[data-popover]")) return; // the popover closes first
        e.preventDefault();
        close.current();
      } else if (e.key === "Tab") {
        const list = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
        if (!list.length) return e.preventDefault();
        const first = list[0]!;
        const last = list.at(-1)!;
        const active = document.activeElement;
        if (active === el) (e.preventDefault(), (e.shiftKey ? last : first).focus());
        else if (!el.contains(active)) {
          // focus slipped out (or sits in a popover of this dialog): back to the start
          if (document.querySelector("[data-popover]")?.contains(active)) return;
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && active === last) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      modals.splice(modals.indexOf(el), 1);
      behind.forEach((b, i) => (b.inert = wasInert[i]!));
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, []);
}

/**
 * "Liste ▾": the one control for how a list looks – "Darunter", the tasks of a
 * project. The button names the current view; the menu has the choices with a check mark, in
 * sections where there is more than one (Ansicht, Gruppieren, Ebenen). Each choice applies at once.
 */
export function ViewMenu({ label, sections }: { label: string; sections: { title?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }[] }) {
  const { t } = useT();
  const shown = sections.filter((s) => s.options.length > 1);
  if (!shown.length) return null;
  return (
    <Popover
      align="right"
      trigger={(p) => (
        <button {...p} className="tap inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-sm text-muted hover:bg-hover hover:text-fg" aria-label={t("view.label")}>
          {label} <ChevronDown size={14} />
        </button>
      )}
    >
      {(close) =>
        shown.map((s, i) => (
          <div key={i} className={cx(i > 0 && "mt-1 border-t border-line pt-1")}>
            {s.title && <p className="px-2.5 pb-0.5 pt-1 text-xs text-muted">{s.title}</p>}
            {s.options.map((o) => (
              <MenuItem key={o.value} active={o.value === s.value} onClick={() => (close(), s.value !== o.value && s.onChange(o.value))}>
                {o.label}
              </MenuItem>
            ))}
          </div>
        ))
      }
    </Popover>
  );
}

/** Popover anchored to a trigger; closes on outside click and Escape. */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = "left",
  className,
  triggerClass,
}: {
  trigger: (p: { onClick: () => void; "aria-expanded": boolean }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  align?: "left" | "right";
  className?: string;
  /** around the trigger (e.g. to let it take the free width) */
  triggerClass?: string;
}) {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  const set = (o: boolean) => {
    if (open === undefined) setInner(o);
    onOpenChange?.(o);
  };
  const ref = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  useLayoutEffect(() => {
    if (!isOpen || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const below = r.bottom + 4;
    const top = below + 320 > window.innerHeight && r.top > 340 ? Math.max(8, r.top - 4 - (pop.current?.offsetHeight ?? 300)) : below;
    setPos(align === "right" ? { top, right: Math.max(8, window.innerWidth - r.right) } : { top, left: Math.min(r.left, window.innerWidth - 300) });
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node) && set(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && set(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [isOpen]);
  return (
    <span ref={ref} className={cx("relative inline-flex", triggerClass)}>
      {trigger({ onClick: () => set(!isOpen), "aria-expanded": isOpen })}
      {isOpen &&
        createPortal(
          <div
            ref={pop}
            data-popover
            style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left, right: pos?.right }}
            className={cx("z-50 max-h-[70vh] min-w-48 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl", className)}
          >
            {typeof children === "function" ? children(() => set(false)) : children}
          </div>,
          document.body,
        )}
    </span>
  );
}

export function MenuItem({ children, onClick, danger, active, icon }: { children: ReactNode; onClick: () => void; danger?: boolean; active?: boolean; icon?: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active || undefined}
      className={cx("tap-row flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", danger && "text-danger", active && "font-medium")}
    >
      {icon && <span className="flex w-4 shrink-0 justify-center text-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {/* the chosen one in a choice menu: always a check mark, as everywhere */}
      {active && <Check size={14} className="shrink-0 text-muted" />}
    </button>
  );
}

export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-3 pt-[8vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={cx("flex max-h-[84vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl", wide ? "max-w-2xl" : "max-w-lg")}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="flex-1 font-semibold">{title}</h2>
          <IconButton onClick={onClose} label={t("close")} icon={X} />
        </div>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Small segmented control. */
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <span role="group" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx("tap rounded-md px-2 py-0.5", o.value === value ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

