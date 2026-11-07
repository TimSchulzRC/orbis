// A type is an information with a schema; changing it is editing, not programming.
import { useEffect } from "react";
import { Pencil, Pin, RotateCcw } from "lucide-react";
import { type Item, setTabs } from "@obtion/core/model";
import { useIndex, useDocumentTitle, useRepo, useSpaceId } from "../hooks";
import { useT } from "../i18n";
import { MenuItem, MoreMenu, PagePlaceholder } from "../ui/primitives";
import { TypeGlyph } from "../ui/item-look";
import { TypeList } from "./Lists";
import { notify } from "../ui/feedback";
import { SpaceScope } from "../ui/Spaces";
import { closeTypeEditor, editType, useTypeEditing } from "../ui/type-edit";
import { TypeEditor } from "./TypeEditor";

export function TypePage({ item }: { item: Item }) {
  const repo = useRepo();
  const { t } = useT();
  const ix = useIndex();
  const space = useSpaceId();
  const plural = ix.typePlural(item.id);
  useDocumentTitle(plural);
  if (item.deleted) return <PagePlaceholder>{t("type.isDeleted", { name: item.schema!.name })}</PagePlaceholder>;
  return (
    <div className="page-wide">
      <div className="mb-4 flex items-center gap-3">
        <TypeGlyph schema={item.schema} size={22} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="page-title truncate">{plural}</h1>
          <span className="text-[15px] tabular-nums text-muted-foreground">{ix.itemsOfType(item.id).length}</span>
        </div>
        <MoreMenu>
          {(close) => (
            <>
              <MenuItem icon={<Pencil size={14} />} onClick={() => (close(), editType(item.id, space))}>
                {t("type.edit")}
              </MenuItem>
              <MenuItem icon={<Pin size={14} />} onClick={() => (close(), repo.pin(item.id, !item.pinned))}>
                {item.pinned ? t("item.unpin") : t("item.pin")}
              </MenuItem>
              <MenuItem icon={<RotateCcw size={14} />} onClick={() => (close(), repo.change(item.id, (d) => setTabs(d, [])), notify(t("type.viewsReset")))}>
                {t("type.resetViews")}
              </MenuItem>
            </>
          )}
        </MoreMenu>
      </div>
      <TypeList type={item} />
    </div>
  );
}

/** "Typ bearbeiten" while it is open (editType), over the page that is open. Lives once in the app. */
export function TypeEditorHost() {
  const editing = useTypeEditing();
  if (!editing) return null;
  const editor = <OpenTypeEditor id={editing.id} />;
  return editing.space ? <SpaceScope id={editing.space}>{editor}</SpaceScope> : editor;
}

/** The editor of type `id`; a type that is gone (deleted, not synced) closes it. */
function OpenTypeEditor({ id }: { id: string }) {
  const item = useRepo().get(id);
  const gone = !item?.schema || item.deleted;
  useEffect(() => void (gone && closeTypeEditor()), [gone]);
  return gone ? null : <TypeEditor key={id} item={item} onClose={closeTypeEditor} />;
}
