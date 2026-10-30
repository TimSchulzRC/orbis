// One query, two ways in: conditions as chips to click (each opens a short menu: switch off,
// negate, "oder …", remove; "+ Bedingung" adds one), and the same query as text for those who
// like typing (folded away by default).
// Typing understands every language; it is shown in the UI language. Stored is JSON.
import { Input } from "../components/ui/input";
import { useEffect, useState } from "react";
import { X, Plus, ChevronLeft, HelpCircle } from "lucide-react";
import { type Cond, type QueryDef, parseQuery, printQuery } from "@obtion/core/query";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import type { Lang, T } from "@obtion/core/i18n";
import type { Index } from "@obtion/core/graph";
import { Button, MenuItem, Popover } from "./primitives";
import { TypeGlyph } from "./item-look";
import { cn } from "../lib/utils";
import { ItemPicker } from "./Picker";

type Step = "root" | "type" | "status" | "due" | "tag";
type Ctx = { ix: Index; t: T; lang: Lang };

/** How a condition reads on its chip: the text form, "nicht …" for a negation. */
function condLabel(c: Cond, { ix, t, lang }: Ctx): string {
  return "not" in c ? `${t("query.not")} ${condLabel(c.not, { ix, t, lang })}` : printQuery({ where: c }, lang, ix);
}

/**
 * The short menu of conditions to pick from: type, place, status, due, tag, inbox, files.
 * `onUnder` opens the place picker (a dialog, outside the popover).
 */
