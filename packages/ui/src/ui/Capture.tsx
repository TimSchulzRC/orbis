import { Button as ShadcnButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, CornerDownRight, CornerDownLeft, Layers, Paperclip, X } from "lucide-react";
import { SETTINGS_ID, appendToBody } from "@obtion/core/model";
import { appendTarget } from "@obtion/core/inbox";
import { runQuery } from "@obtion/core/query";
import { useFiles, useRepo, useSpaceId, spaceHref } from "../hooks";
import { shownSpaces, useAccounts } from "../accounts";
import { useT } from "../i18n";
import { capture, extractMentions, recentPlaces, rememberPlace } from "../actions";
import { Kbd, MenuItem, Popover, TypeGlyph, cx, Dialog } from "./bits";
import { ItemPicker } from "./Picker";
import { SpaceScope } from "./Spaces";
import { notify } from "./feedback";
import { NOTE_ICON } from "./icons";
import { entryKey, openShelf, openedIn } from "./inbox";

/**
 * Capture field: Enter saves. Preset is a note (no type); where it goes follows from the model –
 * a note without a place is in the inbox, with a place below it; a type puts it into the list of
 * the type. Below the field: the type (the only chip) and "Einsortieren …" (a plain text button).
 * "/name text" picks a type by name, a page mentioned with @ is offered as the place. In the tray
 * (`append`) the text may instead be added to an entry still in the inbox: Tab or the chip.
 */
export function Capture({ anywhere, ...p }: CaptureProps & { anywhere?: boolean }) {
  const [space, setSpace] = useState(() => (anywhere ? captureSpace() : undefined));
  // the workspaces seen changed (the chips above the inbox list): a capture lands where one looks
  const shown = useAccounts().shown.map((s) => s.id).join();
  useEffect(() => void (anywhere && setSpace(captureSpace())), [shown]);
  if (!space) return <CaptureField {...p} />;
  const choose = (id: string) => (setSpace(id), localStorage.setItem(LAST_SPACE, id));
  return (
    <SpaceScope id={space}>
      <CaptureField {...p} onSpace={choose} />
    </SpaceScope>
  );
}

const LAST_SPACE = "obtion.capture.space";
/** Where a capture from anywhere goes: the one workspace shown, else the one used last if it is shown, else the first shown. */
export function captureSpace(): string | undefined {
  const shown = shownSpaces();
  if (shown.length === 1) return shown[0]!.id;
  const last = localStorage.getItem(LAST_SPACE);
  return (shown.find((s) => s.id === last) ?? shown[0])?.id;
}

interface CaptureProps {
  parent?: string;
  placeholder?: string;
  /** The tray's field: may add the text to an entry in the inbox instead (Tab), Enter still puts it down. */
  append?: boolean;
  autoFocus?: boolean;
  onDone?: () => void;
  compact?: boolean;
}

