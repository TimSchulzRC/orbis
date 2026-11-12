import { sameValue } from "@obtion/core/equal";
import {
	FILE_TYPES,
	type FileType,
	type Item,
	setTab,
	setTabs,
	shortId,
	type ViewTab,
} from "@obtion/core/model";
import { andWhere, type QueryDef, tabDef } from "@obtion/core/query";
import { typeTabs } from "@obtion/core/setup";
import { keyBetween } from "@obtion/core/sortkey";
import { ListFilter, Plus, SlidersHorizontal, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createAndOpen } from "../actions";
import { Input } from "../components/ui/input";
import { setParams, useDocumentTitle, useFiles, useRepo, useRoute } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { notify } from "../ui/feedback";
import { viewGroups } from "../ui/groups";
import { Button, DraftBar, Empty, IconButton } from "../ui/primitives";
import { AddFilter, QueryEditor } from "../ui/QueryEditor";
import { defaultColumns, Results, useQuery } from "../ui/Results";
import { SpaceEyebrow } from "../ui/Spaces";
import {
	type TabEdit,
	tabName,
	useTabChoice,
	useViewFields,
	ViewSettings,
	ViewTabs,
} from "../ui/Views";

/** A view's look is saved at once; a filter is a draft until "Save". */
export function TypeList({ type }: { type: Item }) {
	const repo = useRepo();
	const { t, lang } = useT();
	const tabs = typeTabs(type, lang);
	const [tab, pickTab] = useTabChoice(type.id, tabs, true);
	// the first change keeps the default views: they are written along with it
	const writeTab = (id: string, patch: Parameters<typeof setTab>[2]) =>
		repo.change(type.id, (d) => {
			if (!type.schema!.views) setTabs(d, tabs);
			setTab(d, id, patch);
		});
	const [draft, setDraft] = useState<{ tab: string; where: QueryDef["where"] } | null>(null);
	const tabWhere = draft?.tab === tab.id ? draft.where : tab.where;
	const base = { type: type.id };
	const def: QueryDef = tabDef(base, { ...tab, where: tabWhere });
	const dirty = !!draft && !sameValue(draft.where, tabs.find((x) => x.id === draft.tab)?.where);
	const saveLook = (patch: Partial<ViewTab>) => {
		const changed = Object.entries(patch).filter(
			([k, v]) => !sameValue(v, tab[k as keyof ViewTab]),
		);
		if (!changed.length) return;
		writeTab(tab.id, Object.fromEntries(changed.map(([k, v]) => [k, v ?? null])));
		if (patch.kind && patch.kind !== tab.kind)
			notify.undo(t("view.viewSet", { view: t("view." + patch.kind) }), () =>
				writeTab(tab.id, { kind: tab.kind }),
			);
	};
	// leaving with an unsaved filter: say that it was not kept
	const dirtyRef = useRef(false);
	dirtyRef.current = dirty;
	useEffect(() => () => void (dirtyRef.current && notify(t("view.draftDropped"))), []);
	const pick = (id: string) => {
		if (dirty) notify(t("view.draftDropped")), setDraft(null);
		pickTab(id);
	};
	const tabEdit: TabEdit = {
		add: (kind) => {
			const id = shortId("v");
			writeTab(id, {
				kind,
				pos: keyBetween(tabs.at(-1)?.pos ?? null, null),
				...(kind === "board" ? { group: "status" } : {}),
			});
			pick(id);
		},
		rename: (id, name) => writeTab(id, { name: name || null }),
		duplicate: (id) => {
			const n = tabs.findIndex((x) => x.id === id);
			const { id: _, pos, ...rest } = tabs[n]!;
			const copyId = shortId("v");
			writeTab(copyId, {
				...rest,
				name: t("view.copyName", { name: tabName(tabs[n]!, t) }),
				pos: keyBetween(pos, tabs[n + 1]?.pos ?? null),
			});
			pick(copyId);
		},
		remove: (id) => {
			const { id: _, ...whole } = tabs.find((x) => x.id === id)!;
			writeTab(id, null);
			if (draft?.tab === id) setDraft(null);
			notify.undo(t("view.removed", { name: tabName(whole, t) }), () => writeTab(id, whole));
		},
		move: (id, pos) => writeTab(id, { pos }),
		settings: () => setSettingsOpen(true),
	};
	const { items, ctx } = useQuery(def);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const fields = useViewFields(base, items);
	const setTabFilter = (where: QueryDef["where"]) =>
		!sameValue(where, tabWhere) && setDraft({ tab: tab.id, where });
	const saveDraft = () => {
		if (!draft) return;
		writeTab(draft.tab, { where: draft.where ?? null });
		setDraft(null);
		notify(t("view.saved"));
	};
	const name = type.schema!.name;
	return (
		<>
			<ViewTabs
				active={tab.id}
				edit={tabEdit}
				onPick={pick}
				right={
					<>
						<AddFilter
							onAdd={(c) => setTabFilter(andWhere(tabWhere, c))}
							trigger={(p) => <IconButton {...p} icon={ListFilter} label={t("view.addFilter")} />}
						/>
						<IconButton
							aria-pressed={settingsOpen}
							className={settingsOpen ? "bg-hover text-fg" : undefined}
							icon={SlidersHorizontal}
							label={t("view.settings")}
							onClick={() => setSettingsOpen(!settingsOpen)}
						/>
						<Button
							aria-label={t("view.new", { name })}
							onClick={() => createAndOpen({ type: type.id })}
							variant="primary"
						>
							<Plus size={14} /> <span className="hidden sm:inline">{name}</span>
						</Button>
					</>
				}
				tabs={tabs}
			/>
			{settingsOpen && (
				<ViewSettings
					columns={tab.kind === "table" ? defaultColumns(items, ctx) : undefined}
					fields={fields}
					groups={viewGroups(items, def, ctx)}
					onClose={() => setSettingsOpen(false)}
					onLook={saveLook}
					tab={{ ...tab, where: tabWhere }}
				/>
			)}
			{/* the view's own filter: only when it has one, as chips under the tabs (like Notion) */}
			{tabWhere && (
				<div className="mb-3">
					<QueryEditor bare def={{ where: tabWhere }} onChange={(d) => setTabFilter(d.where)} />
				</div>
			)}
			{dirty && (
				<DraftBar
					className="sticky top-0 z-10 mb-3 rounded-xl bg-surface px-3 py-2"
					onDiscard={() => setDraft(null)}
					onSave={saveDraft}
				/>
			)}
			{!items.length && tabWhere ? (
				// empty because of the view's filter: say so, with the way out
				<Empty title={t("view.emptyFiltered")}>
					<Button onClick={() => setTabFilter(undefined)} variant="outline">
						{t("view.removeFilter")}
					</Button>
				</Empty>
			) : (
				<Results
					def={def}
					empty={<Empty title={t("query.empty")} />}
					keyPrefix={type.id}
					look={{
						key: `${type.id}:${tab.id}`,
						tab: { ...tab, where: tabWhere },
						onLook: saveLook,
						add: { type: type.id },
					}}
				/>
			)}
		</>
	);
}

