import * as React from "react"
import { cn } from "../../lib/utils"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import { TIP_CLASS } from "../../ui/TitleTips"

/** A short label next to a control that has only an icon: on hover and keyboard focus. */
function Tip({ label, children, side = "top", className }: { label: React.ReactNode; children: React.ReactElement; side?: "top" | "right" | "bottom" | "left"; className?: string }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className={cn(
              "z-[100]", TIP_CLASS, "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
              className
            )}
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}

export { Tip }
