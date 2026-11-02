import * as React from "react"
import { cn } from "../../lib/utils"
import { Tooltip as TooltipPrimitive } from "radix-ui"

/** The look of every tooltip in the app: this one and the `title` tooltips (ui/TitleTips.tsx). */
export const TIP_CLASS = "rounded-md border border-line bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-md"

/** With `card`, a small card instead of the label (the legend of the tray's marks). */
const CARD_CLASS = "rounded-xl border border-line bg-surface p-3 text-[13px] text-fg shadow-[var(--shadow-pop)]"

/**
 * For icon-only controls; shows on hover and keyboard focus, never on touch. Give the control no
 * `title`, or the browser shows its own tooltip as well. With `card`, `label` is what a screen reader
 * hears; `off` keeps it shut.
 */
function Tip({ label, children, side = "top", className, card, off }: { label: React.ReactNode; children: React.ReactElement; side?: "top" | "right" | "bottom" | "left"; className?: string; card?: React.ReactNode; off?: boolean }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={400}>
      <TooltipPrimitive.Root open={off ? false : undefined}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={card ? "start" : "center"}
            sideOffset={card ? 10 : 6}
            collisionPadding={8}
            aria-label={card && typeof label === "string" ? label : undefined}
            className={cn(
              "z-[100] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
              card ? CARD_CLASS : TIP_CLASS,
              className
            )}
          >
            {card ?? label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}

export { Tip }
