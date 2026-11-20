// Moving an item (and what hangs only below it) to another workspace. The originals go to the
// source's trash, so each workspace keeps its own undo.

import { drawingImages } from "@obtion/core/drawing";
import { SETTINGS_ID } from "@obtion/core/model";
import { sidebarRoots } from "@obtion/core/placement";
import { keyBetween } from "@obtion/core/sortkey";
import { copyToWorkspace, type MovePlan, movedItems, planMove } from "@obtion/core/transfer";
import { deleteItem } from "@obtion/core/trash";
import type { Repo } from "@obtion/sync";
import { replica } from "./accounts";

export class MoveError extends Error {}

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;

/** Caught up with the server so its types are known; offline with local data is enough too. */
async function ready(repo: Repo, ms = READY_TIMEOUT_MS): Promise<boolean> {
	for (let waited = 0; waited < ms; waited += READY_POLL_MS) {
		if (repo.status.synced || (repo.status.loaded && !repo.status.online && repo.hasData))
			return true;
		await new Promise((res) => setTimeout(res, READY_POLL_MS));
	}
	return false;
}

async function checkTarget(dst: Repo) {
	if (!(await ready(dst))) throw new MoveError("unreachable");
	// its later setup would add the shipped types a second time next to the moved ones
	if (!dst.get(SETTINGS_ID)) throw new MoveError("setup");
}

type Replica = ReturnType<typeof replica>;

/** Before the items, or the copy would show "file missing". */
async function copyContents(items: ReturnType<typeof movedItems>, src: Replica, dst: Replica) {
	for (const it of items) {
		const f = it.file;
		if (!f) continue;
		for (const [hash, derived] of [
			[f.hash, false],
			[f.display, true],
			[f.thumb, true],
		] as const) {
			if (!hash) continue;
			const blob = await src.files.content(hash);
			if (!blob && !derived) throw new MoveError("file");
			if (blob) await dst.files.adopt(hash, blob, derived ? "preview.webp" : f.name, derived);
		}
	}
	// the images in a note's drawings; one not on this device yet shows as a placeholder there
	for (const hash of new Set(items.flatMap((it) => drawingImages(it.drawings)))) {
		const blob = await src.files.content(hash);
		if (blob) await dst.files.adopt(hash, blob, "drawing-image", false);
	}
}

export async function planToSpace(id: string, from: string, to: string): Promise<MovePlan> {
	const dst = replica(to).repo;
	await checkTarget(dst);
	return planMove(replica(from).repo.index(), id, dst.index());
}

/**
 * Without `parent` a pinned item stays pinned (at the end), any other lands without a place.
 * Returns the new id in `to`.
 */
export async function moveToSpace(
	id: string,
	from: string,
	to: string,
	parent?: string,
): Promise<string> {
	const src = replica(from);
	const dst = replica(to);
	await checkTarget(dst.repo);
	await copyContents(movedItems(src.repo.index(), id), src, dst);
	const ix = dst.repo.index();
	const keepPinned = !parent && src.repo.get(id)?.pinned;
	const pinned = keepPinned ? keyBetween(sidebarRoots(ix).at(-1)?.pinned ?? null, null) : undefined;
	const moved = copyToWorkspace(
		src.repo.index(),
		id,
		{ w: dst.repo.writer, ix },
		{ parent, pinned },
		src.repo.origin,
		(id) => src.repo.getDoc(id),
	);
	deleteItem(src.repo.writer, src.repo.index(), id);
	return moved.ids.get(id)!;
}
