// "Neuer Typ": a name, then the type's page with "Typ bearbeiten" over it.
import { Input } from "../components/ui/input";
import { useState } from "react";
import { useRepo, useSpaceId } from "../hooks";
import { useT } from "../i18n";
import { Button, Dialog } from "../ui/primitives";
import { createType } from "../actions";
import { SpaceScope } from "../ui/Spaces";
import { closeNewType, editType, useNewTypeOpen } from "../ui/type-edit";

/** The "Neuer Typ" dialog, while it is open (openNewType). Lives once in the app. */
export function NewTypeHost() {
  const space = useNewTypeOpen();
  return space ? (
    <SpaceScope id={space}>
      <NewTypeDialog onClose={closeNewType} />
    </SpaceScope>
  ) : null;
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
    else editType(id, { space });
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
