// Moving an item (with what hangs only below it) from the open workspace into another one – on
// the same server or another. The file contents come first: once they are kept for the other
// workspace (on this device, uploaded from there), the copy is written (copyToWorkspace) and the
// originals go to the trash here. Each workspace keeps its own undo: here "Wiederherstellen".
import type { Repo } from "@obtion/sync";
import { SETTINGS_ID } from "@obtion/core/model";
import { copyToWorkspace, movedItems } from "@obtion/core/transfer";
import { deleteItem } from "@obtion/core/trash";
import { type Space, activate, replica } from "./accounts";
import { files } from "./files";
import { repo } from "./repo";
import { itemHref } from "./hooks";

export class MoveError extends Error {}

/** A replica that has caught up with its server (so its types are known); offline with data is enough too. */
async function ready(r: Repo, ms = 10000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (r.status.synced || (r.status.loaded && !r.status.online && r.docs.size > 0)) return true;
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

/**
 * Move `id` from the open workspace into `to`: below `parent` there, else without a place (its
 * inbox or its type's list). Returns the new id there.
 */
export async function moveToSpace(id: string, to: Space, parent?: string): Promise<string> {
  const src = repo;
  const srcFiles = files;
  const dst = replica(to.key);
  if (!(await ready(dst.repo))) throw new MoveError("unreachable");
  // never set up: its setup would add the shipped types a second time next to the moved ones
  if (!dst.repo.get(SETTINGS_ID)) throw new MoveError("setup");
  const items = movedItems(src.index(), id);
  // the contents first: without them the copy would show "Datei fehlt"
  for (const it of items) {
    const f = it.file;
    if (!f) continue;
    for (const [hash, derived] of [[f.hash, false], [f.display, true], [f.thumb, true]] as const) {
      if (!hash) continue;
      const blob = await srcFiles.content(hash);
      if (!blob && !derived) throw new MoveError("file");
      if (blob) await dst.files.adopt(hash, blob, derived ? "preview.webp" : f.name, derived);
    }
  }
  const moved = copyToWorkspace(src.index(), id, { w: dst.repo.writer, ix: dst.repo.index() }, { parent }, `web:${src.device}`);
  deleteItem(src.writer, src.index(), id);
  return moved.ids.get(id)!;
}

/** Open the moved item in its new workspace. */
export function openIn(to: Space, id: string) {
  activate(to.key);
  location.hash = itemHref(id);
}
