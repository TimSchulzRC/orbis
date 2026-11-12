// Excalidraw's public libraries (libraries.excalidraw.com), browsed inside the app: its list, previews
// and files may be read from any page, so a library goes straight into the drawing, without a trip to
// that site and back.

import { Check, Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Input } from "../components/ui/input";
import { useT } from "../i18n";
import { Button, Dialog, Seg } from "../ui/primitives";

const SITE = "https://libraries.excalidraw.com/";

type Library = {
	id: string;
	name: string;
	description?: string;
	authors?: { name: string; url?: string }[];
	source: string;
	preview: string;
	created: string;
	updated: string;
	itemNames?: string[];
	downloads: number;
};

type Sort = "popular" | "new" | "updated";

/** The list as the site shows it: each library with its downloads (stats.json is keyed like this). */
async function loadList(): Promise<Library[]> {
	const [list, stats] = await Promise.all([
		fetch(`${SITE}libraries.json`).then((r) =>
			r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
		),
		fetch(`${SITE}stats.json`).then(
			(r) => (r.ok ? r.json() : {}),
			() => ({}),
		),
	]);
	return (list as Omit<Library, "id" | "downloads">[]).map((l) => {
		const id = l.source
			.toLowerCase()
			.replace(/\.excalidrawlib$/, "")
			.replace(/\//g, "-");
		return { ...l, id, downloads: (stats as Record<string, { total?: number }>)[id]?.total ?? 0 };
	});
}

let cached: Promise<Library[]> | undefined;

/** `onClose` learns whether a library came in (the drawing then shows its library). */
export function LibraryBrowser({
	onAdd,
	onClose,
}: {
	onAdd: (blob: Blob) => Promise<void>;
	onClose: (added: boolean) => void;
}) {
	const { t } = useT();
	const [list, setList] = useState<Library[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [q, setQ] = useState("");
	const [sort, setSort] = useState<Sort>("popular");
	const [state, setState] = useState<Record<string, "adding" | "added" | "failed">>({});

	useEffect(() => {
		let live = true;
		(cached ??= loadList()).then(
			(l) => live && setList(l),
			() => {
				cached = undefined;
				if (live) setFailed(true);
			},
		);
		return () => void (live = false);
	}, []);

	const shown = useMemo(() => {
		if (!list) return [];
		const words = q.toLowerCase().split(/\s+/).filter(Boolean);
		const hits = list.filter((l) => {
			const text = [
				l.name,
				l.description,
				...(l.authors ?? []).map((a) => a.name),
				...(l.itemNames ?? []),
			]
				.join(" ")
				.toLowerCase();
			return words.every((w) => text.includes(w));
		});
		const by: Record<Sort, (a: Library, b: Library) => number> = {
			popular: (a, b) => b.downloads - a.downloads,
			new: (a, b) => b.created.localeCompare(a.created),
			updated: (a, b) => b.updated.localeCompare(a.updated),
		};
		return hits.sort(by[sort]);
	}, [list, q, sort]);

	const add = async (l: Library) => {
		setState((s) => ({ ...s, [l.id]: "adding" }));
		try {
			const r = await fetch(`${SITE}libraries/${l.source}`);
			if (!r.ok) throw new Error(String(r.status));
			await onAdd(await r.blob());
			setState((s) => ({ ...s, [l.id]: "added" }));
		} catch (e) {
			console.warn("library not added", e);
			setState((s) => ({ ...s, [l.id]: "failed" }));
		}
	};

	return (
		<Dialog
			onClose={() => onClose(Object.values(state).includes("added"))}
			title={t("drawing.libraries")}
			wide
		>
			{/* keys stay here: typing in the search is not a drawing shortcut, Escape closes only this */}
			<div onKeyDown={(e) => e.stopPropagation()}>
				<div className="mb-3 flex flex-wrap items-center gap-2">
					<Input
						aria-label={t("drawing.librarySearch")}
						autoFocus
						className="min-w-0 flex-1 basis-48"
						onChange={(e) => setQ(e.target.value)}
						placeholder={t("drawing.librarySearch")}
						type="search"
						value={q}
					/>
					<Seg
						label={t("drawing.librarySort")}
						onChange={setSort}
						options={[
							{ value: "popular", label: t("drawing.libraryPopular") },
							{ value: "new", label: t("drawing.libraryNew") },
							{ value: "updated", label: t("drawing.libraryUpdated") },
						]}
						value={sort}
					/>
				</div>
				{failed ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						{t("drawing.librariesFailed")}
					</p>
				) : !list ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						{t("drawing.librariesLoading")}
					</p>
				) : !shown.length ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						{t("drawing.librariesNone")}
					</p>
				) : (
					<ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						{shown.map((l) => (
							<li
								className="flex flex-col overflow-hidden rounded-xl border border-line bg-card"
								key={l.id}
							>
								{/* the previews are drawn on white */}
								<div className="flex h-36 items-center justify-center bg-white p-2">
									<img
										alt=""
										className="max-h-full max-w-full object-contain"
										decoding="async"
										loading="lazy"
										src={`${SITE}libraries/${l.preview}?v=${encodeURIComponent(l.updated)}`}
									/>
								</div>
								<div className="flex flex-1 flex-col gap-1 p-3">
									<h3 className="text-sm font-medium">{l.name}</h3>
									{!!l.authors?.length && (
										<div className="text-xs text-muted-foreground">
											{l.authors.map((a) => a.name).join(", ")}
										</div>
									)}
									{l.description && (
										<p className="line-clamp-3 text-xs text-muted-foreground">{l.description}</p>
									)}
									<div className="mt-auto pt-2">
										<Button
											className="w-full"
											disabled={state[l.id] === "adding" || state[l.id] === "added"}
											onClick={() => void add(l)}
											small
											variant={state[l.id] === "added" ? "outline" : "primary"}
										>
											{state[l.id] === "added" ? <Check size={14} /> : <Download size={14} />}
											{t(
												state[l.id] === "added"
													? "drawing.libraryAddedShort"
													: state[l.id] === "failed"
														? "drawing.libraryRetry"
														: "drawing.libraryAdd",
											)}
										</Button>
									</div>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
		</Dialog>
	);
}
