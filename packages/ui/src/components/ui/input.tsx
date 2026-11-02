import * as React from "react"
import { cn, framedFocus } from "../../lib/utils"

const LOOKS = {
  default: "rounded-lg border border-line bg-bg px-3 py-2",
  sm: "rounded-md border border-line bg-bg px-2 py-1",
  /** the caller places it */
  bare: "",
}

function Input({ className, type, variant = "default", ...props }: React.ComponentProps<"input"> & { variant?: keyof typeof LOOKS }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-auto w-full min-w-0 rounded-none border-0 bg-transparent p-0 text-sm transition-[color,border-color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        ["checkbox", "radio", "file", "hidden", "range", "color"].includes(type ?? "") ? "w-auto" : LOOKS[variant],
        variant !== "bare" && framedFocus,
        className
      )}
      {...props}
    />
  )
}

export { Input }
