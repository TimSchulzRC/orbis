// `notify` keeps one look for every notice: a sentence, and "Undo" or one other step.
import { toast } from "sonner";
import { Toaster } from "../components/ui/sonner";
import { tr } from "../i18n";

const PLAIN = 5000;
const WITH_ACTION = 7000; // a notice with "Undo" or "Open" stays longer

/** A short notice; `.undo` offers "Undo", `.action` another step ("Open"), `.error` says what failed. */
export function notify(text: string) {
  toast(text, { duration: PLAIN });
}
/** "“Title” moved to the trash · Undo" – the same for every undo. `id`: a notice that grows instead of repeating. */
notify.undo = (text: string, onUndo: () => void, id?: string) => {
  toast(text, { id, duration: WITH_ACTION, action: { label: tr("activity.undo"), onClick: onUndo } });
};
notify.action = (text: string, label: string, run: () => void) => {
  toast(text, { duration: WITH_ACTION, action: { label, onClick: run } });
};
notify.error = (text: string) => {
  toast.error(text, { duration: WITH_ACTION });
};

/** Sonner as it comes: top right, a close button, several stacked (spread out on hover), swiped away to the side. */
export function AppToaster() {
  return (
    <Toaster
      position="top-right"
      closeButton
      offset={{ top: "calc(16px + env(safe-area-inset-top))", right: 16 }}
      mobileOffset={{ top: "calc(16px + env(safe-area-inset-top))", left: 16, right: 16 }}
      // an open dialog makes the page behind it unclickable (pointer-events on the body): not the notices
      toastOptions={{ classNames: { toast: "pointer-events-auto", error: "[&_[data-icon]]:text-destructive" } }}
    />
  );
}
