import type { Item } from "@obtion/core/model";
import { snippet } from "@obtion/core/search";
import { statusOf } from "@obtion/core/traits";
import { ChevronRight, CornerDownLeft, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAccounts } from "../accounts";
import { createAndOpen } from "../actions";
import { Backdrop, ModalSurface } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { itemPath, openItem, spaceHref } from "../hooks";
import { getLang, setLang, titleOf, useT } from "../i18n";
import { modName } from "../lib/platform";
import { cn } from "../lib/utils";
import { setTheme } from "../theme";
import { openShelf } from "./inbox";
import { InTray, ItemIcon, StatusPill, TypeGlyph } from "./item-look";
import { Button } from "./primitives";
import { captureSpace } from "./QuickNote";
import { shortPath } from "./Row";
import { useReplicas } from "./Spaces";
import { openSettings } from "./settings-open";
import { openNewType } from "./type-edit";

/** Search hits shown for a query. The palette is the only search, so it lists more than fit at once. */
const MAX_HITS = 30;
/** Recently changed items shown before anything is typed. */
const RECENT_COUNT = 8;

type Entry =
	| { kind: "item"; id: string; space: string }
	| { kind: "create"; type: string | null; title: string }
	| { kind: "nav"; label: string; path: string }
	| { kind: "cmd"; label: string; run: () => void };

const keyOf = (it: Entry) => {
	if (it.kind === "item") return `item:${it.space}:${it.id}`;
	if (it.kind === "create") return `create:${it.type ?? ""}`;
	if (it.kind === "nav") return `nav:${it.path}`;
	return `cmd:${it.label}`;
};

