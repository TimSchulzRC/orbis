import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, CornerDownRight, Layers, Paperclip, X } from "lucide-react";
import { useFiles, useRepo, useSpaceId, openItem } from "../hooks";
import { shownSpaces, useAccounts } from "../accounts";
import { useT } from "../i18n";
import { capture, extractMentions, recentPlaces, rememberPlace } from "../actions";
import { Button, MenuItem, Popover, Dialog, IconButton } from "./primitives";
import { TypeGlyph } from "./item-look";
import { cn } from "../lib/utils";
import { ItemPicker } from "./Picker";
import { SpaceScope } from "./Spaces";
import { notify } from "./feedback";
import { NOTE_ICON } from "./icons";
import { KEYS, readJSON, writeJSON } from "./storage";

/**
 * Enter saves. Without a type it is a note, in the inbox or below its place. "/name text" picks a
 * type by name, and a page mentioned with @ is offered as the place.
 */
export function Capture({ anywhere, ...p }: CaptureProps & { anywhere?: boolean }) {
  const [space, setSpace] = useState(() => (anywhere ? captureSpace() : undefined));
  // re-pick when the shown workspaces change, so a capture lands where one looks
  const shown = useAccounts().shown.map((s) => s.id).join();
  useEffect(() => void (anywhere && setSpace(captureSpace())), [shown]);
  if (!space) return <CaptureField {...p} />;
  const choose = (id: string) => (setSpace(id), writeJSON(KEYS.captureSpace, id));
  return (
    <SpaceScope id={space}>
      <CaptureField {...p} onSpace={choose} />
    </SpaceScope>
  );
}

export function captureSpace(): string | undefined {
  const shown = shownSpaces();
  if (shown.length === 1) return shown[0]!.id;
  const last = readJSON(KEYS.captureSpace, "");
  return (shown.find((s) => s.id === last) ?? shown[0])?.id;
}

interface CaptureProps {
  parent?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onDone?: () => void;
  compact?: boolean;
}

