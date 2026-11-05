// The full-screen drawing: Excalidraw itself, with its tools, menus and shortcuts, bound to the
// drawing's document. Loaded only when a drawing opens.
import "@excalidraw/excalidraw/index.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, MainMenu, WelcomeScreen, CaptureUpdateAction, reconcileElements, hashElementsVersion, useHandleLibrary } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, BinaryFiles, LibraryItems, AppState } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { Pencil, X } from "lucide-react";
import { DRAWING, DRAWING_FILES, DRAWING_STATE, type DrawingFile, type SceneElement, readElements, readScene, setDrawingFile, setDrawingState, writeElements } from "@obtion/core/drawing";
import { touch } from "@obtion/core/model";
import { useRepo, useFiles } from "../hooks";
import { useT } from "../i18n";
import { useTheme } from "../theme";
import { KEYS } from "../ui/storage";
import { dataURLToBlob, imageName, loadImages } from "./scene";
import { DRAWING_ICON } from "../ui/icons";

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH ??= "/excalidraw/";

/** Excalidraw calls onChange on every pointer move; the document gets the result at most this often. */
const WRITE_EVERY_MS = 300;

/** Excalidraw's language codes; ours are "de" and "en". */
const LANG_CODE: Record<string, string> = { de: "de-DE", en: "en" };

/** The library ("Bibliothek") belongs to the person, not the drawing: kept on this device like on excalidraw.com. */
const library = {
  load: async () => {
    try {
      const items = JSON.parse(localStorage.getItem(KEYS.drawingLibrary) ?? "null") as LibraryItems | null;
      return items ? { libraryItems: items } : null;
    } catch {
      return null;
    }
  },
  save: async ({ libraryItems }: { libraryItems: LibraryItems }) => {
    localStorage.setItem(KEYS.drawingLibrary, JSON.stringify(libraryItems));
  },
};

