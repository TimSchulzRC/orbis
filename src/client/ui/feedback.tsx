// Quiet feedback: one short notice at the bottom ("Erledigt · Rückgängig") and a small
// confirmation dialog for the few things that need one. Both live outside any page.
import { useEffect, useSyncExternalStore } from "react";
import { useT } from "../i18n";
import { Button, Dialog } from "./bits";

// short notices: sonner (see toasts.tsx); kept here so callers import one place for feedback
export { notify } from "./toasts";

type Choice = { key: string; label: string; primary?: boolean; danger?: boolean };
type Ask = { title: string; body: string; choices: Choice[]; resolve: (v: string | null) => void };
let ask: Ask | null = null;
const askListeners = new Set<() => void>();
const askSub = (l: () => void) => (askListeners.add(l), () => void askListeners.delete(l));

/** Ask, with several answers; resolves the chosen key, or null for "cancel". */
export function chooseAction(opts: { title: string; body: string; choices: Choice[] }): Promise<string | null> {
  return new Promise((resolve) => {
    ask?.resolve(null);
    ask = { ...opts, resolve };
    askListeners.forEach((l) => l());
  });
}

/** Ask once before something with consequences; resolves true for "yes". */
export async function confirmAction(opts: { title: string; body: string; yes: string }): Promise<boolean> {
  return (await chooseAction({ title: opts.title, body: opts.body, choices: [{ key: "yes", label: opts.yes, primary: true }] })) === "yes";
}

export function ConfirmHost() {
  const { t } = useT();
  const a = useSyncExternalStore(askSub, () => ask);
  useEffect(() => () => ask?.resolve(null), []);
  if (!a) return null;
  const done = (v: string | null) => {
    a.resolve(v);
    ask = null;
    askListeners.forEach((l) => l());
  };
  return (
    <Dialog title={a.title} onClose={() => done(null)}>
      <p className="text-sm">{a.body}</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => done(null)}>
          {t("cancel")}
        </Button>
        {a.choices.map((c, i) => (
          <Button key={c.key} variant={c.primary ? "primary" : "outline"} className={c.danger ? "!bg-danger !text-white" : undefined} autoFocus={i === a.choices.length - 1} onClick={() => done(c.key)}>
            {c.label}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}