export function CommandPalette({
	query: initial = "",
	onClose,
}: {
	query?: string;
	onClose: () => void;
}) {
	const { t, lang } = useT();
	const [q, setQ] = useState(initial);
	const [sel, setSel] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const { shown } = useAccounts();
	const repos = useReplicas(shown.map((s) => s.id));
	const repoOf = (space: string) => repos[shown.findIndex((s) => s.id === space)] ?? repos[0]!;
	const several = shown.length > 1;
	const nameOf = (space: string) => shown.find((s) => s.id === space)?.name ?? "";
	const navs = [
		[t("nav.today"), "#/"],
		[t("nav.inbox"), "#/inbox"],
		...shown.flatMap((s, n) => {
			const ix = repos[n]!.index();
			const of = (label: string) => (several ? `${label} · ${s.name}` : label);
			return [
				...ix.typesInOrder().map((x) => [of(ix.typePlural(x.id)), spaceHref(s.id, itemPath(x.id))]),
				[of(t("nav.files")), spaceHref(s.id, "/files")],
				[of(t("nav.graph")), spaceHref(s.id, "/graph")],
				[of(t("space.settings")), spaceHref(s.id, "/settings")],
			];
		}),
		[t("nav.activity"), "#/activity"],
		[t("nav.trash"), "#/trash"],
	];
	const captureIn = captureSpace() ?? shown[0]!.id;
	const repo = repoOf(captureIn);
	const ix = repo.index();
	const pinnedTypes = ix.captureTypes();
	const captureTypes = [
		...pinnedTypes,
		...ix
			.typesByName()
			.filter((x) => !pinnedTypes.includes(x.id))
			.map((x) => x.id),
	];
	const cmds: [string, () => void][] = [
		[t("palette.cmd.sortInbox"), () => openShelf()],
		[t("nav.settings"), openSettings],
		[t("palette.cmd.newType"), () => openNewType(captureIn)],
		[t("palette.cmd.language"), () => setLang(getLang() === "de" ? "en" : "de")],
		...(["system", "light", "dark"] as const).map((v): [string, () => void] => [
			t("palette.cmd.theme", { name: t(`theme.${v}`) }),
			() => setTheme(v),
		]),
	];

	const items: Entry[] = (() => {
		const out: Entry[] = [];
		const query = q.trim();
		const lq = query.toLowerCase();
		const matches = (label: string) =>
			label
				.toLowerCase()
				.split(/\s+/)
				.some((w) => w.startsWith(lq)) || label.toLowerCase().startsWith(lq);
		const toNav = ([label, path]: string[]) => ({
			kind: "nav" as const,
			label: label!,
			path: path!,
		});
		out.push(...navs.filter(([label]) => query && matches(label!)).map(toNav));
		if (query)
			out.push(
				...cmds
					.filter(([label]) => matches(label))
					.map(([label, run]) => ({ kind: "cmd" as const, label, run })),
			);
		// interleave the workspaces' hits, since each list is ranked by its own search
		const perSpace = repos.map((spaceRepo, n) =>
			(query ? spaceRepo.search(query, MAX_HITS) : spaceRepo.live()).map((h) => ({
				h,
				space: shown[n]!.id,
			})),
		);
		const hits: { h: Item; space: string }[] = query
			? Array.from({ length: MAX_HITS }, (_, i) => perSpace.map((list) => list[i]))
					.flat()
					.filter((x) => !!x)
					.slice(0, MAX_HITS)
			: perSpace
					.flat()
					.sort((a, b) => b.h.updated - a.h.updated)
					.slice(0, RECENT_COUNT);
		out.push(...hits.map(({ h, space }) => ({ kind: "item" as const, id: h.id, space })));
		if (query)
			out.push(
				...[null, ...captureTypes].map((type) => ({ kind: "create" as const, type, title: query })),
			);
		else out.push(...navs.map(toNav));
		return out;
	})();

	useEffect(() => {
		listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
	}, [sel]);

	const run = (it: Entry) => {
		onClose();
		if (it.kind === "item") openItem(it.id, { space: it.space });
		else if (it.kind === "create")
			createAndOpen({ type: it.type, title: it.title }, repo, captureIn);
		else if (it.kind === "nav") location.hash = it.path;
		else if (it.kind === "cmd") it.run();
	};

	return (
		<ModalSurface onClose={onClose} title={t("palette.label")}>
			<Backdrop
				className="flex items-start justify-center p-3 pt-[10vh]"
				onMouseDown={(e) => {
					// only a press beside the panel closes it
					if (e.target === e.currentTarget) onClose();
				}}
			>
				<div className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
					<Input
						autoFocus
						className="border-b border-line bg-transparent px-4 py-3.5 text-base outline-none placeholder:text-muted-foreground"
						onChange={(e) => {
							setQ(e.target.value);
							setSel(0);
						}}
						onKeyDown={(e) => {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setSel((s) => Math.min(items.length - 1, s + 1));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setSel((s) => Math.max(0, s - 1));
							} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && q.trim()) {
								e.preventDefault();
								run({ kind: "create", type: null, title: q.trim() });
							} else if (e.key === "Enter" && items[sel]) {
								e.preventDefault();
								run(items[sel]!);
							}
						}}
						placeholder={t("palette.placeholder")}
						value={q}
						variant="bare"
					/>
					<div className="min-h-0 flex-1 overflow-y-auto p-1.5" ref={listRef}>
						{items.map((it, i) => {
							const active = i === sel;
							const common = {
								"data-i": i,
								onMouseEnter: () => setSel(i),
								onClick: () => run(it),
								className: cn(
									"flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm",
									active && "bg-selected",
								),
							};
							const key = keyOf(it);
							if (it.kind === "item") {
								const ix = repoOf(it.space).index();
								const item = ix.get(it.id)!;
								const status = statusOf(item, ix.schemaOf(item));
								const home = ix.homePath(item.id);
								return (
									<Button key={key} variant="plain" {...common}>
										<ItemIcon item={item} />
										<span className="min-w-0 flex-1">
											<span className="block truncate">{titleOf(item, t)}</span>
											{home.length > 0 ? (
												<span className="block truncate text-xs text-muted-foreground">
													{shortPath(home)}
												</span>
											) : (
												q.trim() &&
												item.body && (
													<span className="block truncate text-xs text-muted-foreground">
														{snippet(item.body, q, 90)}
													</span>
												)
											)}
										</span>
										<InTray item={item} ix={ix} />
										{status && <StatusPill group={status.group} option={status.option} small />}
										{several && (
											<span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">
												{nameOf(it.space)}
											</span>
										)}
										{active && <CornerDownLeft className="text-muted-foreground" size={14} />}
									</Button>
								);
							}
							if (it.kind === "create")
								return (
									<Button key={key} variant="plain" {...common}>
										<Plus className="text-muted-foreground" size={16} />
										<span className="flex-1 truncate">
											{it.type
												? t("palette.newTyped", { name: ix.typeName(it.type) })
												: t("palette.new")}{" "}
											<span className="font-medium">{t("palette.quoted", { text: it.title })}</span>
										</span>
										{it.type && <TypeGlyph schema={ix.types.get(it.type)?.schema} size={14} />}
										{several && (
											<span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">
												{nameOf(captureIn)}
											</span>
										)}
									</Button>
								);
							if (it.kind === "cmd")
								return (
									<Button key={key} variant="plain" {...common}>
										<ChevronRight className="text-muted-foreground" size={16} />
										<span className="flex-1">{it.label}</span>
									</Button>
								);
							return (
								<Button key={key} variant="plain" {...common}>
									<span className="w-4" />
									<span className="flex-1 text-muted-foreground">
										{t("palette.goTo", { label: it.label })}
									</span>
								</Button>
							);
						})}
					</div>
					<div className="flex gap-3 border-t border-line px-4 py-2 text-[11px] text-muted-foreground">
						<span>{t("palette.keys", { mod: modName(lang) })}</span>
					</div>
				</div>
			</Backdrop>
		</ModalSurface>
	);
}
