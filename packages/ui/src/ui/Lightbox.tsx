// Shows the display version at once and swaps in the original once it is on the device.
import { ModalSurface } from "../components/ui/dialog";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { repo } from "../repo";
import { files } from "../files";
import { itemHref } from "../hooks";
import { useT } from "../i18n";
import { Button } from "./primitives";
import { createStore } from "../lib/store";

const open = createStore<{ ids: string[]; at: number } | null>(null);

export function openLightbox(ids: string[], at: number) {
  const list = ids.filter((id, i) => ids.indexOf(id) === i && repo.get(id)?.file?.filetype === "image");
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
  const step = (delta: number) => setAt((a) => (a + delta + ids.length) % ids.length);
  useEffect(() => {
    if (!file) return;
    let live = true;
    setSrc(undefined);
    void files.url(file.display ?? file.hash, { keep: true }).then((url) => live && url && setSrc((s) => s ?? url));
    if (file.display) void files.url(file.hash).then((url) => live && url && setSrc(url));
    return () => void (live = false);
  }, [file?.hash]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ids.length]);
  if (!item || !file) return null;
  const nav = "absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60";
  return (
    <ModalSurface title={item.title} onClose={close}><div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm" onClick={close}>
      <div className="flex items-center gap-3 px-4 py-3 text-sm text-white/80 pt-safe" onClick={(e) => e.stopPropagation()}>
        <a href={itemHref(item.id)} onClick={close} className="min-w-0 truncate font-medium text-white hover:underline">
          {item.title}
        </a>
        {ids.length > 1 && <span className="tabular-nums text-white/60">{at + 1} / {ids.length}</span>}
        <Button variant="plain" onClick={close} className="tap ml-auto rounded-md p-1.5 hover:bg-white/10" aria-label={t("lightbox.close")}>
          <X size={18} />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4">
        {src && <img src={src} alt={item.body || item.title} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />}
        {ids.length > 1 && (
          <>
            <Button variant="plain" onClick={(e) => (e.stopPropagation(), step(-1))} className={nav + " left-3"} aria-label={t("lightbox.prev")}>
              <ChevronLeft size={22} />
            </Button>
            <Button variant="plain" onClick={(e) => (e.stopPropagation(), step(1))} className={nav + " right-3"} aria-label={t("lightbox.next")}>
              <ChevronRight size={22} />
            </Button>
          </>
        )}
      </div>
      <p className="min-h-10 px-4 py-3 text-center text-sm text-white/80 pb-safe" onClick={(e) => e.stopPropagation()}>
        {item.body}
      </p>
    </div></ModalSurface>
  );
}
