import type { Item } from "@orbis/core/model";
import { canPlaceIn } from "@orbis/core/placement";
import type { Repo } from "@orbis/sync";
import { repo as current } from "../repo";

/** Why the picker suggests an entry ("picker.reason.*"). */
export type PickReason = "agent" | "mentioned" | "parent" | "similar" | "target" | "recent";

export function placeSuggestions(
	item: Item,
	repo: Repo = current,
): { id: string; reason: Exclude<PickReason, "target" | "recent"> }[] {
	const ix = repo.index();
	const out: ReturnType<typeof placeSuggestions> = [];
	const add = (id: string | undefined, reason: (typeof out)[number]["reason"]) => {
		const target = ix.get(id);
		if (target && !out.some((o) => o.id === target.id) && canPlaceIn(item, target, ix))
			out.push({ id: target.id, reason });
	};
	for (const p of item.suggestion?.parents ?? []) add(p, "agent");
	const mentioned = [...ix.textLinks(item).map((l) => l.to), ...item.refs];
	for (const m of mentioned) add(m, "mentioned");
	for (const m of mentioned) for (const p of ix.parentsOf(m)) add(p, "parent");
	const words = item.title
		.split(/\s+/)
		.filter((w) => w.length > 3)
		.slice(0, 6)
		.join(" ");
	if (words)
		for (const hit of repo.search(words, 20))
			if (
				hit.kind === "note" &&
				ix.childrenOf(hit.id).length > 0 &&
				out.filter((o) => o.reason === "similar").length < 2
			)
				add(hit.id, "similar");
	return out.slice(0, 8);
}
