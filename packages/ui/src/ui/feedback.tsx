import { useEffect } from "react";
import { useT } from "../i18n";
import { Button, Dialog } from "./primitives";
import { createStore } from "../lib/store";

// re-exported so callers import all feedback from one place
export { notify } from "./toasts";

type Choice<K extends string = string> = { key: K; label: string; primary?: boolean; danger?: boolean };
type Ask = { title: string; body: string; choices: Choice[]; resolve: (v: string | null) => void };
const ask = createStore<Ask | null>(null);

/** Resolves the chosen key, or null when cancelled. */
export function chooseAction<K extends string>(opts: { title: string; body: string; choices: Choice<K>[] }): Promise<K | null> {
  return new Promise<K | null>((resolve) => {
    ask.get()?.resolve(null);
    ask.set({ ...opts, resolve: resolve as (v: string | null) => void });
  });
}

/**
 * The app's only confirmation dialog, use it instead of a custom one. Set `danger` for what cannot
 * be undone, it makes the button red.
 */
export async function confirmAction(opts: { title: string; body: string; yes: string; danger?: boolean }): Promise<boolean> {
  return (await chooseAction({ title: opts.title, body: opts.body, choices: [{ key: "yes", label: opts.yes, primary: !opts.danger, danger: opts.danger }] })) === "yes";
}

export function ConfirmHost() {
  const { t } = useT();
  const a = ask.use();
  useEffect(() => () => ask.get()?.resolve(null), []);
  if (!a) return null;
  const done = (v: string | null) => {
    a.resolve(v);
    ask.set(null);
  };
  return (
    <Dialog title={a.title} onClose={() => done(null)}>
      <p className="whitespace-pre-line text-sm">{a.body}</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => done(null)}>
          {t("cancel")}
        </Button>
        {a.choices.map((c, i) => (
          <Button key={c.key} variant={c.danger ? "danger" : c.primary ? "primary" : "outline"} autoFocus={i === a.choices.length - 1} onClick={() => done(c.key)}>
            {c.label}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}
