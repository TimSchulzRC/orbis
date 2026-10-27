// Full view of an embedded image: click opens it, arrows page through all images of the page,
// Escape closes. Shows the display version at once and the original as soon as it is here.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { repo } from "../repo";
import { files } from "../files";
import { useT } from "../i18n";
import { useModal } from "./bits";

let open: { ids: string[]; at: number } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Open the full view on `ids[at]` (image files); the others are reachable with the arrows. */
export function openLightbox(ids: string[], at: number) {
  const list = ids.filter((id, i) => ids.indexOf(id) === i && repo.get(id)?.file?.filetype === "bild");
  if (!list.length) return;
  open = { ids: list, at: Math.max(0, list.indexOf(ids[at] ?? "")) };
  emit();
}

export function LightboxHost() {
  const o = useSyncExternalStore(subscribe, () => open);
  return o ? <Lightbox ids={o.ids} start={o.at} /> : null;
}

function Lightbox({ ids, start }: { ids: string[]; start: number }) {
  const { t } = useT();
  const [at, setAt] = useState(start);
  const [src, setSrc] = useState<string | undefined>();
  const item = repo.get(ids[at]!);
  const f = item?.file;
  const ref = useRef<HTMLDivElement>(null);
  const close = () => ((open = null), emit());
  const step = (d: number) => setAt((a) => (a + d + ids.length) % ids.length);
  useEffect(() => {
    if (!f) return;
    let live = true;
    setSrc(undefined);
    void files.url(f.display ?? f.hash, { keep: true }).then((u) => live && u && setSrc((s) => s ?? u));
    if (f.display) void files.url(f.hash).then((u) => live && u && setSrc(u));
    return () => void (live = false);
  }, [f?.hash]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [ids.length]);
  useModal(ref, close);
  if (!item || !f) return null;
  const nav = "absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60";
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={item.title} className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm" onClick={close}>
      <div className="flex items-center gap-3 px-4 py-3 text-sm text-white/80 pt-safe" onClick={(e) => e.stopPropagation()}>
        <a href={`#/i/${encodeURIComponent(item.id)}`} onClick={close} className="min-w-0 truncate font-medium text-white hover:underline">
          {item.title}
        </a>
        {ids.length > 1 && <span className="tabular-nums text-white/60">{at + 1} / {ids.length}</span>}
        <button onClick={close} className="tap ml-auto rounded-md p-1.5 hover:bg-white/10" aria-label={t("lightbox.close")}>
          <X size={18} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4">
        {src && <img src={src} alt={item.body || item.title} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />}
        {ids.length > 1 && (
          <>
            <button onClick={(e) => (e.stopPropagation(), step(-1))} className={nav + " left-3"} aria-label={t("lightbox.prev")}>
              <ChevronLeft size={22} />
            </button>
            <button onClick={(e) => (e.stopPropagation(), step(1))} className={nav + " right-3"} aria-label={t("lightbox.next")}>
              <ChevronRight size={22} />
            </button>
          </>
        )}
      </div>
      <p className="min-h-10 px-4 py-3 text-center text-sm text-white/80 pb-safe" onClick={(e) => e.stopPropagation()}>
        {item.body}
      </p>
    </div>
  );
}
