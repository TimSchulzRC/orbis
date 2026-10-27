// All short notices go through sonner: one <Toaster> at the bottom centre (on a phone above the
// bottom bar), at most three at a time, in the app's light or dark, coloured only for errors.
// `notify` keeps one look everywhere: a sentence, and "Rückgängig" or one other step.
import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { tr } from "../i18n";
import { useTheme } from "../theme";

const PLAIN = 5000; // a notice to read
const WITH_ACTION = 7000; // one with "Rückgängig" or "Öffnen": a little longer

/** A short notice; with `undo` it offers "Rückgängig", with `action` another step ("Öffnen"). */
export function notify(text: string, undo?: () => void, action?: { label: string; run: () => void }) {
  if (undo) return notify.undo(text, undo);
  if (action) return notify.action(text, action.label, action.run);
  toast(text, { duration: PLAIN });
}
/** "„Titel“ im Papierkorb · Rückgängig" – the same for every undo. `id`: a notice that grows instead of repeating. */
notify.undo = (text: string, onUndo: () => void, id?: string) => {
  toast(text, { id, duration: WITH_ACTION, action: { label: tr("activity.undo"), onClick: onUndo } });
};
notify.action = (text: string, label: string, run: () => void) => {
  toast(text, { duration: WITH_ACTION, action: { label, onClick: run } });
};
notify.error = (text: string) => {
  // the only coloured notice: a soft red with the error text colour (4.5:1)
  toast.error(text, { duration: WITH_ACTION, style: { background: "color-mix(in srgb, var(--danger) 10%, var(--surface))", color: "var(--danger-text)", border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)" } });
};

/**
 * Where the notices sit: bottom centre; on a phone above the bottom bar. They never cover the field
 * someone types in: while a field in the lower part has the focus they move above it – and come
 * back only a moment after it lets go, so a click on a notice is never lost to the move.
 */
function useOffset(): number {
  const phone = () => window.innerWidth < 768;
  const base = () => (phone() ? 80 : 24);
  const [bottom, setBottom] = useState(base);
  useEffect(() => {
    let later: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(later);
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.matches("input, textarea, select, [contenteditable=true]") || el.isContentEditable) && !el.closest("[data-sonner-toaster]");
      if (!typing) return setBottom(base());
      const r = el.getBoundingClientRect();
      const lift = window.innerHeight - r.top + 8;
      setBottom(r.bottom > window.innerHeight - base() - 64 && r.top < window.innerHeight ? Math.max(base(), lift) : base());
    };
    const away = () => {
      clearTimeout(later);
      later = setTimeout(check, 600);
    };
    check();
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", away);
    window.addEventListener("resize", check);
    return () => {
      clearTimeout(later);
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", away);
      window.removeEventListener("resize", check);
    };
  }, []);
  return bottom;
}

export function AppToaster() {
  const { resolved } = useTheme();
  const bottom = useOffset();
  return (
    <Toaster
      position="bottom-center"
      theme={resolved}
      visibleToasts={3}
      richColors
      offset={{ bottom: `calc(${bottom}px + env(safe-area-inset-bottom))` }}
      mobileOffset={{ bottom: `calc(${bottom}px + env(safe-area-inset-bottom))`, left: 16, right: 16 }}
      toastOptions={{
        // neutral: ink on the page (like the primary button), radius 12; the action as a quiet link
        style: { background: "var(--ink)", color: "var(--ink-text)", border: "1px solid var(--ink)", borderRadius: 12, fontSize: 14, fontFamily: "var(--font-sans)" },
        classNames: {
          actionButton: "!bg-transparent !font-semibold !text-[var(--ink-text)] !underline !underline-offset-2 !text-sm !px-1",
          cancelButton: "!bg-transparent !text-[var(--ink-text)]",
          error: "!border-[var(--danger)]",
        },
      }}
    />
  );
}
