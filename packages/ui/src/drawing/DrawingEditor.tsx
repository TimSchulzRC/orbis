// The full-screen drawing: Excalidraw itself, with its tools, menus and shortcuts, bound to the
// drawing's document. Loaded only when a drawing opens.
import "@excalidraw/excalidraw/index.css";
import {
	CaptureUpdateAction,
	Excalidraw,
	hashElementsVersion,
	MainMenu,
	reconcileElements,
	useHandleLibrary,
	WelcomeScreen,
} from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
	AppState,
	BinaryFiles,
	ExcalidrawImperativeAPI,
	LibraryItems,
} from "@excalidraw/excalidraw/types";
import {
	DRAWING,
	DRAWING_FILES,
	DRAWING_STATE,
	type DrawingFile,
	readElements,
	readScene,
	type SceneElement,
	setDrawingFile,
	setDrawingState,
	writeElements,
} from "@obtion/core/drawing";
import { touch } from "@obtion/core/model";
import { X } from "lucide-react";
import {
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useFiles } from "../hooks";
import { useT } from "../i18n";
import { repo as current } from "../repo";
import { ScopeContext } from "../scope";
import { useTheme } from "../theme";
import { DRAWING_ICON } from "../ui/icons";
import { LibraryBrowser } from "./LibraryBrowser";
import { setLiveLibrary } from "./live-library";
import { dataURLToBlob, imageName, loadImages, readLibrary, saveLibrary } from "./scene";

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH ??= "/excalidraw/";

/**
 * Excalidraw calls onChange on every pointer move. The document gets the result once drawing pauses
 * (the pointer is up), and while working on without a pause at least this often, so other devices
 * follow along. Nothing is written in the middle of a stroke: a write makes the app re-render, and
 * that would stall the stroke.
 */
const WRITE_AFTER_MS = 500;
const WRITE_AT_LEAST_MS = 2000;

/** Excalidraw's language codes; ours are "de" and "en". */
const LANG_CODE: Record<string, string> = { de: "de-DE", en: "en" };

const library = {
	load: async () => ({ libraryItems: readLibrary() }),
	save: async ({ libraryItems }: { libraryItems: LibraryItems }) => saveLibrary(libraryItems),
};

/**
 * Renders again only when its note's title, the theme or the language change: Excalidraw redraws its
 * whole interface on a render, so it must not follow every change in the workspace.
 */