/** "?kind=image": the file type. */
const kindOf = (param: string | null) => FILE_TYPES.find((k) => k === param) ?? null;

export function FilesPage() {
	const files = useFiles();
	const { t } = useT();
	const kind = kindOf(useRoute().query.get("kind"));
	const setKind = (k: FileType | null) => setParams({ kind: k });
	const all = useQuery({ where: { file: true } }).items;
	const kinds = FILE_TYPES.map((type) => ({
		type,
		count: all.filter((i) => i.file?.filetype === type).length,
	})).filter((x) => x.count > 0);
	const def: QueryDef = {
		where: kind ? { and: [{ file: true }, { filetype: kind }] } : { file: true },
		sort: [{ key: "created", desc: true }],
	};
	useDocumentTitle(t("nav.files"));
	return (
		<div className="page-wide">
			<SpaceEyebrow />
			<div className="mb-4 flex items-center gap-3">
				<h1 className="page-title">{t("nav.files")}</h1>
				<span className="flex-1 text-[15px] tabular-nums text-muted-foreground">{all.length}</span>
				<label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm font-medium hover:bg-hover">
					<Upload size={14} /> <span className="hidden sm:inline">{t("files.add")}</span>
					<Input
						className="hidden"
						multiple
						onChange={async (e) => {
							for (const f of [...(e.target.files ?? [])]) await files.add(f, f.name);
						}}
						type="file"
						variant="bare"
					/>
				</label>
			</div>
			{kinds.length > 1 && (
				<div
					aria-label={t("files.filter")}
					className="-mx-4 mb-3 flex gap-1 overflow-x-auto px-4 text-sm [scrollbar-width:none] md:mx-0 md:px-0"
					role="group"
				>
					{[{ type: null, count: all.length }, ...kinds].map(({ type, count }) => (
						<Button
							aria-pressed={kind === type}
							className={cn(
								"shrink-0 whitespace-nowrap rounded-full border px-3 py-1",
								kind === type
									? "border-focus bg-surface text-fg"
									: "border-line text-muted-foreground hover:bg-hover hover:text-fg",
							)}
							key={type ?? "all"}
							onClick={() => setKind(type)}
							variant="plain"
						>
							{type ? t("filetype.many." + type) : t("files.all")}{" "}
							<span className="tabular-nums text-muted-foreground">{count}</span>
						</Button>
					))}
				</div>
			)}
			<Results
				def={def}
				display={kind === "image" ? "gallery" : "list"}
				empty={<Empty title={t("files.empty")} />}
				keyPrefix="files"
			/>
		</div>
	);
}
