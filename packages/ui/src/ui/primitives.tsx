import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { Button as ShadcnButton } from "../components/ui/button";
import { Dialog as DialogRoot, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Popover as PopoverRoot, PopoverAnchor, PopoverContent } from "../components/ui/popover";
import { type ComponentProps, type ComponentType, type ReactNode, useRef, useState } from "react";
import { X, Check, ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { useT } from "../i18n";
import { cn } from "../lib/utils";

const VARIANTS = { ghost: "ghost", primary: "default", outline: "outline", danger: "destructive", "danger-outline": "outline", plain: "plain" } as const;

/**
 * The one button of the app. `plain` has no look of its own (the caller styles it); the others are
 * the quiet (ghost), the main (primary), the framed (outline) and the destructive one; `small` is
 * for tight rows.
 */
export function Button({ variant = "ghost", small, className, type, ...rest }: Omit<ComponentProps<typeof ShadcnButton>, "variant" | "size"> & { variant?: keyof typeof VARIANTS; small?: boolean }) {
  if (variant === "plain") return <ShadcnButton variant="plain" size="none" type={type} className={className} {...rest} />;
  return (
    <ShadcnButton type={type ?? "button"} aria-label={rest["aria-label"] ?? rest.title} variant={VARIANTS[variant]} size="sm" {...rest}
      className={cn("tap h-auto rounded-lg px-2.5 py-1.5", small && "px-1.5 py-0.5", variant === "danger-outline" && "text-danger", className)} />
  );
}

const ICON_SIZES = { md: "rounded-lg p-1.5", sm: "rounded-md p-1", xs: "rounded p-0.5" };

/**
 * A button that is only an icon: its name as tooltip and for screen readers, the shared focus
 * ring, 44 px to tap on touch screens. `md` (16 px icon) in bars and heads, `sm`/`xs` in rows.
 * Passes all button props on (popover triggers).
 */
export function IconButton({ label, icon: Icon, size = "md", iconSize = 16, className, ...rest }: { label: string; icon: ComponentType<{ size?: number }>; size?: keyof typeof ICON_SIZES; iconSize?: number } & Omit<ComponentProps<"button">, "children">) {
  return (
    <ShadcnButton variant="plain" size="none" type="button" title={label} aria-label={label} {...rest} className={cn("tap inline-flex items-center justify-center text-muted-foreground transition-colors hover:bg-hover hover:text-fg disabled:opacity-40", ICON_SIZES[size], className)}>
      <Icon size={iconSize} />
    </ShadcnButton>
  );
}

/** Tools of a row that show on hover or focus (always on touch screens), per named Tailwind group. */
export const REVEAL = {
  any: "opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100",
  row: "opacity-0 group-hover/row:opacity-100 focus:opacity-100 pointer-coarse:opacity-100",
  head: "opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
};

/** "…": the menu of further actions of a page, a row or a group. */
export function MoreMenu({ children, label, align = "right", size = "md", iconSize, className, ...rest }: { children: (close: () => void) => ReactNode; label?: string; align?: "left" | "right"; size?: keyof typeof ICON_SIZES; iconSize?: number; className?: string } & Omit<ComponentProps<"button">, "children" | "onClick">) {
  const { t } = useT();
  return (
    <Popover align={align} trigger={(p) => <IconButton {...rest} {...p} label={label ?? t("more")} icon={MoreHorizontal} size={size} iconSize={iconSize} className={className} />}>
      {children}
    </Popover>
  );
}

/** The quiet "+ …" entry point (a place, a ref, a property, a tag): one look everywhere. Passes all button props on, so it works as a popover trigger too. */
export function AddButton({ children, className, icon: Icon = Plus, ...rest }: ComponentProps<"button"> & { icon?: ComponentType<{ size?: number }> }) {
  return (
    <ShadcnButton variant="plain" size="none" type="button" {...rest} className={cn("tap-y inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover hover:text-fg", className)}>
      <Icon size={12} /> {children}
    </ShadcnButton>
  );
}

/** The one quiet action of a section head ("+ Notiz", "+ Update"). */
export function SectionAction({ children, className, icon: Icon = Plus, ...rest }: ComponentProps<"button"> & { icon?: ComponentType<{ size?: number }> }) {
  return (
    <ShadcnButton variant="plain" size="none" type="button" {...rest} className={cn("tap-y flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg", className)}>
      <Icon size={14} /> {children}
    </ShadcnButton>
  );
}

/** A property without a value: "Leer", to click and fill in. */
export function EmptyValueButton({ className, ...rest }: Omit<ComponentProps<"button">, "children">) {
  const { t } = useT();
  return (
    <ShadcnButton variant="plain" size="none" {...rest} className={cn("tap-y -ml-1 rounded px-1 text-muted-foreground hover:bg-hover hover:text-fg", className)}>
      {t("props.empty")}
    </ShadcnButton>
  );
}

/** A changed view or filter not saved yet: "Entwurf · Verwerfen · Speichern". */
export function DraftBar({ onDiscard, onSave, className }: { onDiscard: () => void; onSave: () => void; className?: string }) {
  const { t } = useT();
  return (
    <div className={cn("flex flex-wrap items-center gap-2 rounded-lg border border-focus px-2.5 py-1.5 text-sm", className)} role="status">
      <span className="mr-auto text-muted-foreground">{t("view.draft")}</span>
      <Button variant="outline" onClick={onDiscard}>
        {t("view.discard")}
      </Button>
      <Button variant="primary" onClick={onSave}>
        {t("view.save")}
      </Button>
    </div>
  );
}

/** In place of a page that cannot show (yet): one quiet line, centred; `fill`: in the middle of the whole area. */
export function PagePlaceholder({ children, fill }: { children: ReactNode; fill?: boolean }) {
  return <div className={fill ? "flex h-full items-center justify-center text-muted-foreground" : "mx-auto max-w-3xl px-6 py-16 text-center text-muted-foreground"}>{children}</div>;
}

/**
 * A whole surface with nothing to show (inbox, an empty list, a start without anything):
 * centred, one sentence, at most one button. Never for a single section – that one is left out.
 */
export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <div className="text-[15px] text-muted-foreground">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

/**
 * The one section head (design rules § 2.1): title 15/600, a count in muted, at most one quiet
 * action or one switch on the right. No capitals, no symbol before the title.
 */
export function SectionTitle({ children, count, right, className }: { children: ReactNode; count?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-2.5 flex min-h-8 items-center gap-2", className)}>
      <h2 className="truncate text-[15px] font-semibold leading-[22px] text-fg">{children}</h2>
      {count !== undefined && count !== null && count !== "" && <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{count}</span>}
      {right && <div className="ml-auto flex shrink-0 items-center gap-1.5">{right}</div>}
    </div>
  );
}

/** A frame for one block (design rules § 2.9): surface, 1 px border, radius 12. Never a card in a card. */
export function Card({ className, ...rest }: ComponentProps<"div">) {
  return <div {...rest} className={cn("rounded-xl border border-line bg-surface", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-muted-foreground">{children}</kbd>;
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
        <Button variant="plain" {...p} className="tap inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("view.label")}>
          {label} <ChevronDown size={14} />
        </Button>
      )}
    >
      {(close) =>
        shown.map((s, i) => (
          <div key={i} className={cn(i > 0 && "mt-1 border-t border-line pt-1")}>
            {s.title && <p className="px-2.5 pb-0.5 pt-1 text-xs text-muted-foreground">{s.title}</p>}
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
  triggerClass,
}: {
  trigger: (p: { onClick: () => void; "aria-expanded": boolean }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  align?: "left" | "right";
  /** around the trigger (e.g. to let it take the free width) */
  triggerClass?: string;
}) {
  const [inner, setInner] = useState(false);
  const previous = useRef<HTMLElement | null>(null);
  const isOpen = open ?? inner;
  const set = (o: boolean) => {
    if (o) previous.current = document.activeElement as HTMLElement;
    if (open === undefined) setInner(o);
    onOpenChange?.(o);
  };
  return (
    <PopoverRoot open={isOpen} onOpenChange={set}>
      <PopoverAnchor asChild><span className={cn("relative inline-flex", triggerClass)}>
        {trigger({ onClick: () => set(!isOpen), "aria-expanded": isOpen })}
      </span></PopoverAnchor>
      {/* focus goes back to where it was only if nothing took it meanwhile – a click on another
          badge's menu has, and taking it back would close that menu again */}
      <PopoverContent onCloseAutoFocus={(e) => { e.preventDefault(); const now = document.activeElement; if (previous.current?.isConnected && (!now || now === document.body)) previous.current.focus({ preventScroll: true }); }} data-popover align={align === "right" ? "end" : "start"} sideOffset={4}
        className="z-50 max-h-[70vh] w-auto min-w-48 overflow-y-auto rounded-xl p-1">
        {typeof children === "function" ? children(() => set(false)) : children}
      </PopoverContent>
    </PopoverRoot>
  );
}

export function MenuItem({ children, onClick, danger, active, icon }: { children: ReactNode; onClick: () => void; danger?: boolean; active?: boolean; icon?: ReactNode }) {
  return (
    <Button variant="plain"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn("tap-row flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", danger && "text-danger", active && "font-medium")}
    >
      {icon && <span className="flex w-4 shrink-0 justify-center text-muted-foreground">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {/* the chosen one in a choice menu: always a check mark, as everywhere */}
      {active && <Check size={14} className="shrink-0 text-muted-foreground" />}
    </Button>
  );
}

export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const { t } = useT();
  const previous = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
  return <DialogRoot open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent onCloseAutoFocus={(e) => { e.preventDefault(); if (previous.current?.isConnected) previous.current.focus({ preventScroll: true }); }} showCloseButton={false} aria-describedby={undefined}
      className={cn("flex max-h-[84vh] flex-col gap-0 overflow-hidden rounded-2xl p-0", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}>
      <DialogHeader className="flex-row items-center gap-2 border-b border-line px-4 py-3 text-left">
        <DialogTitle className="flex-1 text-base">{title}</DialogTitle>
        <IconButton onClick={onClose} label={t("close")} icon={X} />
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto p-4">{children}</div>
    </DialogContent>
  </DialogRoot>;
}

/** Small segmented control. */
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return <ToggleGroup type="single" value={value} onValueChange={(v) => { if (v) onChange(v as T); }} aria-label={label} className="inline-flex rounded-lg border border-line bg-secondary p-0.5 text-xs">
    {options.map((o) => <ToggleGroupItem key={o.value} value={o.value} className="tap h-auto min-w-0 rounded-md px-2 py-0.5 text-xs data-[state=on]:bg-card data-[state=on]:font-medium data-[state=on]:shadow-sm">{o.label}</ToggleGroupItem>)}
  </ToggleGroup>;
}
