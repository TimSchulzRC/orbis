// A file behaves like a note whose content is the file itself.

import { dateOf } from "@obtion/core/date";
import { fmtBytes, fmtDate, fmtDuration } from "@obtion/core/i18n";
import { type FileMeta, type Item, setFileMeta } from "@obtion/core/model";
import { ArrowRightLeft, Download, Replace, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useBlobUrl } from "../files";
import { leavePage, useDocumentTitle, useFiles, useIndex, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { who } from "../ui/actor";
import { ItemIcon, Tag } from "../ui/item-look";
import { Crumbs, LinksMenu, PageFooter, TrashBanner } from "../ui/PageParts";
import { ItemPicker } from "../ui/Picker";
import { MenuItem, MoreMenu } from "../ui/primitives";
import { TagInput } from "../ui/TagInput";
import { TitleField } from "../ui/TitleField";
import { PagePanel } from "../ui/Updates";

export function FilePage({ item }: { item: Item }) {
	const repo = useRepo();
	const files = useFiles();
	const { t, lang } = useT();
	useDocumentTitle(titleOf(item, t));
	const ix = useIndex();
	const file = item.file!;
	const [picking, setPicking] = useState(false);
	const isImg = file.filetype === "image";
	const display = useBlobUrl(
		isImg ? (file.display ?? file.hash) : file.filetype === "pdf" ? undefined : file.thumb,
		true,
	);
	const usedIn = ix
		.usedIn(item.id)
		.map((b) => ({ item: ix.get(b.from)!, note: t(`file.use.${b.kind}`) }))
		.filter((x) => x.item);
	const parents = ix.parentsOf(item.id);
	const local = files.hasLocal(file.hash);
	useEffect(() => void files.check(file.hash), [files, file.hash]);
	// PDF, audio and video from a blob: URL – the original here, or loaded with the token in the header
	const viewed = file.filetype === "pdf" || file.filetype === "audio" || file.filetype === "video";
	const [src, setSrc] = useState<{ hash: string; url: string }>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: once the original is `local`, its URL replaces the downloaded one
	useEffect(() => {
		if (!viewed) return;
		let url: string | undefined;
		let gone = false;
		void files.viewUrl(file.hash, file.mime).then((u) => {
			if (!u) return;
			if (gone) URL.revokeObjectURL(u);
			else {
				url = u;
				setSrc({ hash: file.hash, url: u });
			}
		});
		return () => {
			gone = true;
			if (url) URL.revokeObjectURL(url);
		};
	}, [files, file.hash, file.mime, local, viewed]);
	const media = src?.hash === file.hash ? src.url : undefined;
	const missing = files.isMissing(file.hash);
	// only a person or an agent is named: examples, imports and the system add files without one
	const by = item.createdBy ? who(item.createdBy, t) : undefined;
	const addedBy = by && (by.agent || by.person) ? by.label : "";
	const extension = (file.name.split(".").pop() ?? "").toUpperCase();
	const dimensions = file.width && file.height ? `${file.width} × ${file.height}` : "";
	const size = [
		dimensions,
		file.pages ? t("file.pages", { count: file.pages }) : "",
		file.duration ? fmtDuration(file.duration) : "",
		fmtBytes(lang, file.size),
	]
		.filter(Boolean)
		.join(" · ");
	const facts: [string, React.ReactNode][] = [
		[t("file.type"), `${t(`filetype.${file.filetype}`)} · ${extension}`],
		[t("file.size"), size],
		[t("file.added"), `${fmtDate(lang, dateOf(item.created))}${addedBy ? ` · ${addedBy}` : ""}`],
		[t("file.here"), local ? t("file.local") : t("file.online")],
	];
	/** "Replace…": new content, same document; the old version stays in the history. */
	const replace = async (upload: File) => {
		const meta = await files.prepare(upload, file.name);
		repo.change(item.id, (doc) =>
			setFileMeta(doc, {
				...meta,
				name: file.name,
				display: meta.display ?? null,
				thumb: meta.thumb ?? null,
				pages: null,
				text: null,
				extracted: null,
				duration: null,
				history: [...(file.history ?? []), { hash: file.hash, at: Date.now() }],
			}),
		);
	};
	// the top bar's place for the side panel's button, left of "…"
	const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);
	const tools = (
		<>
			<span className="contents" ref={setPanelSlot} />
			<MoreMenu>
				{(close) => (
					<>
						<MenuItem
							icon={<ArrowRightLeft size={14} />}
							onClick={() => {
								close();
								setPicking(true);
							}}
						>
							{parents.length ? t("place.change") : t("place.place")}
						</MenuItem>
						<label className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-hover">
							<Replace className="text-muted-foreground" size={14} /> {t("file.replace")}
							<Input
								className="hidden"
								onChange={(e) => {
									close();
									const f = e.target.files?.[0];
									if (f) replace(f);
								}}
								type="file"
								variant="bare"
							/>
						</label>
						{!item.deleted && (
							<MenuItem
								danger
								icon={<Trash2 size={14} />}
								onClick={() => {
									close();
									repo.remove(item.id);
									leavePage();
								}}
							>
								{t("item.delete")}
							</MenuItem>
						)}
					</>
				)}
			</MoreMenu>
		</>
	);
	return (
		<div className="page-read">
			{item.deleted && <TrashBanner onRestore={() => repo.restore(item.id)} />}
			{missing && (
				<p className="mb-3 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted-foreground">
					{t(
						files.missingKey(item.created) === "file.uploading"
							? "file.uploadingHint"
							: "file.missingHint",
					)}
				</p>
			)}
			<Crumbs item={item} onPlace={() => setPicking(true)} tools={tools} />
			<PagePanel bar={panelSlot} item={item} updates={false} />
			<div className="mt-1.5 flex items-start gap-4">
				<div className="min-w-0 flex-1">
					<TitleField autoFocus={false} item={item} placeholder={file.name} />
				</div>
				<a
					className="inline-flex cursor-pointer h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-fg hover:bg-hover"
					download={file.name}
					href={media ?? "#"}
					onClick={(e) => {
						if (media) return;
						e.preventDefault();
						void files.download(file.hash, file.name, file.mime);
					}}
				>
					<Download size={15} /> <span className="max-md:hidden">{t("file.download")}</span>
				</a>
			</div>
			<div className="mt-2.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
				<ItemIcon item={item} size={13} /> {facts[0]![1]}
				<span className="ml-auto inline-flex">
					<LinksMenu item={item} usedIn={usedIn} />
				</span>
			</div>
			{/* facts as the property block (no "+ Property") */}
			<div className="mt-[18px] grid grid-cols-[148px_minmax(0,1fr)] gap-x-3 max-md:grid-cols-[124px_minmax(0,1fr)]">
				{[[t("file.name"), file.name] as [string, React.ReactNode], ...facts.slice(1)].map(
					([label, value]) => (
						<div className="contents" key={label}>
							<div className="flex min-h-8 items-center truncate text-[13px] text-muted-foreground pointer-coarse:min-h-11">
								{label}
							</div>
							<div className="flex min-h-8 min-w-0 items-center break-all text-sm tabular-nums pointer-coarse:min-h-11">
								{value}
							</div>
						</div>
					),
				)}
				<div className="flex min-h-8 items-center text-[13px] text-muted-foreground pointer-coarse:min-h-11">
					{t("item.tags")}
				</div>
				<div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1.5 text-sm pointer-coarse:min-h-11">
					{item.tags.map((x) => (
						<Tag key={x} onRemove={() => repo.setMember(item.id, "tags", x, false)} tag={x} />
					))}
					<TagInput exclude={item.tags} onAdd={(x) => repo.setMember(item.id, "tags", x, true)} />
				</div>
			</div>
			<div className="mt-5 border-t border-line" />

			<div className="mt-6 overflow-hidden rounded-xl border border-line bg-surface-2">
				{isImg && display && (
					<img
						alt={item.body || item.title}
						className="mx-auto max-h-[70vh] w-auto"
						src={display}
					/>
				)}
				{file.filetype === "pdf" && media && (
					<iframe className="h-[75vh] w-full bg-white" src={media} title={item.title} />
				)}
				{file.filetype === "audio" && media && (
					// biome-ignore lint/a11y/useMediaCaption: an uploaded file comes without a caption track
					<audio className="w-full p-4" controls src={media} />
				)}
				{file.filetype === "video" && media && (
					// biome-ignore lint/a11y/useMediaCaption: an uploaded file comes without a caption track
					<video className="w-full" controls src={media} />
				)}
				{!isImg &&
					file.filetype !== "pdf" &&
					file.filetype !== "audio" &&
					file.filetype !== "video" && <FileText file={file} missing={missing} />}
			</div>
			{file.filetype === "pdf" && file.text && (
				<details className="mt-3 rounded-xl border border-line bg-surface-2">
					<summary className="cursor-pointer px-4 py-2.5 text-[13px] text-muted-foreground">
						{t("file.extracted")}
					</summary>
					<TextBlock hash={file.hash} mono={false} text={file.text} />
				</details>
			)}
			<Textarea
				aria-label={t("file.description")}
				className="field mt-4 w-full resize-y bg-transparent text-[15px] leading-[1.65] outline-none placeholder:text-faint max-md:text-base"
				defaultValue={item.body}
				key={item.id}
				onBlur={(e) => e.target.value !== item.body && repo.setBody(item.id, e.target.value)}
				placeholder={t("file.descriptionPlaceholder")}
				rows={2}
				variant="inline"
			/>

			<PageFooter item={item} />
			{picking && (
				<ItemPicker
					exclude={(x) => x.id === item.id || parents.includes(x.id) || x.kind !== "note"}
					onClose={() => setPicking(false)}
					onPick={(p) => {
						repo.addParent(item.id, p);
						setPicking(false);
					}}
					title={parents.length ? t("place.changeTitle") : t("place.add")}
				/>
			)}
		</div>
	);
}

