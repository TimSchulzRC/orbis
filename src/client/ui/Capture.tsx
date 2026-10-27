import { useRef, useState } from "react";
import { ArrowRight, ChevronDown, CornerDownRight, Paperclip, X } from "lucide-react";
import { SETTINGS_ID } from "../../shared/model";
import { useRepo, itemHref, go } from "../hooks";
import { useT } from "../i18n";
import { askAgent, capture, extractMentions, recentPlaces, rememberPlace } from "../actions";
import { MenuItem, Popover, TypeGlyph, cx, Dialog, modName } from "./bits";
import { ItemPicker } from "./Picker";
import { files } from "../files";
import { repo } from "../repo";
import { notify } from "./feedback";
import { NOTE_ICON } from "./icons";

/**
 * Capture field: Enter saves. Preset is a note (no type); where it goes follows from the model –
 * a note without a place is in the inbox, with a place below it; a type puts it into the list of
 * the type. Below the field: the type (the only chip) and "Einsortieren …" (a plain text button).
 * "/name text" picks a type by name, a page mentioned with @ is offered as the place. ⌘Enter sends
 * it to the agent.
 */
export function Capture({ parent, autoFocus, onDone, compact }: { parent?: string; autoFocus?: boolean; onDone?: () => void; compact?: boolean }) {
  const r = useRepo();
  const { t, lang } = useT();
  const [text, setText] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const ix = r.index();
  const pinned = (r.get(SETTINGS_ID)?.settings?.captureTypes ?? []).filter((id) => ix.types.has(id));
  const others = [...ix.types.values()].filter((x) => !pinned.includes(x.id)).sort((a, b) => a.schema!.name.localeCompare(b.schema!.name));
  const input = useRef<HTMLTextAreaElement>(null);
  const save = () => {
    const where = parent ?? place ?? undefined;
    const id = capture(text, { type, parent: where });
    if (!id) return;
    if (place && !parent) rememberPlace(place);
    // the next thought starts clean: no place or type carried over unseen
    setPlace(null);
    setType(null);
    // the notice says what it became and where, with a way there
    const usedType = repo.get(id)?.type ?? null; // "/name" in the text can set it too
    const what = usedType ? ix.typeName(usedType) : t("capture.note");
    const msg = where ? t("capture.notifyUnder", { what, place: ix.get(where)?.title ?? "" }) : usedType ? t("capture.notifyAs", { what }) : t("capture.notifyInbox");
    notify(msg, undefined, { label: t("capture.open"), run: () => go(itemHref(id).slice(1)) });
    setText("");
    onDone?.();
  };
  const ask = () => {
    askAgent(text);
    setText("");
    onDone?.();
  };
  const [focused, setFocused] = useState(!!autoFocus);
  const showRow = !compact && (focused || !!text.trim() || !!type || !!place);
  // a page mentioned with @ is offered as the place, quietly in the same row
  const mentioned = text.includes("@") ? extractMentions(text.split("\n")[0]!).mentions.map((m) => ix.resolveTitle(m)).filter((id): id is string => !!id && ix.get(id)?.kind === "info") : [];
  const offer = !parent && mentioned.find((id) => id !== place);
  const pathOf = (id: string) => [...ix.homePath(id), id].map((p) => ix.get(p)?.title ?? "").join(" › ");
  const typeSchema = type ? ix.types.get(type)?.schema : undefined;
  const attach = async (list: FileList | null) => {
    for (const f of [...(list ?? [])]) {
      const res = await files.add(f, f.name, { parent });
      if (res?.id) notify(t("capture.notifyFile", { name: f.name }), undefined, { label: t("capture.open"), run: () => go(itemHref(res.id!).slice(1)) });
    }
  };
  const ghost = "tap-y inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-hover";
  return (
    <div className="rounded-2xl border border-line bg-surface px-3 py-2 shadow-sm focus-within:border-[var(--focus)]">
      <div className="flex items-start gap-2">
        <textarea
          ref={input}
          value={text}
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), ask());
            else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), save());
          }}
          rows={1}
          placeholder={parent ? t("capture.placeholderHere") : t("capture.placeholder")}
          title={t("capture.hint")}
          className="max-h-48 min-h-7 flex-1 resize-none bg-transparent px-1 py-0.5 text-[15px] outline-none [field-sizing:content] placeholder:text-muted"
          aria-label={t("capture.title")}
        />
        <label className="mt-0.5 cursor-pointer rounded-md p-1 text-muted hover:bg-hover hover:text-fg" title={t("capture.attach")}>
          <Paperclip size={15} />
          <input type="file" multiple className="hidden" onChange={(e) => void attach(e.target.files)} aria-label={t("capture.attach")} />
        </label>
        <button onClick={save} disabled={!text.trim()} className="tap mt-0.5 rounded-md p-1 text-muted enabled:text-fg enabled:hover:bg-hover disabled:opacity-40" aria-label={t("capture.save")} title={`${t("capture.save")} (↵) · ${t("capture.toAgent", { mod: modName(lang) })}`}>
          <ArrowRight size={16} />
        </button>
      </div>
      {picking && (
        <ItemPicker
          title={t("capture.placeTitle")}
          filter={(x) => x.kind === "info"}
          suggestions={[...mentioned.map((id) => ({ id, reason: "mentioned" })), ...recentPlaces().map((id) => ({ id, reason: "recent" }))].filter((x, i, l) => l.findIndex((y) => y.id === x.id) === i)}
          onPick={(id) => (setPlace(id), setPicking(false), setTimeout(() => input.current?.focus()))}
          onClose={() => (setPicking(false), setTimeout(() => input.current?.focus()))}
        />
      )}
      {showRow && (
        <div className="mt-1 flex min-w-0 items-center gap-1" onMouseDown={(e) => e.preventDefault()}>
          {/* the type: one chip with its symbol and an arrow; the note is preset */}
          <Popover
            trigger={(p) => (
              <button {...p} className="tap-y inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-line px-2 text-xs hover:bg-hover" aria-label={t("capture.typeLabel", { name: typeSchema?.name ?? t("capture.note") })}>
                {typeSchema ? <TypeGlyph schema={typeSchema} size={12} /> : <NOTE_ICON size={12} style={{ color: "var(--t-note)" }} />}
                {typeSchema?.name ?? t("capture.note")}
                <ChevronDown size={12} className="text-muted" />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem active={!type} icon={<NOTE_ICON size={14} style={{ color: "var(--t-note)" }} />} onClick={() => (setType(null), close())}>
                  {t("capture.note")}
                </MenuItem>
                {[...pinned.map((id) => ix.types.get(id)!), ...others].map((x, i) => (
                  <div key={x.id} className={i === pinned.length && pinned.length ? "mt-1 border-t border-line pt-1" : undefined}>
                    <MenuItem active={type === x.id} icon={<TypeGlyph schema={x.schema} size={14} />} onClick={() => (setType(x.id), close())}>
                      {x.schema!.name}
                    </MenuItem>
                  </div>
                ))}
              </>
            )}
          </Popover>
          {/* where it goes: a plain text button, no chip – it is no type */}
          {!parent &&
            (place ? (
              <span className="flex min-w-0 items-center">
                <button onClick={() => setPicking(true)} className={cx(ghost, "text-fg")} title={pathOf(place)}>
                  <CornerDownRight size={12} className="shrink-0 text-muted" />
                  <span className="truncate">{pathOf(place)}</span>
                </button>
                <button onClick={() => setPlace(null)} className="tap rounded-md p-1 text-muted hover:bg-hover hover:text-fg" aria-label={t("capture.placeRemove")} title={t("capture.placeRemove")}>
                  <X size={12} />
                </button>
              </span>
            ) : (
              <button onClick={() => setPicking(true)} className={cx(ghost, "text-muted hover:text-fg")}>
                <CornerDownRight size={12} className="shrink-0" />
                {t("capture.placeOther")}
              </button>
            ))}
          {offer && (
            <button onClick={() => setPlace(offer)} className={cx(ghost, "text-muted hover:text-fg")}>
              <CornerDownRight size={12} className="shrink-0" />
              <span className="truncate">{t("capture.placeOffer", { title: ix.get(offer)!.title })}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CaptureSheet({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  return (
    <Dialog title={t("capture.title")} onClose={onClose}>
      <Capture autoFocus onDone={onClose} />
    </Dialog>
  );
}
