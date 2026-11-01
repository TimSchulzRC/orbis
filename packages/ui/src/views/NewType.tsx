// "Neuer Typ" as a dialog over the page that is open: from the "…" next to "Typen" in the
// sidebar and from the palette. The types themselves are listed in the sidebar.
import { Input } from "../components/ui/input";
import { useState, useSyncExternalStore } from "react";
import { restoreDefaultTypes } from "@obtion/core/setup";
import type { Repo } from "@obtion/sync";
import { useRepo, useSpaceId, openItem } from "../hooks";
import { useT, getLang, tr } from "../i18n";
import { Button, Dialog } from "../ui/primitives";
import { SpaceScope } from "../ui/Spaces";
import { notify } from "../ui/toasts";
import { createType } from "../actions";

let open: string | null = null; // the workspace the new type goes into
const listeners = new Set<() => void>();
const set = (next: string | null) => ((open = next), listeners.forEach((f) => f()));

/** Opens "Neuer Typ" for workspace `space`. */
export const openNewType = (space: string) => set(space);
export const closeNewType = () => set(null);
/** The workspace "Neuer Typ" is open for, or null. */
export const newTypeOpen = () => open;

/** The dialog, when it is open – in the workspace it was opened for. */
export function NewTypeHost() {
  const space = useSyncExternalStore((f) => (listeners.add(f), () => listeners.delete(f)), newTypeOpen);
  if (!space) return null;
  return (
    <SpaceScope id={space}>
      <NewTypeDialog onClose={closeNewType} />
    </SpaceScope>
  );
}

/** Creates the missing default types and brings back deleted ones; says what it did. */
export function restoreTypes(repo: Repo) {
  const n = restoreDefaultTypes(repo.writer, getLang(), repo.origin).length;
  notify(tr("types.restored", { count: n }));
}

/** Without `onCreated` the type's page opens with "Typ bearbeiten". */
export function NewTypeDialog({ title, onClose, onCreated }: { title?: string; onClose: () => void; onCreated?: (id: string) => void }) {
  const { t } = useT();
  const repo = useRepo();
  const space = useSpaceId();
  const [name, setName] = useState("");
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = createType(trimmed, repo);
    onClose();
    if (onCreated) onCreated(id);
    else openItem(id, { space, query: "?edit=1" });
  };
  return (
    <Dialog title={title ?? t("types.new")} onClose={onClose}>
      <form onSubmit={create}>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("type.name")} />
        <div className="mt-4 flex justify-end">
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {t("types.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