function CaptureField({ parent, placeholder, autoFocus, onDone, compact, onSpace }: CaptureProps & { onSpace?: (id: string) => void }) {
  const repo = useRepo();
  const files = useFiles();
  const space = useSpaceId();
  const { spaces } = useAccounts();
  const { t } = useT();
  const [text, setText] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // a workspace switch drops type and place but keeps the text
  useEffect(() => (setType(null), setPlace(null)), [space]);
  const ix = repo.index();
  const pinned = ix.captureTypes();
  const others = ix.typesByName().filter((x) => !pinned.includes(x.id));
  const input = useRef<HTMLTextAreaElement>(null);
  const save = () => {
    const where = parent ?? place ?? undefined;
    const id = capture(text, { type, parent: where }, repo);
    if (!id) return;
    if (place && !parent) rememberPlace(place);
    // never carry place or type over unseen into the next capture
    setPlace(null);
    setType(null);
    const usedType = repo.get(id)?.type ?? null; // "/name" in the text can set it too
    const what = usedType ? ix.typeName(usedType) : t("capture.note");
    const msg = where ? t("capture.notifyUnder", { what, place: ix.get(where)?.title ?? "" }) : usedType ? t("capture.notifyAs", { what }) : t("capture.notifyInbox");
    notify.action(msg, t("capture.open"), () => openItem(id, { space }));
    setText("");
    onDone?.();
  };
  const [focused, setFocused] = useState(!!autoFocus);
  const showRow = !compact && (focused || !!text.trim() || !!type || !!place);
  const mentioned = text.includes("@") ? extractMentions(text.split("\n")[0]!, repo).mentions.map((m) => ix.resolveTitle(m)).filter((id): id is string => !!id && ix.get(id)?.kind === "info") : [];
  const offer = !parent && mentioned.find((id) => id !== place);
  const pathOf = (id: string) => ix.pathText([...ix.homePath(id), id]);
  const typeSchema = type ? ix.types.get(type)?.schema : undefined;
  const attach = async (list: FileList | null) => {
    for (const f of [...(list ?? [])]) {
      const res = await files.add(f, f.name, { parent });
      if (res?.id) notify.action(t("capture.notifyFile", { name: f.name }), t("capture.open"), () => openItem(res.id!, { space }));
    }
  };
  const ghost = "tap-y inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-hover";
  const chip = "tap-y inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-line px-2 text-xs hover:bg-hover";
  const spaceName = spaces.find((s) => s.id === space)?.name;
  const refocus = () => setTimeout(() => input.current?.focus());
  return (
    <div data-capture className="rounded-2xl border border-line bg-surface px-3 py-2 shadow-sm focus-within:border-focus">
      <div className="flex items-start gap-2">
        <Textarea
          variant="inline"
          ref={input}
          value={text}
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), save());
          }}
          rows={1}
          placeholder={placeholder ?? (parent ? t("capture.placeholderHere") : t("capture.placeholder"))}
          title={t("capture.hint")}
          className="max-h-48 min-h-7 flex-1 resize-none bg-transparent px-1 py-0.5 text-[15px] outline-none focus-visible:ring-0 [field-sizing:content] placeholder:text-muted-foreground"
          aria-label={t("capture.title")}
        />
        <label className="mt-0.5 cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-fg" title={t("capture.attach")}>
          <Paperclip size={15} />
          <Input variant="bare" type="file" multiple className="hidden" onChange={(e) => void attach(e.target.files)} aria-label={t("capture.attach")} />
        </label>
        <Button variant="plain" onClick={save} disabled={!text.trim()} className="tap mt-0.5 rounded-md p-1 text-muted-foreground enabled:text-fg enabled:hover:bg-hover disabled:opacity-40" aria-label={t("capture.save")} title={`${t("capture.save")} (↵)`}>
          <ArrowRight size={16} />
        </Button>
      </div>
      {picking && (
        <ItemPicker
          title={t("capture.placeTitle")}
          filter={(x) => x.kind === "info"}
          suggestions={[...mentioned.map((id) => ({ id, reason: "mentioned" as const })), ...recentPlaces(repo).map((id) => ({ id, reason: "recent" as const }))].filter((x, i, l) => l.findIndex((y) => y.id === x.id) === i)}
          onPick={(id) => (setPlace(id), setPicking(false), refocus())}
          onClose={() => (setPicking(false), refocus())}
        />
      )}
      {showRow && (
        <div className="mt-1 flex min-w-0 items-center gap-1" onMouseDown={(e) => e.preventDefault()}>
          {onSpace && spaces.length > 1 && (
            <Popover
              trigger={(p) => (
                <Button variant="plain" {...p} className={chip} aria-label={t("capture.spaceLabel", { name: spaceName ?? "" })}>
                  <Layers size={12} className="text-muted-foreground" />
                  {spaceName}
                  <ChevronDown size={12} className="text-muted-foreground" />
                </Button>
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
          <Popover
            trigger={(p) => (
              <Button variant="plain" {...p} className={chip} aria-label={t("capture.typeLabel", { name: typeSchema?.name ?? t("capture.note") })}>
                {typeSchema ? <TypeGlyph schema={typeSchema} size={12} /> : <NOTE_ICON size={12} style={{ color: "var(--t-note)" }} />}
                {typeSchema?.name ?? t("capture.note")}
                <ChevronDown size={12} className="text-muted-foreground" />
              </Button>
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
                      {x.schema.name}
                    </MenuItem>
                  </div>
                ))}
              </>
            )}
          </Popover>
          {/* a text button, not a chip – the place is no type */}
          {!parent &&
            (place ? (
              <span className="flex min-w-0 items-center">
                <Button variant="plain" onClick={() => setPicking(true)} className={cn(ghost, "text-fg")} title={pathOf(place)}>
                  <CornerDownRight size={12} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{pathOf(place)}</span>
                </Button>
                <IconButton size="sm" icon={X} iconSize={12} onClick={() => setPlace(null)} label={t("capture.placeRemove")} />
              </span>
            ) : (
              <Button variant="plain" onClick={() => setPicking(true)} className={cn(ghost, "text-muted-foreground hover:text-fg")}>
                <CornerDownRight size={12} className="shrink-0" />
                {t("capture.placeOther")}
              </Button>
            ))}
          {offer && (
            <Button variant="plain" onClick={() => setPlace(offer)} className={cn(ghost, "text-muted-foreground hover:text-fg")}>
              <CornerDownRight size={12} className="shrink-0" />
              <span className="truncate">{t("capture.placeOffer", { title: ix.get(offer)!.title })}</span>
            </Button>
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
      <Capture anywhere autoFocus onDone={onClose} />
    </Dialog>
  );
}
