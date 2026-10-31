import * as React from "react"
import { cn, framedFocus } from "../../lib/utils"

/** `inline`: no frame, text that is edited in place (a title, a description). */
function Textarea({ className, variant = "default", ...props }: React.ComponentProps<"textarea"> & { variant?: "default" | "inline" }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
        variant === "default" && framedFocus,
        variant === "inline" && "min-h-0 rounded-none border-0 p-0 shadow-none dark:bg-transparent",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
