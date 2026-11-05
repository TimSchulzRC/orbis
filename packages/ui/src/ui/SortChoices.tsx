// The inbox's choices for one note: "Einsortieren", "Typ", "Morgen", "Anheften" and, where offered,
// "Löschen". The inbox's card and the quick note show the same row.
import type { ReactNode } from "react";
import { Clock, FolderInput, Pin, Shapes, Trash2, Undo2 } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { useT } from "../i18n";
import { Button, Kbd } from "./primitives";
import { cn } from "../lib/utils";

/**
 * The buttons stay the same and in the same place for every entry. `keys`: their key hints, which go
 * invisible while `quiet` (the note is edited), keeping their room so nothing moves. `waiting`: one back
 * tomorrow comes back now instead of "Morgen". Without `onTrash` there is no "Löschen".
 */
export function SortChoices({ item, waiting, onPick, onTypes, onLater, onPin, onTrash, keys, quiet, className }: { item: Item; waiting?: boolean; onPick: () => void; onTypes: () => void; onLater: () => void; onPin: () => void; onTrash?: () => void; keys: boolean; quiet: boolean; className?: string }) {
  const { t } = useT();
  const info = item.kind === "info";
  const hint = (key: string) => keys && <span className={cn("hidden @[600px]:inline-flex", quiet && "invisible")}><Kbd>{key}</Kbd></span>;
  const tile = (icon: ReactNode, label: string, key: string, onClick: () => void, opts: { primary?: boolean; danger?: boolean; disabled?: boolean; wide?: boolean } = {}) => (
    <Button
      variant="plain"
      onClick={onClick}
      disabled={opts.disabled}
      // delete on a desktop is only its icon: the name and key on hover
      title={opts.danger && keys ? `${label} (${key})` : undefined}
      className={cn(
        "tap flex h-9 min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-[13px] font-medium disabled:opacity-40",
        opts.primary ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90" : "border-line bg-surface hover:bg-hover",
        (opts.primary || opts.wide) && "max-lg:col-span-2",
        opts.danger && "text-danger lg:w-9 lg:flex-none lg:justify-center lg:px-0",
      )}
    >
      {icon}
      <span className={cn("min-w-0 flex-1 truncate px-1 text-center", opts.danger && "lg:sr-only")}>{label}</span>
      {!opts.danger && hint(key)}
    </Button>
  );
  return (
    <div className={cn("@container flex shrink-0 gap-2 max-lg:grid max-lg:grid-cols-2", className)}>
      {tile(<FolderInput size={15} />, t("review.placeAction"), "e", onPick, { primary: true })}
      {tile(<Shapes size={15} />, t("review.convertAction"), "y", onTypes, { disabled: !info })}
      {waiting ? tile(<Undo2 size={15} />, t("review.backAction"), "s", onLater) : tile(<Clock size={15} />, t("review.laterAction"), "s", onLater)}
      {/* on a phone two to a row: without "Löschen" beside it, the last one takes the row */}
      {tile(<Pin size={15} />, t("review.pin"), "a", onPin, { wide: !onTrash })}
      {onTrash && tile(<Trash2 size={15} />, t("triage.delete"), "x", onTrash, { danger: true })}
    </div>
  );
}
