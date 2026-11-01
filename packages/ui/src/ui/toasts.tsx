// `notify` keeps one look for every notice: a sentence, and "Rückgängig" or one other step.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Toaster } from "../components/ui/sonner";
import { tr } from "../i18n";
import { PHONE } from "../lib/platform";

const PLAIN = 5000;
const WITH_ACTION = 7000; // a notice with "Rückgängig" or "Öffnen" stays longer

/** A short notice; `.undo` offers "Rückgängig", `.action` another step ("Öffnen"), `.error` says what failed. */
export function notify(text: string) {
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
  toast.error(text, { duration: WITH_ACTION });
};

/**
 * Notices never cover a focused field in the lower part: they move above it, and come back only a
 * moment after it loses focus, so a click on a notice is never lost to the move.
 */
function useOffset(): number {
  const phone = () => matchMedia(PHONE).matches;
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
  const bottom = useOffset();
  return (
    <Toaster
      position="bottom-center"
      visibleToasts={3}
      offset={{ bottom: `calc(${bottom}px + env(safe-area-inset-bottom))` }}
      mobileOffset={{ bottom: `calc(${bottom}px + env(safe-area-inset-bottom))`, left: 16, right: 16 }}
      toastOptions={{ classNames: { error: "[&_[data-icon]]:text-destructive" } }}
    />
  );
}
