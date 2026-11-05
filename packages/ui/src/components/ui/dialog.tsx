import * as React from "react"
import { cn } from "../../lib/utils"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { tr } from "../../i18n"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

/** Shared by everything that opens over the page (dialogs, palette, phone menu, tray panel). */
const BACKDROP = "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"

/** For overlays that don't use a dialog's own overlay. */
function Backdrop({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="backdrop" className={cn(BACKDROP, className)} {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        BACKDROP,
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

/** A notice at the bottom ("Rückgängig") stays usable over a dialog: a click on it does not close the dialog. */
const onToast = (e: Event) => !!(e.target as Element | null)?.closest?.("[data-sonner-toaster]")

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className
        )}
        onInteractOutside={(e) => {
          if (onToast(e)) e.preventDefault()
          onInteractOutside?.(e)
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">{tr("close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

/**
 * A panel at the right edge (from the bottom on phones). `modal`: over the page with a backdrop;
 * otherwise beside it, without one (the dialog root gets `modal={false}` too).
 */
function SheetContent({
  className,
  children,
  onInteractOutside,
  modal = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { modal?: boolean }) {
  return (
    <DialogPortal>
      {/* lighter than a dialog's: the page stays readable beside the panel */}
      {modal && <DialogOverlay className="bg-black/30 backdrop-blur-none" />}
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex flex-col border-line bg-surface outline-none duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in",
          "inset-y-0 right-0 w-[440px] max-w-[calc(100%-3rem)] border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
          "max-md:inset-x-0 max-md:top-auto max-md:max-h-[88dvh] max-md:w-full max-md:max-w-none max-md:rounded-t-2xl max-md:border-t max-md:border-l-0 max-md:pb-safe max-md:data-[state=closed]:slide-out-to-bottom max-md:data-[state=open]:slide-in-from-bottom",
          modal && "shadow-2xl",
          className
        )}
        onInteractOutside={(e) => {
          if (onToast(e)) e.preventDefault()
          onInteractOutside?.(e)
        }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

export {
  Backdrop,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  SheetContent,
}

/** Layout-preserving modal for the command palette, mobile sheets and media viewer. */
function ModalSurface({ children, title, onClose, enabled = true }: { children: React.ReactElement; title: string; onClose: () => void; enabled?: boolean }) {
  const previous = React.useRef<HTMLElement | null>(typeof document === "undefined" ? null : document.activeElement as HTMLElement);
  if (!enabled) return children;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPortal>
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <DialogPrimitive.Content asChild aria-describedby={undefined} onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (previous.current?.isConnected) previous.current.focus({ preventScroll: true });
      }}>{children}</DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
export { ModalSurface };
