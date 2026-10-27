// A file behaves like an information whose content is the file itself: title, description,
// tags, refs, "Teil von", and "Verwendet in" instead of a folder.
import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Download, Trash2, RotateCcw, MoreHorizontal, Replace } from "lucide-react";
import { type Item, setFileMeta, todayISO } from "../../shared/model";
import { fmtBytes, fmtDate } from "../../shared/i18n";
import { useIndex, go } from "../hooks";
import { repo } from "../repo";
import { useT } from "../i18n";
import { files, useBlobUrl } from "../files";
import { Button, ItemIcon, MenuItem, Popover, Tag, IconButton } from "../ui/bits";
import { Bezuege, Crumbs } from "../ui/PageParts";
import { TagInput } from "../ui/TagInput";
import { ItemPicker } from "../ui/Picker";
import { TitleField } from "../ui/TitleField";
import { fmtDuration } from "../ui/Results";

export function FilePage({ item }: { item: Item }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const f = item.file!;
  const [picking, setPicking] = useState(false);
  const isImg = f.filetype === "bild";
  const display = useBlobUrl(isImg ? (f.display ?? f.hash) : f.filetype === "pdf" ? undefined : f.thumb, true);
  const [orig, setOrig] = useState<string | undefined>();
  const used = ix.usedIn(item.id);
  const parents = ix.parentsOf(item.id);
  const home = ix.home(item.id);
  const path = ix.homePath(item.id);
  const local = files.hasLocal(f.hash);
  useEffect(() => {
    if (f.filetype === "audio" || f.filetype === "video") files.url(f.hash).then(setOrig);
    else void files.check(f.hash);
  }, [f.hash]);
  // the original on this device ("alles lokal", offline): viewer and download use it instead of the hub
  const [localSrc, setLocalSrc] = useState<string | undefined>();
  useEffect(() => {
    let url: string | undefined;
    let gone = false;
    if (local) void files.localUrl(f.hash, f.mime).then((u) => (gone ? u && URL.revokeObjectURL(u) : setLocalSrc((url = u))));
    else setLocalSrc(undefined);
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [f.hash, local]);
  const missing = files.isMissing(f.hash);
  const desc = useMemo(() => item.body, [item.body]);
  const facts: [string, React.ReactNode][] = [
    [t("file.type"), `${t("filetype." + f.filetype)} · ${(f.name.split(".").pop() ?? "").toUpperCase()}`],
    [t("file.size"), [f.width && f.height ? `${f.width} × ${f.height}` : "", f.pages ? t("file.pages", { count: f.pages }) : "", f.duration ? fmtDuration(f.duration) : "", fmtBytes(lang, f.size)].filter(Boolean).join(" · ")],
    [t("file.added"), `${fmtDate(lang, todayISO(new Date(item.created)))}${item.createdBy?.includes("@") ? " · " + item.createdBy.split("@")[1]!.split("-")[0] : ""}`],
    [t("file.here"), local ? t("file.local") : t("file.online")],
  ];
  /** "Ersetzen": new content, same document; the old version stays in the history. */
  const replace = async (file: File) => {
    const meta = await files.prepare(file, f.name);
    repo.change(item.id, (doc) =>
      setFileMeta(doc, { ...meta, name: f.name, display: meta.display ?? (null as any), thumb: meta.thumb ?? (null as any), pages: null as any, text: null as any, duration: null as any, history: [...(f.history ?? []), { hash: f.hash, at: Date.now() }] }),
    );
  };
  const tools = (
    <Popover align="right" trigger={(p) => <IconButton {...p} label={t("more")} icon={MoreHorizontal} />}>
      {(close) => (
        <>
          <MenuItem icon={<ArrowRightLeft size={14} />} onClick={() => (close(), setPicking(true))}>
            {parents.length ? t("place.change") : t("place.place")}
          </MenuItem>
          <label className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-hover">
            <Replace size={14} className="text-muted" /> {t("file.replace")}
            <input type="file" className="hidden" onChange={(e) => (close(), e.target.files?.[0] && replace(e.target.files[0]))} />
          </label>
          {!item.deleted && (
            <MenuItem danger icon={<Trash2 size={14} />} onClick={() => (close(), repo.remove(item.id), history.length > 1 ? history.back() : go("/"))}>
              {t("item.delete")}
            </MenuItem>
          )}
        </>
      )}
    </Popover>
  );
  return (
    <div className="page-read">
      {item.deleted && (
        <div className="mb-4 flex items-center gap-3 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-danger">
          {t("item.inTrash")}
          <Button onClick={() => repo.restore(item.id)} className="ml-auto">
            <RotateCcw size={14} /> {t("item.restore")}
          </Button>
        </div>
      )}
      {missing && <p className="mb-3 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted">{t(files.missingKey(item.created) === "file.uploading" ? "file.uploadingHint" : "file.missingHint")}</p>}
      <Crumbs item={item} tools={tools} onPlaces={() => setPicking(true)} onPlace={() => setPicking(true)} />
      <div className="mt-1.5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <TitleField item={item} autoFocus={false} placeholder={f.name} />
        </div>
        <a href={localSrc ?? files.hubUrl(f.hash, f.name, true)} download={localSrc ? f.name : undefined} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-fg hover:bg-hover">
          <Download size={15} /> <span className="max-md:hidden">{t("file.download")}</span>
        </a>
      </div>
      <p className="mt-2.5 flex items-center gap-1.5 text-[13px] text-muted">
        <ItemIcon item={item} size={13} /> {facts[0]![1]}
      </p>
      {/* facts as the property block (no "+ Eigenschaft") */}
      <div className="mt-[18px] grid grid-cols-[148px_minmax(0,1fr)] gap-x-3 max-md:grid-cols-[124px_minmax(0,1fr)]">
        {[[t("file.name"), f.name] as [string, React.ReactNode], ...facts.slice(1)].map(([k, v]) => (
          <div key={k} className="contents">
            <div className="flex min-h-8 items-center truncate text-[13px] text-muted pointer-coarse:min-h-11">{k}</div>
            <div className="flex min-h-8 min-w-0 items-center break-all text-sm tabular-nums pointer-coarse:min-h-11">{v}</div>
          </div>
        ))}
        <div className="flex min-h-8 items-center text-[13px] text-muted pointer-coarse:min-h-11">{t("item.tags")}</div>
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1.5 text-sm pointer-coarse:min-h-11">
          {item.tags.map((x) => (
            <Tag key={x} tag={x} onRemove={() => repo.setMember(item.id, "tags", x, false)} />
          ))}
          <TagInput exclude={item.tags} onAdd={(x) => repo.setMember(item.id, "tags", x, true)} />
        </div>
      </div>
      <div className="mt-5 border-t border-line" />

      {/* the file itself, as wide as the column, and its description */}
      <div className="mt-6 overflow-hidden rounded-xl border border-line bg-surface-2">
        {isImg && display && <img src={display} alt={item.body || item.title} className="mx-auto max-h-[70vh] w-auto" />}
        {f.filetype === "pdf" && (!local || localSrc) && <iframe title={item.title} src={localSrc ?? files.hubUrl(f.hash)} className="h-[75vh] w-full bg-white" />}
        {f.filetype === "audio" && orig && <audio controls src={orig} className="w-full p-4" />}
        {f.filetype === "video" && orig && <video controls src={orig} className="w-full" />}
        {!isImg && f.filetype !== "pdf" && f.filetype !== "audio" && f.filetype !== "video" && <div className="flex h-40 items-center justify-center text-sm text-muted">{f.name}</div>}
      </div>
      <textarea
        defaultValue={desc}
        key={item.id}
        onBlur={(e) => e.target.value !== item.body && repo.setBody(item.id, e.target.value)}
        placeholder={t("file.descriptionPlaceholder")}
        aria-label={t("file.description")}
        rows={2}
        className="field mt-4 w-full resize-y bg-transparent text-[15px] leading-[1.65] outline-none placeholder:text-faint max-md:text-base"
      />

      <Bezuege item={item} typeArea={false} usedIn={used.map((b) => ({ item: ix.get(b.from)!, note: t("file.use." + b.kind) })).filter((x) => x.item)} />
      {picking && (
        <ItemPicker
          title={parents.length ? t("place.changeTitle") : t("place.add")}
          exclude={(x) => x.id === item.id || parents.includes(x.id) || x.kind !== "info"}
          onPick={(p) => {
            repo.addParent(item.id, p);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
