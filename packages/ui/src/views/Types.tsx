import { Input } from "../components/ui/input";
import { useState } from "react";
import { Plus, RotateCcw } from "lucide-react";
import { restoreDefaultTypes } from "@obtion/core/setup";
import { useIndex, useRepo, useRoute, useSpaceId, itemHref, openItem, useDocumentTitle } from "../hooks";
import { SpaceEyebrow } from "../ui/Spaces";
import { useT, getLang } from "../i18n";
import { Card, Button, Dialog } from "../ui/primitives";
import { TypeGlyph } from "../ui/item-look";
import { createType } from "../actions";

export function TypesView() {
  const repo = useRepo();
  const { t } = useT();
  useDocumentTitle(t("nav.types"));
  const ix = useIndex();
  const route = useRoute();
  const [creating, setCreating] = useState(route.query.get("new") === "1");
  const types = ix.typesByName();
  return (
    <div className="page-read">
      <div className="mb-5 flex items-end gap-3">
        <div className="flex-1">
          <SpaceEyebrow />
          <h1 className="page-title">{t("nav.types")}</h1>
          <p className="text-sm text-muted-foreground">{t("types.intro")}</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} /> {t("types.new")}
        </Button>
      </div>
      <Card className="p-1">
        {types.map((type) => (
          <a key={type.id} href={itemHref(type.id)} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-hover">
            <TypeGlyph schema={type.schema} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{type.schema.name}</span>
              {type.schema.description && <span className="block truncate text-xs text-muted-foreground">{type.schema.description}</span>}
            </span>
            <span className="text-xs text-muted-foreground">{t("type.entries", { count: ix.itemsOfType(type.id).length })}</span>
          </a>
        ))}
        {!types.length && <p className="px-3 py-3 text-sm text-muted-foreground">{t("types.none")}</p>}
      </Card>
      <Button variant="outline" className="mt-4" onClick={() => restoreDefaultTypes(repo.writer, getLang(), repo.origin)}>
        <RotateCcw size={14} /> {t("types.restore")}
      </Button>
      <p className="mt-1 text-xs text-muted-foreground">{t("types.restoreHint")}</p>
      {creating && <NewTypeDialog onClose={() => setCreating(false)} />}
    </div>
  );
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
