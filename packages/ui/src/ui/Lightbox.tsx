// Shows the display version at once and swaps in the original once it is on the device.

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ModalSurface } from "../components/ui/dialog";
import { files } from "../files";
import { itemHref } from "../hooks";
import { useT } from "../i18n";
import { createStore } from "../lib/store";
import { repo } from "../repo";
import { Button } from "./primitives";

/** The index `delta` steps away in a list of `count`, wrapping around at both ends. */
const cycle = (delta: number, count: number) => (a: number) => (a + delta + count) % count;

const open = createStore<{ ids: string[]; at: number } | null>(null);

export function openLightbox(ids: string[], at: number) {
	const list = ids.filter(
		(id, i) => ids.indexOf(id) === i && repo.get(id)?.file?.filetype === "image",
	);
	if (!list.length) return;
	open.set({ ids: list, at: Math.max(0, list.indexOf(ids[at] ?? "")) });
}

export function LightboxHost() {
	const shown = open.use();
	return shown ? <Lightbox ids={shown.ids} start={shown.at} /> : null;
}

function Lightbox({ ids, start }: { ids: string[]; start: number }) {
	const { t } = useT();
	const [at, setAt] = useState(start);
	const [src, setSrc] = useState<string | undefined>();
	const item = repo.get(ids[at]!);
	const file = item?.file;
	const close = () => open.set(null);
	const step = (delta: number) => setAt(cycle(delta, ids.length));
	const hash = file?.hash;
	const display = file?.display;
	useEffect(() => {
		if (!hash) return;
		let live = true;
		setSrc(undefined);
		void files
			.url(display ?? hash, { keep: true })
			.then((url) => live && url && setSrc((s) => s ?? url));
		if (display) void files.url(hash).then((url) => live && url && setSrc(url));
		return () => {
			live = false;
		};
	}, [hash, display]);
	const count = ids.length;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowRight") setAt(cycle(1, count));
			else if (e.key === "ArrowLeft") setAt(cycle(-1, count));
			else return;
			e.preventDefault();
			e.stopPropagation();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [count]);
	if (!item || !file) return null;
	const nav =
		"absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60";
	return (
		<ModalSurface onClose={close} title={item.title}>
			<div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm">
				{/* a click beside the picture closes it; keys have Escape and the X */}
				<button
					aria-hidden
					className="absolute inset-0 cursor-default"
					onClick={close}
					tabIndex={-1}
					type="button"
				/>
				<div className="relative flex items-center gap-3 px-4 py-3 text-sm text-white/80 pt-safe">
					<a
						className="min-w-0 truncate font-medium text-white hover:underline"
						href={itemHref(item.id)}
						onClick={close}
					>
						{item.title}
					</a>
					{ids.length > 1 && (
						<span className="tabular-nums text-white/60">
							{at + 1} / {ids.length}
						</span>
					)}
					<Button
						aria-label={t("lightbox.close")}
						className="tap ml-auto rounded-md p-1.5 hover:bg-white/10"
						onClick={close}
						variant="plain"
					>
						<X size={18} />
					</Button>
				</div>
				{/* the stage lets clicks through to the backdrop, only the picture and arrows take them */}
				<div className="pointer-events-none relative flex min-h-0 flex-1 items-center justify-center px-4">
					{src && (
						<img
							alt={item.body || item.title}
							className="pointer-events-auto max-h-full max-w-full object-contain"
							src={src}
						/>
					)}
					{ids.length > 1 && (
						<>
							<Button
								aria-label={t("lightbox.prev")}
								className={`${nav} pointer-events-auto left-3`}
								onClick={() => step(-1)}
								variant="plain"
							>
								<ChevronLeft size={22} />
							</Button>
							<Button
								aria-label={t("lightbox.next")}
								className={`${nav} pointer-events-auto right-3`}
								onClick={() => step(1)}
								variant="plain"
							>
								<ChevronRight size={22} />
							</Button>
						</>
					)}
				</div>
				<p className="relative min-h-10 px-4 py-3 text-center text-sm text-white/80 pb-safe">
					{item.body}
				</p>
			</div>
		</ModalSurface>
	);
}
