// Moving an item (with what hangs only below it) from one workspace into another. The file
// contents come first: once they are kept for the other workspace (on this device, uploaded from
// there), the copy is written (copyToWorkspace) and the originals go to the trash where they were.
// Each workspace keeps its own undo: there "Wiederherstellen".
import type { Repo } from "@obtion/sync";
import { SETTINGS_ID } from "@obtion/core/model";
import { sidebarRoots } from "@obtion/core/placement";
import { keyBetween } from "@obtion/core/sortkey";
import { type MovePlan, copyToWorkspace, movedItems, planMove } from "@obtion/core/transfer";
import { deleteItem } from "@obtion/core/trash";
import { replica } from "./accounts";

export class MoveError extends Error {}

/** A replica that has caught up with its server (so its types are known); offline with data is enough too. */
async function ready(r: Repo, ms = 10000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (r.status.synced || (r.status.loaded && !r.status.online && r.docs.size > 0)) return true;
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

/** What moving `id` from workspace `from` into `to` would change on the way. */
export async function planToSpace(id: string, from: string, to: string): Promise<MovePlan> {
  const dst = replica(to).repo;
  if (!(await ready(dst))) throw new MoveError("unreachable");
  // never set up: its setup would add the shipped types a second time next to the moved ones
  if (!dst.get(SETTINGS_ID)) throw new MoveError("setup");
  return planMove(replica(from).repo.index(), id, dst.index());
}

/**
 * Move `id` from workspace `from` into `to`: below `parent` there; else pinned at the end if it
 * was pinned, otherwise without a place (its inbox or its type's list). Returns the new id there.
 */
export async function moveToSpace(id: string, from: string, to: string, parent?: string): Promise<string> {
  const src = replica(from);
  const dst = replica(to);
  if (!(await ready(dst.repo))) throw new MoveError("unreachable");
  if (!dst.repo.get(SETTINGS_ID)) throw new MoveError("setup");
  const items = movedItems(src.repo.index(), id);
  // the contents first: without them the copy would show "Datei fehlt"
  for (const it of items) {
    const f = it.file;
    if (!f) continue;
    for (const [hash, derived] of [[f.hash, false], [f.display, true], [f.thumb, true]] as const) {
      if (!hash) continue;
      const blob = await src.files.content(hash);
      if (!blob && !derived) throw new MoveError("file");
      if (blob) await dst.files.adopt(hash, blob, derived ? "preview.webp" : f.name, derived);
    }
  }
  const ix = dst.repo.index();
  const pinned = !parent && src.repo.get(id)?.pinned ? keyBetween(sidebarRoots(ix).at(-1)?.pinned ?? null, null) : undefined;
  const moved = copyToWorkspace(src.repo.index(), id, { w: dst.repo.writer, ix }, { parent, pinned }, `web:${src.repo.device}`);
  deleteItem(src.repo.writer, src.repo.index(), id);
  return moved.ids.get(id)!;
}
