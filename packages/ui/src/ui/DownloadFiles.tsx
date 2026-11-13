// "Download files (n)": several files saved as one ZIP. The same entry in every menu that has
// files to offer – everything below an item (sidebar, page, "Below") or the files a query shows.

import { type ArchiveFile, fitsZip, safeName } from "@obtion/core/zip";
import { Download } from "lucide-react";
import { useFiles } from "../hooks";
import { useT } from "../i18n";
import { notify } from "./feedback";
import { MenuItem, SectionAction } from "./primitives";

/** Names in a notice about missing files, before "…". */
const NAMED = 3;

/** Starts the download and says what became of it. `title` names the ZIP, with today's date. */
export function useDownloadFiles() {
	const device = useFiles();
	const { t } = useT();
	return async (files: ArchiveFile[], title: string) => {
		if (!files.length) return;
		if (!fitsZip(files)) return notify.error(t("file.downloadAllTooLarge"));
		// a large archive loads for a while: say so until it is saved
		const done = notify.busy(t("file.downloadAllPacking", { count: files.length }));
		const day = new Date().toLocaleDateString("sv"); // 2026-11-13, local
		const { saved, missing } = await device
			.downloadAll(files, `${safeName(title)}_${day}.zip`)
			.finally(done);
		if (!missing.length) return;
		const names = missing.slice(0, NAMED).join(", ") + (missing.length > NAMED ? " …" : "");
		notify.error(
			saved
				? t("file.downloadAllMissing", { count: missing.length, names })
				: t("file.downloadAllFailed", { names }),
		);
	};
}

/** The menu entry; nothing when there are no files. `icon`: for menus whose entries have icons. */
export function DownloadFilesItem({
	files,
	title,
	close,
	icon,
}: {
	files: ArchiveFile[];
	title: string;
	close: () => void;
	icon?: boolean;
}) {
	const { t } = useT();
	const download = useDownloadFiles();
	if (!files.length) return null;
	return (
		<MenuItem
			icon={icon ? <Download size={14} /> : undefined}
			onClick={() => {
				close();
				void download(files, title);
			}}
		>
			{t("file.downloadAll", { count: files.length })}
		</MenuItem>
	);
}

/**
 * The same as a section's action, beside "Add below". On a phone the head has no room for both
 * labels: the icon and the number show, the label stays for screen readers.
 */
export function DownloadFilesAction({ files, title }: { files: ArchiveFile[]; title: string }) {
	const { t } = useT();
	const download = useDownloadFiles();
	if (!files.length) return null;
	const label = t("file.downloadAll", { count: files.length });
	return (
		<SectionAction icon={Download} onClick={() => void download(files, title)} title={label}>
			<span className="max-md:sr-only">{label}</span>
			<span aria-hidden className="tabular-nums md:hidden">
				{files.length}
			</span>
		</SectionAction>
	);
}
