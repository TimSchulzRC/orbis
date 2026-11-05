// A drawing's page: like a note's (place, title, tags, links, "Darunter"), with the drawing where the
// text would be. Drawing happens full screen.
import { useState } from "react";
import { Eye, FilePlus, FolderInput, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { useDocumentTitle, useIndex, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { Button, MenuItem, MoreMenu } from "../ui/primitives";
import { PropertyBlock } from "../ui/Properties";
import { Below } from "../ui/Sections";
import { AddRef, Crumbs, LinksMenu, LinksRow, PageFooter, TrashBanner, pinnedRefs } from "../ui/PageParts";
import { PlacePicker } from "../ui/Picker";
import { TitleField } from "../ui/TitleField";
import { createAndOpen, rememberPlace } from "../actions";
import { DRAWING_ICON } from "../ui/icons";
import { DeleteDialog, deleteOrAsk } from "./ItemPage";
import { DrawingPreview, createDrawing, openDrawing } from "../drawing/Drawing";

export function DrawingPage({ item }: { item: Item }) {
  const repo = useRepo();
  const ix = useIndex();
  const { t } = useT();
  useDocumentTitle(titleOf(item, t));
  const [placing, setPlacing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const drawn = !!item.drawing?.count;

  const tools = (
    <MoreMenu>
      {(close) => (
        <>
          <MenuItem icon={<FolderInput size={14} />} onClick={() => (close(), setPlacing(true))}>
            {ix.parentsOf(item.id).length ? t("place.addAnother") : t("place.place")}
          </MenuItem>
          <MenuItem icon={item.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => (close(), repo.pin(item.id, !item.pinned))}>
            {item.pinned ? t("item.unpin") : t("item.pin")}
          </MenuItem>
          <MenuItem icon={<FilePlus size={14} />} onClick={() => (close(), createAndOpen({ parents: [item.id] }))}>
            {t("item.newBelow")}
          </MenuItem>
          <MenuItem icon={<DRAWING_ICON size={14} />} onClick={() => (close(), createDrawing({ parents: [item.id] }))}>
            {t("drawing.newBelow")}
          </MenuItem>
          {!item.deleted && (
            <MenuItem danger icon={<Trash2 size={14} />} onClick={() => (close(), deleteOrAsk(repo, item.id, () => setDeleting(true)))}>
              {t("item.delete")}
            </MenuItem>
          )}
        </>
      )}
    </MoreMenu>
  );

  return (
    <div className="page-read">
      {item.deleted && <TrashBanner onRestore={() => repo.restore(item.id)} />}
      <Crumbs item={item} tools={tools} onPlace={() => setPlacing(true)} />
      <div className="mt-6 flex items-start gap-4 max-md:mt-3">
        <div data-page-title className="min-w-0 flex-1 rounded-lg">
          <TitleField item={item} autoFocus={false} placeholder={t("drawing.untitled")} />
        </div>
      </div>
      <div className="mt-3 border-t border-line" />
      <PropertyBlock
        item={item}
        head={{
          first: (
            <span className="inline-flex items-center gap-1 px-0.5 text-[13px] text-muted-foreground">
              <DRAWING_ICON size={12} style={{ color: "var(--t-drawing)" }} /> {t("kind.drawing")}
            </span>
          ),
          afterTags: !pinnedRefs(item, ix).length && <AddRef item={item} text />,
          end: <LinksMenu item={item} />,
          links: <LinksRow item={item} />,
        }}
      />

      <div className="mt-6 flex items-center gap-2">
        {!item.deleted && (
          <Button onClick={() => openDrawing(item.id)} className="gap-1.5">
            <Pencil size={14} /> {t("drawing.edit")}
          </Button>
        )}
        {drawn && (
          <Button variant="outline" onClick={() => openDrawing(item.id, { view: true })} className="gap-1.5">
            <Eye size={14} /> {t("drawing.view")}
          </Button>
        )}
        {item.drawing && item.drawing.count > 0 && <span className="ml-auto text-xs text-muted-foreground">{t("drawing.elements", { count: item.drawing.count })}</span>}
      </div>
      <DrawingPreview item={item} className="mt-3" onOpen={() => openDrawing(item.id, { view: drawn })} />

      <div className="mt-7 border-t border-line" />
      <div className="page-below [&>:first-child]:mt-6">
        <Below item={item} />
      </div>
      <PageFooter item={item} className="mt-10 border-t border-line pt-4 max-md:mt-8 [.page-below:empty+&]:mt-4 [.page-below:empty+&]:border-t-0 [.page-below:empty+&]:pt-0" />

      {placing && <PlacePicker list={[item]} title={t("place.add")} onPick={(pid) => (repo.addParent(item.id, pid), rememberPlace(pid), setPlacing(false))} onClose={() => setPlacing(false)} />}
      {deleting && <DeleteDialog item={item} onClose={() => setDeleting(false)} />}
    </div>
  );
}