/** Formats whose text the server takes out (Office, mails); the rest is shown as it is. */
const EXTRACTED = /\.(docx?|docm|dotx|xlsx?|xlsm|pptx?|potx|od[tsp]|msg|pdf)$/i;
/** Prose in a proportional font; code, lists and tables (columns by tabs) in monospace. */
const PROSE = /\.(docx?|docm|dotx|pptx?|potx|odt|odp|msg|pdf)$/i;

/**
 * The text of a file that is neither image, PDF nor media: a text or code file as it is, an
 * Office file's text, a ZIP's list of entries – as the server read it (the file's `text`), never
 * rendered as HTML.
 */
function FileText({ file: f, missing }: { file: FileMeta; missing: boolean }) {
	const { t } = useT();
	if (!f.text) {
		const reading = !missing && f.extracted === undefined;
		return (
			<div className="flex h-40 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-muted-foreground">
				<span className="break-all">{f.name}</span>
				<span className="text-[13px] text-faint">
					{t(reading ? "file.reading" : "file.noText")}
				</span>
			</div>
		);
	}
	const extracted = EXTRACTED.test(f.name);
	return (
		<div>
			<div className="border-b border-line px-4 py-2 text-[13px] text-muted-foreground">
				{t(extracted ? "file.extracted" : "file.content")}
			</div>
			<TextBlock hash={f.hash} mono={!PROSE.test(f.name)} text={f.text} />
		</div>
	);
}