function CondPicker({ pick, onUnder, context }: { pick: (c: Cond) => void; onUnder: () => void; context?: boolean }) {
  const ix = useIndex();
  const { t } = useT();
  const [step, setStep] = useState<Step>("root");
  const [tag, setTag] = useState("");
  const types = ix.typesByName();
  const back = (
    <Button variant="plain" onClick={() => setStep("root")} className="mb-1 flex items-center gap-1 px-2 text-xs text-muted-foreground hover:text-fg">
      <ChevronLeft size={12} /> {t("query.back")}
    </Button>
  );
  if (step === "type")
    return (
      <>
        {back}
        {types.map((x) => (
          <MenuItem key={x.id} icon={<TypeGlyph schema={x.schema} size={14} />} onClick={() => pick({ type: x.id })}>
            {x.schema.name}
          </MenuItem>
        ))}
      </>
    );
  if (step === "status")
    return (
      <>
        {back}
        {(["open", "active", "done"] as const).map((s) => (
          <MenuItem key={s} onClick={() => pick({ status: s })}>
            {t("query.status." + s)}
          </MenuItem>
        ))}
      </>
    );
  if (step === "due")
    return (
      <>
        {back}
        <MenuItem onClick={() => pick({ prop: "due", op: "<", value: "+0d" })}>{t("query.due.overdue")}</MenuItem>
        <MenuItem onClick={() => pick({ prop: "due", op: "<=", value: "+7d" })}>{t("query.due.week")}</MenuItem>
        <MenuItem onClick={() => pick({ prop: "due", op: "empty" })}>{t("query.due.none")}</MenuItem>
      </>
    );
  if (step === "tag")
    return (
      <div className="p-1">
        {back}
        <Input
          variant="sm"
          autoFocus
          value={tag}
          onChange={(e) => setTag(e.target.value.replace(/^#/, ""))}
          onKeyDown={(e) => e.key === "Enter" && tag.trim() && (pick({ tag: tag.trim().toLowerCase() }), setTag(""))}
          placeholder={t("query.tagName")}
          className="w-48"
        />
      </div>
    );
  return (
    <>
      {types.length > 0 && <MenuItem onClick={() => setStep("type")}>{t("query.cond.type")}</MenuItem>}
      {context && <MenuItem onClick={() => pick({ under: { this: true } })}>{t("query.cond.underThis")}</MenuItem>}
      <MenuItem onClick={onUnder}>{t("query.cond.under")}</MenuItem>
      <MenuItem onClick={() => setStep("status")}>{t("query.cond.status")}</MenuItem>
      <MenuItem onClick={() => setStep("due")}>{t("query.cond.due")}</MenuItem>
      <MenuItem onClick={() => setStep("tag")}>{t("query.cond.tag")}</MenuItem>
      <MenuItem onClick={() => pick({ inbox: true })}>{t("query.cond.inbox")}</MenuItem>
      <MenuItem onClick={() => pick({ file: true })}>{t("query.cond.file")}</MenuItem>
    </>
  );
}

/**
 * One condition as a chip. A click opens its menu: switch off (top level only), negate, add an
 * alternative ("oder …"), remove.
 */
function Chip({ cond, ctx, off, onToggle, onNegate, onOr, onRemove, onUnder, context, quickRemove }: { cond: Cond; ctx: Ctx; off?: boolean; onToggle?: () => void; onNegate?: () => void; onOr?: (c: Cond) => void; onRemove: () => void; onUnder: (then: (c: Cond) => void) => void; context?: boolean; quickRemove?: boolean }) {
  const { t } = ctx;
  const [mode, setMode] = useState<"menu" | "or">("menu");
  const chip = (
    <Popover
      onOpenChange={(o) => o && setMode("menu")}
      trigger={(p) => (
        <Button variant="plain" {...p} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line bg-bg px-1.5 py-0.5 hover:border-focus", off && "line-through opacity-50")} title={off ? t("query.offHint") : undefined}>
          {condLabel(cond, ctx)}
        </Button>
      )}
    >
      {(close) =>
        mode === "or" ? (
          <CondPicker context={context} pick={(c) => (onOr!(c), close())} onUnder={() => (close(), onUnder(onOr!))} />
        ) : (
          <>
            {onToggle && <MenuItem onClick={() => (onToggle(), close())}>{off ? t("query.on") : t("query.off")}</MenuItem>}
            {!off && onNegate && <MenuItem onClick={() => (onNegate(), close())}>{"not" in cond ? t("query.unnegate") : t("query.negate")}</MenuItem>}
            {!off && onOr && <MenuItem onClick={() => setMode("or")}>{t("query.or")}</MenuItem>}
            <MenuItem danger icon={<X size={13} />} onClick={() => (onRemove(), close())}>
              {t("query.removeCond")}
            </MenuItem>
          </>
        )
      }
    </Popover>
  );
  if (!quickRemove) return chip;
  // in the filter line under the tabs: "status:offen ×"
  return (
    <span className="inline-flex items-center">
      {chip}
      <Button variant="plain" onClick={onRemove} className="tap -ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-hover hover:text-fg" aria-label={t("query.removeCondNamed", { cond: condLabel(cond, ctx) })}>
        <X size={12} />
      </Button>
    </span>
  );
}

/** "+ Filter": the short menu of conditions (and the place picker), as its own button. */
export function AddFilter({ onAdd, trigger, context }: { onAdd: (c: Cond) => void; trigger: (p: { onClick: () => void; "aria-expanded": boolean }) => React.ReactNode; context?: boolean }) {
  const { t } = useT();
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Popover trigger={trigger}>{(close) => <CondPicker context={context} pick={(c) => (onAdd(c), close())} onUnder={() => (close(), setPicking(true))} />}</Popover>
      {picking && (
        <ItemPicker
          title={t("query.cond.under")}
          filter={(x) => x.kind === "info"}
          onPick={(id) => (onAdd({ under: { id } }), setPicking(false))}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

/** `bare`: the quiet line under a view's tabs – chips with ×, "+ Filter", no box and no text form. */
export function QueryEditor({ def, onChange, autoFocus, context, bare }: { def: QueryDef; onChange: (d: QueryDef) => void; autoFocus?: boolean; context?: boolean; bare?: boolean }) {
  const ix = useIndex();
  const { t, lang } = useT();
  const ctx: Ctx = { ix, t, lang };
  const printed = printQuery(def, lang, ix);
  const [text, setText] = useState(printed);
  const [errors, setErrors] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const [asText, setAsText] = useState(false);
  const [picking, setPicking] = useState<((c: Cond) => void) | null>(null);
  // switched off: kept here while the editor is open (dimmed, a click switches it back on), not saved
  const [off, setOff] = useState<{ cond: Cond; at: number }[]>([]);
  useEffect(() => {
    if (!focused) setText(printed);
  }, [printed, focused]);
  const commit = (src = text) => {
    const r = parseQuery(src, ix);
    setErrors(r.errors);
    setOff([]);
    onChange(r.def);
  };
  const parts: Cond[] = def.where ? ("and" in def.where ? def.where.and : [def.where]) : [];
  const setParts = (next: Cond[]) => onChange({ ...def, where: next.length === 0 ? undefined : next.length === 1 ? next[0] : { and: next } });
  const add = (c: Cond) => setParts([...parts, c]);
  const replace = (n: number, c: Cond | null) => setParts(c ? parts.map((x, i) => (i === n ? c : x)) : parts.filter((_, i) => i !== n));
  const negate = (c: Cond): Cond => ("not" in c ? c.not : { not: c });
  const switchOff = (n: number) => {
    setOff([...off, { cond: parts[n]!, at: n }]);
    replace(n, null);
  };
  const switchOn = (k: number) => {
    const o = off[k]!;
    setOff(off.filter((_, i) => i !== k));
    const next = [...parts];
    next.splice(Math.min(o.at, next.length), 0, o.cond);
    setParts(next);
  };
  const under = (then: (c: Cond) => void) => setPicking(() => then);
  const chip = (c: Cond, n: number) => {
    // an "or" shows its alternatives one by one, each with its own menu
    if ("or" in c)
      return (
        <span key={n} className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-dashed border-line px-1 py-0.5">
          {c.or.map((alt, k) => (
            <span key={k} className="inline-flex items-center gap-1">
              {k > 0 && <span className="text-muted-foreground">{t("query.orWord")}</span>}
              <Chip
                cond={alt}
                ctx={ctx}
                context={context}
                onUnder={under}
                onNegate={() => replace(n, { or: c.or.map((x, i) => (i === k ? negate(x) : x)) })}
                onOr={(x) => replace(n, { or: [...c.or, x] })}
                onRemove={() => {
                  const rest = c.or.filter((_, i) => i !== k);
                  replace(n, rest.length === 0 ? null : rest.length === 1 ? rest[0]! : { or: rest });
                }}
              />
            </span>
          ))}
        </span>
      );
    return (
      <Chip
        key={n}
        cond={c}
        ctx={ctx}
        context={context}
        onUnder={under}
        onToggle={bare ? undefined : () => switchOff(n)}
        onNegate={() => replace(n, negate(c))}
        onOr={(x) => replace(n, { or: [c, x] })}
        onRemove={() => replace(n, null)}
        quickRemove={bare}
      />
    );
  };
  return (
    <div className={bare ? undefined : "rounded-xl border border-line bg-surface p-2.5"}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {parts.map((p, n) => (
          <span key={n} className="inline-flex items-center gap-1.5">
            {n > 0 && !bare && <span className="text-muted-foreground">{t("query.and")}</span>}
            {chip(p, n)}
          </span>
        ))}
        {off.map((o, k) => (
          <Chip key={"off" + k} cond={o.cond} ctx={ctx} off onUnder={under} onToggle={() => switchOn(k)} onRemove={() => setOff(off.filter((_, i) => i !== k))} />
        ))}
        <Popover
          trigger={(p) => (
            <Button variant="plain" {...p} autoFocus={autoFocus && !parts.length} className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-hover hover:text-fg">
              <Plus size={12} /> {bare ? t("query.addFilter") : t("query.addCond")}
            </Button>
          )}
        >
          {(close) => <CondPicker context={context} pick={(c) => (add(c), close())} onUnder={() => (close(), under(add))} />}
        </Popover>
        {!bare && (
          <Button variant="plain" onClick={() => setAsText(!asText)} className="ml-auto text-muted-foreground hover:text-fg">
            {asText ? t("query.hideText") : t("query.asText")}
          </Button>
        )}
      </div>
      {asText && (
        <div className="mt-2 flex items-center gap-1.5">
          <Input
            variant="bare"
            value={text}
            autoFocus
            onFocus={() => setFocused(true)}
            onBlur={() => (setFocused(false), text !== printed && commit())}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), commit());
              if (e.key === "Escape") setText(printed);
            }}
            spellCheck={false}
            placeholder={t("query.placeholder")}
            aria-label={t("query.label")}
            className={cn("min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground", errors.length > 0 && "text-warn")}
          />
          <span title={t("query.help")} className="cursor-help text-muted-foreground" aria-label={t("query.help")}>
            <HelpCircle size={14} />
          </span>
        </div>
      )}
      {errors.length > 0 && <p className="mt-1 text-xs text-warn">{t("query.errors", { list: errors.join(", ") })}</p>}
      {picking && (
        <ItemPicker
          title={t("query.cond.under")}
          filter={(x) => x.kind === "info"}
          onPick={(id) => {
            picking({ under: { id } });
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