export default memo(function DrawingEditor({ id, onClose }: { id: string; onClose: () => void }) {
	const repo = useContext(ScopeContext)?.repo ?? current;
	const files = useFiles();
	const { t, lang } = useT();
	const dark = useTheme().resolved === "dark";
	const doc = useMemo(() => repo.getDoc(id), [repo, id]);
	// a diagram has no name of its own: an export ("Export image", "Save") is named after its note
	const note = useSyncExternalStore(repo.subscribe, () => {
		const parent = repo.get(id)?.parents;
		return (parent && repo.get(Object.keys(parent)[0])?.title) || "";
	});
	const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
	const [root, setRoot] = useState<HTMLDivElement | null>(null);
	const initial = useMemo(() => {
		const scene = readScene(doc);
		return {
			elements: scene.elements as unknown as OrderedExcalidrawElement[],
			appState: scene.state as Partial<AppState>,
			scrollToContent: true,
		};
	}, [doc]);

	// ---- writing: the scene into the document, throttled ----
	const writing = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pendingSince = useRef<number | undefined>(undefined);
	const lastVersion = useRef<string | undefined>(undefined);
	const dirty = useRef(false);
	const scene = useRef<{
		elements: readonly OrderedExcalidrawElement[];
		state: AppState;
		files: BinaryFiles;
	} | null>(null);
	const stored = useRef(new Set<string>()); // image ids in the document or on their way there

	const uploadImages = (all: BinaryFiles) => {
		const have = doc.getMap<DrawingFile>(DRAWING_FILES);
		for (const [fid, f] of Object.entries(all)) {
			if (have.has(fid) || stored.current.has(fid) || !f.dataURL) continue;
			stored.current.add(fid);
			void (async () => {
				try {
					const blob = await dataURLToBlob(f.dataURL);
					const hash = await files.addContent(blob, imageName(f.mimeType));
					write((d) => {
						setDrawingFile(d, fid, {
							hash,
							mimeType: f.mimeType,
							created: f.created ?? Date.now(),
						});
						touch(d);
					});
				} catch (e) {
					stored.current.delete(fid);
					console.warn("drawing image not stored", e);
				}
			})();
		}
	};

	const write = (fn: (d: typeof doc) => void) => {
		writing.current = true;
		try {
			repo.change(id, fn);
		} finally {
			writing.current = false;
		}
	};

	const flush = () => {
		clearTimeout(timer.current);
		timer.current = undefined;
		pendingSince.current = undefined;
		dirty.current = false;
		// the scene as Excalidraw last reported it: on closing, Excalidraw empties its own before this runs
		const last = scene.current;
		if (!last || repo.readOnly) return;
		const elements = last.elements as unknown as SceneElement[];
		const state = last.state as unknown as Record<string, unknown>;
		write((d) => {
			// an element gone from the scene (another file opened) is deleted on every device; "Reset the canvas" marks
			// them deleted instead, so an empty scene is never one to delete everything by
			const here = new Set(elements.map((e) => e.id));
			const gone = (elements.length ? readElements(d) : [])
				.filter((e) => !here.has(e.id) && !e.isDeleted)
				.map((e) => ({
					...e,
					isDeleted: true,
					version: e.version + 1,
					versionNonce: Math.floor(Math.random() * 2 ** 31),
					updated: Date.now(),
				}));
			const n = writeElements(d, [...elements, ...gone]);
			if (setDrawingState(d, state) || n) touch(d);
		});
		uploadImages(last.files);
	};
	const flushRef = useRef(flush);
	flushRef.current = flush;

	const onChange = useCallback(
		(elements: readonly OrderedExcalidrawElement[], state: AppState, all: BinaryFiles) => {
			scene.current = { elements, state, files: all };
			// scrolling and zooming change nothing worth keeping
			const version = [
				hashElementsVersion(elements),
				Object.keys(all).length,
				state.viewBackgroundColor,
				state.gridModeEnabled,
				state.gridSize,
				state.gridStep,
			].join(":");
			if (version !== lastVersion.current) {
				lastVersion.current = version;
				dirty.current = true;
				pendingSince.current ??= Date.now();
			}
			if (!dirty.current) return;
			clearTimeout(timer.current);
			timer.current = undefined;
			if (state.cursorButton === "down") return;
			const wait = Math.max(
				0,
				Math.min(WRITE_AFTER_MS, pendingSince.current! + WRITE_AT_LEAST_MS - Date.now()),
			);
			timer.current = setTimeout(() => flushRef.current(), wait);
		},
		[],
	);

	// what is not written yet goes in when the drawing closes or the tab goes away
	useEffect(() => {
		const save = () => flushRef.current();
		addEventListener("pagehide", save);
		document.addEventListener("visibilitychange", save);
		return () => {
			removeEventListener("pagehide", save);
			document.removeEventListener("visibilitychange", save);
			if (dirty.current) flushRef.current();
		};
	}, []);

	// ---- reading: changes from other devices and agents, merged per element ----
	useEffect(() => {
		if (!api) return;
		let live = true;
		const addImages = (entries: Record<string, DrawingFile>) => {
			const loaded = api.getFiles();
			const missing = Object.fromEntries(Object.entries(entries).filter(([fid]) => !loaded[fid]));
			for (const fid of Object.keys(entries)) stored.current.add(fid);
			if (Object.keys(missing).length)
				void loadImages(missing, files).then((list) => live && list.length && api.addFiles(list));
		};
		addImages(readScene(doc).files);
		const onElements = () => {
			if (writing.current) return;
			const merged = reconcileElements(
				api.getSceneElementsIncludingDeleted(),
				readElements(doc) as never,
				api.getAppState(),
			);
			api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
		};
		const onFiles = () => !writing.current && addImages(readScene(doc).files);
		// an image whose content was still uploading on the other device: in once the server has it
		const stopBlobs = repo.onBlob((hash) => {
			const all = readScene(doc).files;
			if (Object.values(all).some((f) => f.hash === hash)) addImages(all);
		});
		const onState = () =>
			!writing.current &&
			api.updateScene({
				appState: doc.getMap(DRAWING_STATE).toJSON() as never,
				captureUpdate: CaptureUpdateAction.NEVER,
			});
		const maps = [
			doc.getMap(DRAWING),
			doc.getMap(DRAWING_FILES),
			doc.getMap(DRAWING_STATE),
		] as const;
		maps[0].observe(onElements);
		maps[1].observe(onFiles);
		maps[2].observe(onState);
		return () => {
			live = false;
			stopBlobs();
			maps[0].unobserve(onElements);
			maps[1].unobserve(onFiles);
			maps[2].unobserve(onState);
		};
	}, [api, doc, repo, files]);

	useHandleLibrary({ excalidrawAPI: api, adapter: library });

	const addLibrary = useCallback(
		async (blob: Blob) => {
			await api?.updateLibrary({
				libraryItems: blob,
				merge: true,
				defaultStatus: "published",
				openLibraryMenu: true,
			});
		},
		[api],
	);
	// a library link from elsewhere (library-link.ts) comes into the open drawing
	useEffect(() => (api ? setLiveLibrary(addLibrary) : undefined), [api, addLibrary]);

	// "Bibliotheken durchsuchen" shows the libraries here instead of on libraries.excalidraw.com
	const [browsing, setBrowsing] = useState(false);
	const addFromBrowser = useCallback(
		async (blob: Blob) => {
			await api?.updateLibrary({ libraryItems: blob, merge: true, defaultStatus: "published" });
		},
		[api],
	);
	// a click in the dialog closed Excalidraw's library: it opens again with what came in
	const closeBrowser = useCallback(
		(added: boolean) => {
			setBrowsing(false);
			if (added)
				requestAnimationFrame(() =>
					api?.toggleSidebar({ name: "default", tab: "library", force: true }),
				);
		},
		[api],
	);
	useEffect(() => {
		if (!root) return;
		const onClick = (e: MouseEvent) => {
			if (
				!(e.target as Element | null)?.closest?.(
					'a.library-menu-browse-button, a[href^="https://libraries.excalidraw.com"]',
				)
			)
				return;
			e.preventDefault();
			e.stopPropagation();
			setBrowsing(true);
		};
		root.addEventListener("click", onClick, true);
		return () => root.removeEventListener("click", onClick, true);
	}, [root]);

	// the app behind is hidden while drawing (styles.css)
	useEffect(() => {
		document.documentElement.classList.add("drawing-open");
		return () => document.documentElement.classList.remove("drawing-open");
	}, []);

	// The app's own shortcuts (⌘K, single keys on pages) stay off while drawing; Excalidraw listens on
	// the document, before the window.
	useEffect(() => {
		const stop = (e: KeyboardEvent) => e.stopPropagation();
		document.addEventListener("keydown", stop);
		return () => document.removeEventListener("keydown", stop);
	}, []);

	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const close = useCallback(() => {
		flushRef.current();
		onCloseRef.current();
	}, []);

	/** Links to pages of this app open here (the drawing closes first); others in a new tab. */
	const onLinkOpen = useCallback(
		(
			element: { link: string | null },
			event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>,
		) => {
			if (!element.link) return;
			let url: URL;
			try {
				url = new URL(element.link, location.href);
			} catch {
				return;
			}
			if (url.origin !== location.origin || !url.hash.startsWith("#/")) return;
			event.preventDefault();
			// the page takes the drawing's place in the history: Back from there goes to the note
			flushRef.current();
			location.replace(url.hash);
		},
		[],
	);

	/**
	 * Close. A phone's toolbar needs the whole width: there it sits in the bottom bar. Excalidraw asks for
	 * it on every render (every pointer move while drawing): the same elements each time, so React
	 * skips them.
	 */
	const [desk, phone] = useMemo(() => {
		const top = (phone: boolean) => (
			<div className={phone ? "drawing-top drawing-top-phone" : "drawing-top"}>
				<button
					aria-label={t("drawing.close")}
					className="drawing-button drawing-close"
					onClick={close}
					title={t("drawing.close")}
					type="button"
				>
					<X size={18} />
				</button>
			</div>
		);
		return [top(false), root && createPortal(top(true), root)];
	}, [t, close, root]);
	const renderTopRightUI = useCallback(
		(isPhone: boolean) => (isPhone ? phone : desk),
		[desk, phone],
	);

	const menus = useMemo(
		() => (
			<>
				<MainMenu>
					<MainMenu.DefaultItems.LoadScene />
					<MainMenu.DefaultItems.SaveToActiveFile />
					<MainMenu.DefaultItems.Export />
					<MainMenu.DefaultItems.SaveAsImage />
					<MainMenu.DefaultItems.CommandPalette />
					<MainMenu.DefaultItems.SearchMenu />
					<MainMenu.DefaultItems.Help />
					<MainMenu.DefaultItems.ClearCanvas />
					<MainMenu.Separator />
					<MainMenu.DefaultItems.ChangeCanvasBackground />
					<MainMenu.Separator />
					<MainMenu.Item icon={<X size={16} />} onSelect={close}>
						{t("drawing.close")}
					</MainMenu.Item>
				</MainMenu>
				<WelcomeScreen>
					<WelcomeScreen.Hints.MenuHint />
					<WelcomeScreen.Hints.ToolbarHint />
					<WelcomeScreen.Hints.HelpHint />
					<WelcomeScreen.Center>
						<WelcomeScreen.Center.Logo>
							<span className="drawing-logo">
								<DRAWING_ICON size={28} /> {t("kind.drawing")}
							</span>
						</WelcomeScreen.Center.Logo>
						<WelcomeScreen.Center.Heading>{t("drawing.welcome")}</WelcomeScreen.Center.Heading>
						<WelcomeScreen.Center.Menu>
							<WelcomeScreen.Center.MenuItemLoadScene />
							<WelcomeScreen.Center.MenuItemHelp />
						</WelcomeScreen.Center.Menu>
					</WelcomeScreen.Center>
				</WelcomeScreen>
			</>
		),
		[t, close],
	);

	return (
		<div
			aria-label={t("kind.drawing")}
			aria-modal
			className="drawing-full fixed inset-0 z-50"
			ref={setRoot}
			role="dialog"
		>
			<Excalidraw
				aiEnabled={false}
				autoFocus
				excalidrawAPI={setApi}
				handleKeyboardGlobally
				initialData={initial}
				langCode={LANG_CODE[lang] ?? "en"}
				name={note || t("kind.drawing")}
				onChange={onChange}
				onLinkOpen={onLinkOpen}
				renderTopRightUI={renderTopRightUI}
				theme={dark ? "dark" : "light"}
				UIOptions={UI_OPTIONS}
			>
				{menus}
			</Excalidraw>
			{browsing && <LibraryBrowser onAdd={addFromBrowser} onClose={closeBrowser} />}
		</div>
	);
});

/** The theme follows the app, so Excalidraw's own switch is not offered. */
const UI_OPTIONS = { canvasActions: { toggleTheme: null } };