/** The facts carry the start of a long text ("…" at the end); the whole one comes from the server. */
function useWholeText(text: string, hash: string): string {
	const files = useFiles();
	const [whole, setWhole] = useState<{ hash: string; text: string }>();
	const cut = text.endsWith("\n…");
	useEffect(() => {
		if (!cut) return;
		let alive = true;
		void files.wholeText(hash).then((w) => alive && w && setWhole({ hash, text: w }));
		return () => {
			alive = false;
		};
	}, [files, hash, cut]);
	return whole?.hash === hash ? whole.text : text;
}

function TextBlock({ text: start, hash, mono }: { text: string; hash: string; mono: boolean }) {
	const { t } = useT();
	const text = useWholeText(start, hash);
	const cut = text.endsWith("\n…");
	return (
		<>
			<pre
				className={`max-h-[70vh] overflow-auto px-4 py-3 text-[13px] leading-[1.55] whitespace-pre-wrap break-words ${mono ? "font-mono" : "font-sans"}`}
				data-testid="file-text"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling block must take the focus so the keyboard can scroll it
				tabIndex={0}
			>
				{cut ? text.slice(0, -2) : text}
			</pre>
			{cut && (
				<p className="border-t border-line px-4 py-2 text-[13px] text-muted-foreground">
					{t("file.truncated")}
				</p>
			)}
		</>
	);
}