function CaptureField({ parent, placeholder, append, autoFocus, onDone, compact, onSpace }: CaptureProps & { onSpace?: (id: string) => void }) {
  const r = useRepo();
  const files = useFiles();
  const space = useSpaceId();
  const { spaces } = useAccounts();
  const { t } = useT();
  const [text, setText] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // another workspace: its types and places, the text stays
  useEffect(() => (setType(null), setPlace(null)), [space]);
  const ix = r.index();
  const pinned = (r.get(SETTINGS_ID)?.settings?.captureTypes ?? []).filter((id) => ix.types.has(id));
  const others = [...ix.types.values()].filter((x) => !pinned.includes(x.id)).sort((a, b) => a.schema!.name.localeCompare(b.schema!.name));
  const input = useRef<HTMLTextAreaElement>(null);
  const save = () => {
    const where = parent ?? place ?? undefined;
    const id = capture(text, { type, parent: where }, r);
    if (!id) return;
    if (place && !parent) rememberPlace(place, r);
    // the next thought starts clean: no place or type carried over unseen
    setPlace(null);
    setType(null);
    // the notice says what it became and where, with a way there
    const usedType = r.get(id)?.type ?? null; // "/name" in the text can set it too
    const what = usedType ? ix.typeName(usedType) : t("capture.note");
    const msg = where ? t("capture.notifyUnder", { what, place: ix.get(where)?.title ?? "" }) : usedType ? t("capture.notifyAs", { what }) : t("capture.notifyInbox");
    notify(msg, undefined, { label: t("capture.open"), run: () => (location.hash = spaceHref(space, `/i/${encodeURIComponent(id)}`)) });
    setText("");
    onDone?.();
  };
  // added to an entry still in the inbox: the one put down or opened last, or the one named with "@…"
  const target = append && !parent && text.trim() ? appendTarget(text, runQuery({ where: { inbox: true }, sort: [{ key: "created", desc: true }] }, { ix }).items, openedIn(space ?? ""), (title) => ix.resolveTitle(title)) : undefined;
  const targetTitle = target ? ix.get(target.id)?.title || t("untitled") : "";
  const addTo = () => {
    if (!target) return;
    r.change(target.id, (doc) => appendToBody(doc, target.text));
    setPlace(null);
    setType(null);
    notify(t("capture.appended", { title: targetTitle }), undefined, { label: t("capture.open"), run: () => openShelf(entryKey(space!, target.id)) });
    setText("");
    onDone?.();
  };
  const [focused, setFocused] = useState(!!autoFocus);
  const showRow = !compact && (focused || !!text.trim() || !!type || !!place);
  // a page mentioned with @ is offered as the place, quietly in the same row
  const mentioned = text.includes("@") ? extractMentions(text.split("\n")[0]!, r).mentions.map((m) => ix.resolveTitle(m)).filter((id): id is string => !!id && ix.get(id)?.kind === "info") : [];
  const offer = !parent && mentioned.find((id) => id !== place);
  const pathOf = (id: string) => [...ix.homePath(id), id].map((p) => ix.get(p)?.title ?? "").join(" › ");
  const typeSchema = type ? ix.types.get(type)?.schema : undefined;
  const attach = async (list: FileList | null) => {
    for (const f of [...(list ?? [])]) {
      const res = await files.add(f, f.name, { parent });
      if (res?.id) notify(t("capture.notifyFile", { name: f.name }), undefined, { label: t("capture.open"), run: () => (location.hash = spaceHref(space, `/i/${encodeURIComponent(res.id!)}`)) });
    }
  };
  const ghost = "tap-y inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-hover";
  return (
    <div className="rounded-2xl border border-line bg-surface px-3 py-2 shadow-sm focus-within:border-[var(--focus)]">
      <div className="flex items-start gap-2">
        <Textarea
          ref={input}
          value={text}
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), save());
            else if (e.key === "Tab" && !e.shiftKey && target) (e.preventDefault(), addTo());
          }}
          rows={1}
          placeholder={placeholder ?? (parent ? t("capture.placeholderHere") : t("capture.placeholder"))}
          title={t("capture.hint")}
          className="max-h-48 min-h-7 flex-1 resize-none bg-transparent px-1 py-0.5 text-[15px] outline-none [field-sizing:content] placeholder:text-muted-foreground"
          aria-label={t("capture.title")}
        />
        <label className="mt-0.5 cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-fg" title={t("capture.attach")}>
          <Paperclip size={15} />
          <Input type="file" multiple className="hidden" onChange={(e) => void attach(e.target.files)} aria-label={t("capture.attach")} />
        </label>
        <ShadcnButton variant="plain" size="none" onClick={save} disabled={!text.trim()} className="tap mt-0.5 rounded-md p-1 text-muted-foreground enabled:text-fg enabled:hover:bg-hover disabled:opacity-40" aria-label={t("capture.save")} title={`${t("capture.save")} (↵)`}>
          <ArrowRight size={16} />
        </ShadcnButton>
      </div>
      {picking && (
        <ItemPicker
          title={t("capture.placeTitle")}
          filter={(x) => x.kind === "info"}
          suggestions={[...mentioned.map((id) => ({ id, reason: "mentioned" })), ...recentPlaces(r).map((id) => ({ id, reason: "recent" }))].filter((x, i, l) => l.findIndex((y) => y.id === x.id) === i)}
          onPick={(id) => (setPlace(id), setPicking(false), setTimeout(() => input.current?.focus()))}
          onClose={() => (setPicking(false), setTimeout(() => input.current?.focus()))}
        />
      )}
      {showRow && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1" onMouseDown={(e) => e.preventDefault()}>
          {/* quietly first: add it to an entry in the inbox instead of putting it down on its own */}
          {target && (
            <ShadcnButton variant="plain" size="none" onClick={addTo} title={t("capture.appendHint")} className="tap-y inline-flex h-7 min-w-0 max-w-[60%] shrink items-center max-lg:max-w-full max-lg:basis-full gap-1 rounded-full border border-[color-mix(in_srgb,var(--t-inbox)_45%,transparent)] bg-[color-mix(in_srgb,var(--t-inbox)_10%,transparent)] px-2 text-xs text-warn hover:bg-[color-mix(in_srgb,var(--t-inbox)_18%,transparent)]">
              <CornerDownLeft size={12} className="shrink-0" />
              {/* only the title is cut short, the question stays */}
              {(() => {
                const [before, after] = t("capture.append", { title: "\u0000" }).split("\u0000");
                return (
                  <span className="flex min-w-0 whitespace-pre">
                    <span className="shrink-0">{before}</span>
                    <span className="truncate">{targetTitle}</span>
                    <span className="shrink-0">{after}</span>
                  </span>
                );
              })()}
              <span className="max-lg:hidden">
                <Kbd>Tab</Kbd>
              </span>
            </ShadcnButton>
          )}
          {/* the workspace, when it can be chosen (capture from anywhere) */}
          {onSpace && spaces.length > 1 && (
            <Popover
              trigger={(p) => (
                <ShadcnButton variant="plain" size="none" {...p} className="tap-y inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-line px-2 text-xs hover:bg-hover" aria-label={t("capture.spaceLabel", { name: spaces.find((s) => s.id === space)?.name ?? "" })}>
                  <Layers size={12} className="text-muted-foreground" />
                  {spaces.find((s) => s.id === space)?.name}
                  <ChevronDown size={12} className="text-muted-foreground" />
                </ShadcnButton>
              )}
            >
              {(close) =>
                spaces.map((s) => (
                  <MenuItem key={s.id} active={s.id === space} onClick={() => (close(), onSpace(s.id))}>
                    {s.name}
                  </MenuItem>
                ))
              }
            </Popover>
          )}
          {/* the type: one chip with its symbol and an arrow; the note is preset */}
          <Popover
            trigger={(p) => (
              <ShadcnButton variant="plain" size="none" {...p} className="tap-y inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-line px-2 text-xs hover:bg-hover" aria-label={t("capture.typeLabel", { name: typeSchema?.name ?? t("capture.note") })}>
                {typeSchema ? <TypeGlyph schema={typeSchema} size={12} /> : <NOTE_ICON size={12} style={{ color: "var(--t-note)" }} />}
                {typeSchema?.name ?? t("capture.note")}
                <ChevronDown size={12} className="text-muted-foreground" />
              </ShadcnButton>
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
                <ShadcnButton variant="plain" size="none" onClick={() => setPicking(true)} className={cx(ghost, "text-fg")} title={pathOf(place)}>
                  <CornerDownRight size={12} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{pathOf(place)}</span>
                </ShadcnButton>
                <ShadcnButton variant="plain" size="none" onClick={() => setPlace(null)} className="tap rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("capture.placeRemove")} title={t("capture.placeRemove")}>
                  <X size={12} />
                </ShadcnButton>
              </span>
            ) : (
              <ShadcnButton variant="plain" size="none" onClick={() => setPicking(true)} className={cx(ghost, "text-muted-foreground hover:text-fg")}>
                <CornerDownRight size={12} className="shrink-0" />
                {t("capture.placeOther")}
              </ShadcnButton>
            ))}
          {offer && (
            <ShadcnButton variant="plain" size="none" onClick={() => setPlace(offer)} className={cx(ghost, "text-muted-foreground hover:text-fg")}>
              <CornerDownRight size={12} className="shrink-0" />
              <span className="truncate">{t("capture.placeOffer", { title: ix.get(offer)!.title })}</span>
            </ShadcnButton>
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
      <Capture anywhere append autoFocus onDone={onClose} />
    </Dialog>
  );
}
