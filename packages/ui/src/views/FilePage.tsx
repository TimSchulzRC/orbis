// A file behaves like an information whose content is the file itself.
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useEffect, useState } from "react";
import { ArrowRightLeft, Download, Trash2, Replace } from "lucide-react";
import { type FileMeta, type Item, setFileMeta } from "@obtion/core/model";
import { fmtBytes, fmtDate, fmtDuration } from "@obtion/core/i18n";
import { useIndex, leavePage, useDocumentTitle, useFiles, useRepo } from "../hooks";
import { useT, titleOf } from "../i18n";
import { useBlobUrl } from "../files";
import { MenuItem, MoreMenu } from "../ui/primitives";
import { ItemIcon, Tag } from "../ui/item-look";
import { Bezuege, Crumbs, TrashBanner } from "../ui/PageParts";
import { TagInput } from "../ui/TagInput";
import { ItemPicker } from "../ui/Picker";
import { TitleField } from "../ui/TitleField";
import { dateOf } from "@obtion/core/date";
import { who } from "../ui/actor";

export function FilePage({ item }: { item: Item }) {
  const repo = useRepo();
  const files = useFiles();
  const { t, lang } = useT();
  useDocumentTitle(titleOf(item, t));
  const ix = useIndex();
  const file = item.file!;
  const [picking, setPicking] = useState(false);
  const isImg = file.filetype === "bild";
  const display = useBlobUrl(isImg ? (file.display ?? file.hash) : file.filetype === "pdf" ? undefined : file.thumb, true);
  const used = ix.usedIn(item.id);
  const parents = ix.parentsOf(item.id);
  const local = files.hasLocal(file.hash);
  useEffect(() => void files.check(file.hash), [file.hash]);
  // the original on this device ("alles lokal", offline): viewer and download use it instead of the server
  const [localSrc, setLocalSrc] = useState<string | undefined>();
  useEffect(() => {
    let url: string | undefined;
    let gone = false;
    if (local) void files.localUrl(file.hash, file.mime).then((u) => (gone ? u && URL.revokeObjectURL(u) : setLocalSrc((url = u))));
    else setLocalSrc(undefined);
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.hash, local]);
  // audio and video stream from the server (the player loads what it plays), unless the original is here
  const media = localSrc ?? (local ? undefined : files.serverUrl(file.hash));
  const missing = files.isMissing(file.hash);
  // who added it; from before accounts the app wrote only the device: then nobody is named
  const by = item.createdBy ? who(item.createdBy, t) : undefined;
  const addedBy = by && (by.agent || by.person?.id) ? by.label : "";
  const extension = (file.name.split(".").pop() ?? "").toUpperCase();
  const dimensions = file.width && file.height ? `${file.width} × ${file.height}` : "";
  const size = [dimensions, file.pages ? t("file.pages", { count: file.pages }) : "", file.duration ? fmtDuration(file.duration) : "", fmtBytes(lang, file.size)].filter(Boolean).join(" · ");
  const facts: [string, React.ReactNode][] = [
    [t("file.type"), `${t("filetype." + file.filetype)} · ${extension}`],
    [t("file.size"), size],
    [t("file.added"), `${fmtDate(lang, dateOf(item.created))}${addedBy ? " · " + addedBy : ""}`],
    [t("file.here"), local ? t("file.local") : t("file.online")],
  ];
  /** "Ersetzen": new content, same document; the old version stays in the history. */
  const replace = async (upload: File) => {
    const meta = await files.prepare(upload, file.name);
    repo.change(item.id, (doc) =>
      setFileMeta(doc, { ...meta, name: file.name, display: meta.display ?? null, thumb: meta.thumb ?? null, pages: null, text: null, extracted: null, duration: null, history: [...(file.history ?? []), { hash: file.hash, at: Date.now() }] }),
    );
  };
  const tools = (
    <MoreMenu>
      {(close) => (
        <>
          <MenuItem icon={<ArrowRightLeft size={14} />} onClick={() => (close(), setPicking(true))}>
            {parents.length ? t("place.change") : t("place.place")}
          </MenuItem>
          <label className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-hover">
            <Replace size={14} className="text-muted-foreground" /> {t("file.replace")}
            <Input variant="bare" type="file" className="hidden" onChange={(e) => (close(), e.target.files?.[0] && replace(e.target.files[0]))} />
          </label>
          {!item.deleted && (
            <MenuItem danger icon={<Trash2 size={14} />} onClick={() => (close(), repo.remove(item.id), leavePage())}>
              {t("item.delete")}
            </MenuItem>
          )}
        </>
      )}
    </MoreMenu>
  );
  return (
    <div className="page-read">
      {item.deleted && (
        <TrashBanner onRestore={() => repo.restore(item.id)} />
      )}
      {missing && <p className="mb-3 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted-foreground">{t(files.missingKey(item.created) === "file.uploading" ? "file.uploadingHint" : "file.missingHint")}</p>}
      <Crumbs item={item} tools={tools} onPlaces={() => setPicking(true)} onPlace={() => setPicking(true)} />
      <div className="mt-1.5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <TitleField item={item} autoFocus={false} placeholder={file.name} />
        </div>
        <a href={localSrc ?? files.serverUrl(file.hash, file.name, true)} download={localSrc ? file.name : undefined} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-fg hover:bg-hover">
          <Download size={15} /> <span className="max-md:hidden">{t("file.download")}</span>
        </a>
      </div>
      <p className="mt-2.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <ItemIcon item={item} size={13} /> {facts[0]![1]}
      </p>
      {/* facts as the property block (no "+ Eigenschaft") */}
      <div className="mt-[18px] grid grid-cols-[148px_minmax(0,1fr)] gap-x-3 max-md:grid-cols-[124px_minmax(0,1fr)]">
        {[[t("file.name"), file.name] as [string, React.ReactNode], ...facts.slice(1)].map(([label, value]) => (
          <div key={label} className="contents">
            <div className="flex min-h-8 items-center truncate text-[13px] text-muted-foreground pointer-coarse:min-h-11">{label}</div>
            <div className="flex min-h-8 min-w-0 items-center break-all text-sm tabular-nums pointer-coarse:min-h-11">{value}</div>
          </div>
        ))}
        <div className="flex min-h-8 items-center text-[13px] text-muted-foreground pointer-coarse:min-h-11">{t("item.tags")}</div>
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1.5 text-sm pointer-coarse:min-h-11">
          {item.tags.map((x) => (
            <Tag key={x} tag={x} onRemove={() => repo.setMember(item.id, "tags", x, false)} />
          ))}
          <TagInput exclude={item.tags} onAdd={(x) => repo.setMember(item.id, "tags", x, true)} />
        </div>
      </div>
      <div className="mt-5 border-t border-line" />

      <div className="mt-6 overflow-hidden rounded-xl border border-line bg-surface-2">
        {isImg && display && <img src={display} alt={item.body || item.title} className="mx-auto max-h-[70vh] w-auto" />}
        {file.filetype === "pdf" && (!local || localSrc) && <iframe title={item.title} src={localSrc ?? files.serverUrl(file.hash)} className="h-[75vh] w-full bg-white" />}
        {file.filetype === "audio" && media && <audio controls src={media} className="w-full p-4" />}
        {file.filetype === "video" && media && <video controls src={media} className="w-full" />}
        {!isImg && file.filetype !== "pdf" && file.filetype !== "audio" && file.filetype !== "video" && <FileText file={file} missing={missing} />}
      </div>
      {file.filetype === "pdf" && file.text && (
        <details className="mt-3 rounded-xl border border-line bg-surface-2">
          <summary className="cursor-pointer px-4 py-2.5 text-[13px] text-muted-foreground">{t("file.extracted")}</summary>
          <TextBlock text={file.text} mono={false} />
        </details>
      )}
      <Textarea
      variant="inline"
        defaultValue={item.body}
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
    return <div className="flex h-40 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-muted-foreground"><span className="break-all">{f.name}</span><span className="text-[13px] text-faint">{t(reading ? "file.reading" : "file.noText")}</span></div>;
  }
  const extracted = EXTRACTED.test(f.name);
  return (
    <div>
      <div className="border-b border-line px-4 py-2 text-[13px] text-muted-foreground">{t(extracted ? "file.extracted" : "file.content")}</div>
      <TextBlock text={f.text} mono={!PROSE.test(f.name)} />
    </div>
  );
}

function TextBlock({ text, mono }: { text: string; mono: boolean }) {
  const { t } = useT();
  const cut = text.endsWith("\n…");
  return (
    <>
      <pre data-testid="file-text" className={`max-h-[70vh] overflow-auto px-4 py-3 text-[13px] leading-[1.55] whitespace-pre-wrap break-words ${mono ? "font-mono" : "font-sans"}`} tabIndex={0}>
        {cut ? text.slice(0, -2) : text}
      </pre>
      {cut && <p className="border-t border-line px-4 py-2 text-[13px] text-muted-foreground">{t("file.truncated")}</p>}
    </>
  );
}
