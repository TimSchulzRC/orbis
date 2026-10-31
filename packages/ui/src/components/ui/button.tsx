import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"
import { Slot } from "radix-ui"

const box = "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap"

const buttonVariants = cva(
  "transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** no look of its own: the caller styles it */
        plain: "",
        default: [box, "bg-primary text-primary-foreground hover:bg-primary/90"],
        destructive: [box, "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40"],
        outline: [box, "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50"],
        ghost: [box, "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"],
      },
      size: {
        none: "",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "sm",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "sm",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button }
