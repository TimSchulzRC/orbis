import type { Item } from "@orbis/core/model";
import { isInInbox } from "@orbis/core/placement";
import { cascadeCount, trashRoots } from "@orbis/core/trash";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useAccounts } from "../accounts";
import { useDocumentTitle, useItemHref, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { confirmAction, notify } from "../ui/feedback";
import { ItemIcon, RelTime } from "../ui/item-look";
import { Button, Empty } from "../ui/primitives";
import { SpaceFilter, SpaceScope, useReplicas } from "../ui/Spaces";

export function TrashView() {
	const { t } = useT();
	const { spaces } = useAccounts();
	useDocumentTitle(t("nav.trash"));
	// its own choice of workspaces; null: all
	const [only, setOnly] = useState<string[] | null>(null);
	const chosen = spaces.filter((s) => !only || only.includes(s.id));
	const repos = useReplicas(chosen.map((s) => s.id));
	const items = chosen
		.flatMap((s, n) => trashRoots(repos[n]!.records).map((item) => ({ item, space: s })))
		.sort((a, b) => b.item.updated - a.item.updated);
	const emptyAll = async () => {
		if (
			!(await confirmAction({
				title: t("trash.emptyConfirm"),
				body: t("trash.emptyHint", { count: items.length }),
				yes: t("trash.emptyAll"),
				danger: true,
			}))
		)
			return;
		const done = await Promise.all(repos.map((r) => r.purge({ all: true })));
		if (done.includes(false)) notify(t("trash.purgeFailed"));
	};
	return (
		<div className="page-read">
			<div className="flex items-center justify-between gap-3">
				<h1 className="mb-1 page-title">{t("nav.trash")}</h1>
				{items.length > 0 && (
					<Button onClick={emptyAll} variant="danger">
						<Trash2 size={14} /> {t("trash.emptyAll")}
					</Button>
				)}
			</div>
			<p className="mb-5 text-sm text-muted-foreground">{t("trash.intro")}</p>
			<SpaceFilter onChange={setOnly} value={only} />
			{items.length ? (
				<ul className="divide-y divide-line rounded-xl border border-line bg-surface">
					{items.map(({ item, space }) => (
						<li className="flex items-center gap-3 px-3 py-2" key={`${space.id}:${item.id}`}>
							<SpaceScope id={space.id}>
								<TrashRow item={item} space={spaces.length > 1 ? space.name : undefined} />
							</SpaceScope>
						</li>
					))}
				</ul>
			) : (
				<Empty title={t("trash.empty")} />
			)}
		</div>
	);
}

/** `space`: the workspace's name, with several. */
function TrashRow({ item, space }: { item: Item; space?: string }) {
	const repo = useRepo();
	const itemHref = useItemHref();
	const { t } = useT();
	// where it was: its home and the homes above (so two "R&S" in the trash can be told apart)
	const path: string[] = [];
	let id = item.home ?? Object.keys(item.parents)[0];
	for (let n = 0; id && n < 4; n++) {
		const place = repo.records.get(id);
		if (!place) break;
		path.unshift(titleOf(place, t));
		id = place.home ?? Object.keys(place.parents)[0];
	}
	const where = [space, path.join(" › ")].filter(Boolean).join(" · ");
	const children = cascadeCount(repo.records, item.id);
	const restore = () => {
		repo.restore(item.id);
		// say where it went once the index has it back
		setTimeout(() => {
			const ix = repo.index();
			const now = ix.get(item.id);
			const home = now ? ix.homePath(item.id) : [];
			const title = titleOf(item, t);
			if (home.length) notify(t("trash.restoredUnder", { title, place: ix.pathText(home) }));
			else
				notify(
					now && isInInbox(now, ix)
						? t("trash.restoredInbox", { title })
						: t("trash.restored", { title }),
				);
		}, 50);
	};
	const purge = async () => {
		if (
			!(await confirmAction({
				title: t("trash.purgeConfirm", { title: titleOf(item, t) }),
				body: t("trash.purgeHint"),
				yes: t("trash.purge"),
				danger: true,
			}))
		)
			return;
		if (!(await repo.purge({ id: item.id }))) notify(t("trash.purgeFailed"));
	};
	return (
		<>
			<ItemIcon item={item} size={15} />
			<span className="flex min-w-0 flex-1 flex-col">
				<a className="truncate hover:underline" href={itemHref(item.id)}>
					{titleOf(item, t)}
				</a>
				{where && <span className="truncate text-xs text-muted-foreground">{where}</span>}
			</span>
			{children > 0 && (
				<span className="text-xs text-muted-foreground">
					{t("trash.withChildren", { count: children })}
				</span>
			)}
			<span className="text-xs text-muted-foreground">
				<RelTime ts={item.updated} />
			</span>
			<Button onClick={restore}>
				<RotateCcw size={14} /> {t("item.restore")}
			</Button>
			<Button
				aria-label={t("trash.purge")}
				className="px-2"
				onClick={purge}
				title={t("trash.purge")}
				variant="danger"
			>
				<Trash2 size={14} />
			</Button>
		</>
	);
}