export default function DrawingEditor({ id, view, onEdit, onClose }: { id: string; view: boolean; onEdit: () => void; onClose: () => void }) {
  const repo = useRepo();
  const files = useFiles();
  const { t, lang } = useT();
  const dark = useTheme().resolved === "dark";
  const doc = useMemo(() => repo.getDoc(id), [repo, id]);
  const item = repo.get(id);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const initial = useMemo(() => {
    const scene = readScene(doc);
    return { elements: scene.elements as unknown as OrderedExcalidrawElement[], appState: scene.state as Partial<AppState>, scrollToContent: true };
  }, [doc]);

  // ---- writing: the scene into the document, throttled ----
  const writing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastVersion = useRef<string | undefined>(undefined);
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
            setDrawingFile(d, fid, { hash, mimeType: f.mimeType, created: f.created ?? Date.now() });
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
    if (!api || view || repo.readOnly) return;
    const elements = api.getSceneElementsIncludingDeleted() as unknown as SceneElement[];
    const state = api.getAppState() as unknown as Record<string, unknown>;
    write((d) => {
      // an element gone from the scene (another file opened, the canvas reset) is deleted on every device
      const here = new Set(elements.map((e) => e.id));
      const gone = readElements(d)
        .filter((e) => !here.has(e.id) && !e.isDeleted)
        .map((e) => ({ ...e, isDeleted: true, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }));
      const n = writeElements(d, [...elements, ...gone]);
      setDrawingState(d, state);
      if (n) touch(d);
    });
    uploadImages(api.getFiles());
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const onChange = (elements: readonly OrderedExcalidrawElement[], state: AppState, all: BinaryFiles) => {
    if (view) return;
    // scrolling and zooming change nothing worth keeping
    const version = [hashElementsVersion(elements), Object.keys(all).length, state.viewBackgroundColor, state.gridModeEnabled, state.gridSize, state.gridStep].join(":");
    if (version === lastVersion.current) return;
    lastVersion.current = version;
    timer.current ??= setTimeout(() => flushRef.current(), WRITE_EVERY_MS);
  };

  // what is not written yet goes in when the drawing closes or the tab goes away
  useEffect(() => {
    const save = () => flushRef.current();
    addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", save);
    return () => {
      removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", save);
      if (timer.current) flushRef.current();
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
      if (Object.keys(missing).length) void loadImages(missing, files).then((list) => live && list.length && api.addFiles(list));
    };
    addImages(readScene(doc).files);
    const onElements = () => {
      if (writing.current) return;
      const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), readElements(doc) as never, api.getAppState());
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    };
    const onFiles = () => !writing.current && addImages(readScene(doc).files);
    const onState = () => !writing.current && api.updateScene({ appState: doc.getMap(DRAWING_STATE).toJSON() as never, captureUpdate: CaptureUpdateAction.NEVER });
    const maps = [doc.getMap(DRAWING), doc.getMap(DRAWING_FILES), doc.getMap(DRAWING_STATE)] as const;
    maps[0].observe(onElements);
    maps[1].observe(onFiles);
    maps[2].observe(onState);
    return () => {
      live = false;
      maps[0].unobserve(onElements);
      maps[1].unobserve(onFiles);
      maps[2].unobserve(onState);
    };
  }, [api, doc]);

  useHandleLibrary({ excalidrawAPI: api, adapter: library });

  // The app's own shortcuts (⌘K, single keys on pages) stay off while drawing; Excalidraw listens on
  // the document, before the window.
  useEffect(() => {
    const stop = (e: KeyboardEvent) => {
      if (view && e.key === "Escape") onClose();
      e.stopPropagation();
    };
    document.addEventListener("keydown", stop);
    return () => document.removeEventListener("keydown", stop);
  }, [view]);

  const close = () => {
    flush();
    onClose();
  };

  /** Links to pages of this app open here (the drawing closes first); others in a new tab. */
  const onLinkOpen = (element: { link: string | null }, event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>) => {
    if (!element.link) return;
    let url: URL;
    try {
      url = new URL(element.link, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin || !url.hash.startsWith("#/")) return;
    event.preventDefault();
    close();
    location.hash = url.hash;
  };

  /** Title, "Bearbeiten" and close. A phone's toolbar needs the whole width: there they sit in the bottom bar. */
  const topRight = (phone: boolean) => (
    <div className={phone ? "drawing-top drawing-top-phone" : "drawing-top"}>
      {phone ? null : view ? (
        <span className="drawing-title" title={item?.title}>
          {item?.title || t("drawing.untitled")}
        </span>
      ) : (
        <input
          key={item?.title}
          className="drawing-title"
          defaultValue={item?.title ?? ""}
          placeholder={t("drawing.untitled")}
          aria-label={t("item.title")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
          }}
          onBlur={(e) => e.target.value !== (item?.title ?? "") && repo.setTitle(id, e.target.value.trim())}
        />
      )}
      {view && (
        <button type="button" className={phone ? "drawing-button drawing-close" : "drawing-button"} onClick={onEdit} aria-label={t("drawing.edit")} title={t("drawing.edit")}>
          <Pencil size={15} /> {!phone && t("drawing.edit")}
        </button>
      )}
      <button type="button" className="drawing-button drawing-close" onClick={close} aria-label={t("drawing.close")} title={t("drawing.close")}>
        <X size={18} />
      </button>
    </div>
  );

  return (
    <div ref={setRoot} className="drawing-full fixed inset-0 z-50" role="dialog" aria-modal aria-label={item?.title || t("kind.drawing")}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initial}
        onChange={onChange}
        theme={dark ? "dark" : "light"}
        langCode={LANG_CODE[lang] ?? "en"}
        viewModeEnabled={view}
        name={item?.title || t("drawing.untitled")}
        handleKeyboardGlobally
        autoFocus
        aiEnabled={false}
        onLinkOpen={onLinkOpen}
        UIOptions={{ canvasActions: { toggleTheme: null } }}
        renderTopRightUI={(phone) => (phone ? root && createPortal(topRight(true), root) : topRight(false))}
      >
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
                <DRAWING_ICON size={28} /> {item?.title || t("kind.drawing")}
              </span>
            </WelcomeScreen.Center.Logo>
            <WelcomeScreen.Center.Heading>{t("drawing.welcome")}</WelcomeScreen.Center.Heading>
            <WelcomeScreen.Center.Menu>
              <WelcomeScreen.Center.MenuItemLoadScene />
              <WelcomeScreen.Center.MenuItemHelp />
            </WelcomeScreen.Center.Menu>
          </WelcomeScreen.Center>
        </WelcomeScreen>
      </Excalidraw>
    </div>
  );
}
