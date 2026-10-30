import { Input } from "../components/ui/input";
import { useState } from "react";
import { Plus, RotateCcw } from "lucide-react";
import { restoreDefaultTypes } from "@obtion/core/setup";
import { useIndex, useRepo, useRoute, useSpaceId, itemHref, spaceHref, openItem } from "../hooks";
import { repo } from "../repo";
import { SpaceEyebrow } from "../ui/Spaces";
import { useT, getLang } from "../i18n";
import { Card, Button, Dialog } from "../ui/primitives";
import { TypeGlyph } from "../ui/item-look";
import { createType } from "../actions";

/** All types. New types are data: name, then properties and capabilities in the editor. */
export function TypesView() {
  const { t } = useT();
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
        {types.map((tp) => (
          <a key={tp.id} href={itemHref(tp.id)} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-hover">
            <TypeGlyph schema={tp.schema} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{tp.schema.name}</span>
              {tp.schema.description && <span className="block truncate text-xs text-muted-foreground">{tp.schema.description}</span>}
            </span>
            <span className="text-xs text-muted-foreground">{t("type.entries", { count: ix.itemsOfType(tp.id).length })}</span>
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

/** "Neuer Typ": a name; the type's page opens with "Typ bearbeiten". */
export function NewTypeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const repo = useRepo();
  const space = useSpaceId();
  const [name, setName] = useState("");
  const create = () => {
    const n = name.trim();
    if (!n) return;
    const id = createType(n, repo);
    onClose();
    openItem(id, { space, query: "?edit=1" });
  };
  return (
    <Dialog title={t("types.new")} onClose={onClose}>
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder={t("type.name")} />
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={create} disabled={!name.trim()}>
          {t("types.create")}
        </Button>
      </div>
    </Dialog>
  );
}
