// The page's lower part: "Darunter" (everything below the page, as one tree) and the updates.
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { NativeSelect } from "../components/ui/native-select";
import { Fragment, useState } from "react";
import { ChevronRight, Plus, Send } from "lucide-react";
import { type Item } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { fmtBytes, fmtDateTime } from "@obtion/core/i18n";
import { dueOf, isDone, statusOf, statusProp } from "@obtion/core/traits";
import { cmpKey } from "@obtion/core/sortkey";
import type { T } from "@obtion/core/i18n";
import { repo } from "../repo";
import { itemHref, useIndex, useStoredSet } from "../hooks";
import { useT, titleOf } from "../i18n";
import { Card, Button, SectionTitle, SectionAction, Popover, MenuItem } from "./primitives";
import { DueLabel, ItemIcon, RelTime, TypeGlyph } from "./item-look";
import { NOTE_ICON } from "./icons";
import { ProgressCount } from "./progress";
import { RowStatus } from "./Row";
import { agentLabel, agentName } from "./AgentNotice";
import { KEYS } from "./storage";
import { cn } from "../lib/utils";

/** Updates shown at first, and at most after "Alle …". */
const UPDATES_FIRST = 3;
const UPDATES_MAX = 50;

function AddRow({ label, onAdd, autoFocus, onDone }: { label: string; onAdd: (title: string) => void; autoFocus?: boolean; onDone?: () => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onAdd(text.trim());
        setText("");
      }}
      className="field-within mt-1 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-muted-foreground focus-within:bg-hover"
    >
      <Plus size={17} />
      <Input
        variant="bare"
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => !text.trim() && onDone?.()}
        onKeyDown={(e) => e.key === "Escape" && (setText(""), onDone?.())}
        placeholder={label}
        aria-label={label}
        className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint max-md:text-[15px]"
      />
    </form>
  );
}

/** Which group of "Darunter" an entry belongs to: its type, notes (no type) or files. */
function groupOf(x: Item): string {
  return x.kind === "datei" ? "files" : (x.type ?? "notes");
}

/** Open ones first (running before not started), then by due date and title. */
function order(ix: Index) {
  const rank = (x: Item) => ({ active: 0, todo: 1, done: 2 })[statusOf(x, ix.schemaOf(x))?.group ?? "todo"];
  const due = (x: Item) => dueOf(x, ix.schemaOf(x)) ?? "9999";
  return (a: Item, b: Item) => rank(a) - rank(b) || cmpKey(due(a), due(b)) || a.title.localeCompare(b.title);
}

/**
 * "Darunter" (design rules § 3.1, zone 4): everything below the page, the same for every type.
 * The entries directly below, grouped by type; each one with entries below opens into them, any
 * type, any depth; all start closed. Done ones show at the end of their group.
 */
export function Below({ item }: { item: Item }) {
  const { t, lang } = useT();
  const ix = useIndex();
  // the entries opened to show what lies below them
  const [opened, flip] = useStoredSet(KEYS.fold(`below:${item.id}`));
  // the type of the entry being added at the top: undefined closed, null a note
  const [adding, setAdding] = useState<string | null | undefined>(undefined);
  const cmp = order(ix);
  const done = (x: Item) => isDone(x, ix.schemaOf(x));
  // done ones stay, at the end of their group
  const below = (id: string) => ix.items(ix.childrenOf(id)).filter((c) => !c.deleted);
  const direct = below(item.id);
  const groups = new Map<string, Item[]>();
  for (const c of direct) (groups.get(groupOf(c)) ?? groups.set(groupOf(c), []).get(groupOf(c))!).push(c);
  // types by name, then notes, then files
  const label = (g: string) => (g === "notes" ? t("below.untyped") : g === "files" ? t("below.files") : ix.typePlural(g));
  const rankOf = (g: string) => (g === "files" ? 2 : g === "notes" ? 1 : 0);
  const byGroup = (a: string, b: string) => rankOf(a) - rankOf(b) || label(a).localeCompare(label(b));
  const keys = [...groups.keys()].sort(byGroup);
  const create = (title: string, type: string | null) => repo.create({ title, parents: [item.id], ...(type ? { type } : {}) });
  const typeName = (type: string | null) => (type ? ix.typeName(type) : undefined) ?? t("kind.note");

  const right = (x: Item) => {
    if (x.file) return <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtBytes(lang, x.file.size)}</span>;
    const due = dueOf(x, ix.schemaOf(x));
    if (due) return <DueLabel due={due} done={done(x)} />;
    if (!x.type) return <span className="shrink-0 text-xs text-muted-foreground"><RelTime ts={x.updated} /></span>;
    return null;
  };
  const row = (x: Item, depth: number, path: Set<string>): React.ReactNode => {
    const kids = path.has(x.id) ? [] : below(x.id).sort((a, b) => byGroup(groupOf(a), groupOf(b)) || cmp(a, b));
    const open = kids.length > 0 && opened.has(x.id);
    const progress = ix.progressOf(x);
    const status = statusOf(x, ix.schemaOf(x));
    const blocked = !!status && status.group !== "done" && ix.isBlocked(x);
    const inner = new Set(path).add(x.id);
    return (
      <Fragment key={x.id + ":" + depth}>
        <div data-id={x.id} className="flex min-h-10 items-center gap-2 border-t border-line pr-3 hover:bg-hover max-md:min-h-[48px]" style={{ paddingLeft: 6 + depth * 22 }}>
          {kids.length > 0 ? (
            <Button variant="plain" onClick={() => flip(x.id, !opened.has(x.id))} aria-expanded={open} aria-label={open ? t("below.close") : t("below.open")} className="tap-edge flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg">
              <ChevronRight size={13} className={cn("transition-transform", open && "rotate-90")} />
            </Button>
          ) : (
            <span className="size-5 shrink-0" />
          )}
          <RowStatus item={x} size={15} />
          <a href={itemHref(x.id)} className={cn("min-w-0 truncate text-sm hover:underline max-md:text-[15px]", done(x) && "text-muted-foreground line-through")}>
            {titleOf(x, t)}
          </a>
          {progress && progress.total > 0 && <ProgressCount done={progress.done} total={progress.total} className="shrink-0 text-xs text-muted-foreground" />}
          {blocked && <span className="shrink-0 text-xs text-warn">{t("row.blocked")}</span>}
          {!open && kids.length > 0 && !progress?.total && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{kids.length}</span>}
          <span className="ml-auto shrink-0">{right(x)}</span>
        </div>
        {open && kids.map((k) => row(k, depth + 1, inner))}
      </Fragment>
    );
  };

  const addMenu = (
    <Popover trigger={(p) => <SectionAction {...p}>{t("below.add")}</SectionAction>}>
      {(close) => (
        <>
          <MenuItem icon={<NOTE_ICON size={14} style={{ color: "var(--t-note)" }} />} onClick={() => (setAdding(null), close())}>
            {t("kind.note")}
          </MenuItem>
          {ix.typesByName().map((x) => (
            <MenuItem key={x.id} icon={<TypeGlyph schema={x.schema} size={14} />} onClick={() => (setAdding(x.id), close())}>
              {x.schema.name}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
  const addRow = adding !== undefined && (
    <div className="border-b border-line px-1">
      <AddRow label={t("below.addOf", { name: typeName(adding) })} autoFocus onAdd={(title) => create(title, adding)} onDone={() => setAdding(undefined)} />
    </div>
  );
  // nothing below: only the button
  if (!direct.length)
    return (
      <div className="mt-6">
        {adding === undefined ? addMenu : <Card className="overflow-hidden">{addRow}</Card>}
      </div>
    );
  return (
    <section className="mt-10 max-md:mt-8">
      <SectionTitle
        count={direct.length}
        right={addMenu}
      >
        {t("below.title")}
      </SectionTitle>
      <Card className="overflow-hidden">
        {addRow}
        {keys.map((g) => (
          <div key={g}>
            <p className="px-3 pb-1.5 pt-3 text-xs font-semibold text-muted-foreground first:pt-2.5">{label(g)}</p>
            {groups
              .get(g)!
              .sort(cmp)
              .map((x) => row(x, 0, new Set([item.id])))}
            {g !== "files" && (
              <div className="border-t border-line px-1">
                <AddRow label={typeName(g === "notes" ? null : g)} onAdd={(title) => create(title, g === "notes" ? null : g)} />
              </div>
            )}
          </div>
        ))}
      </Card>
    </section>
  );
}

/** Dated updates of this page and its descendants, with an optional status change. */
export function Updates({ item }: { item: Item }) {
  const ix = useIndex();
  const { t, lang } = useT();
  const schema = ix.schemaOf(item);
  const statusProperty = statusProp(schema);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [writing, setWriting] = useState(false);
  const [all, setAll] = useState(false);
  const every = [item, ...[...ix.descendants(item.id)].map((id) => ix.get(id)!)]
    .flatMap((x) => x.updates.map((u) => ({ u, from: x })))
    .sort((a, b) => b.u.at - a.u.at);
  const entries = every.slice(0, all ? UPDATES_MAX : UPDATES_FIRST);
  const submit = () => {
    if (!text.trim()) return;
    repo.addUpdate(item.id, text.trim(), status && statusProperty ? { prop: statusProperty.id, option: status } : undefined);
    setText("");
    setStatus("");
    setWriting(false);
  };
  // no updates and not writing one: the section is not there ("+ Update" is in the page menu then)
  if (!every.length && !writing) return <UpdateStarter onStart={() => setWriting(true)} />;
  return (
    <section className="mt-10">
      <SectionTitle
        count={every.length || undefined}
        right={
          !writing && (
            <SectionAction onClick={() => setWriting(true)}>{t("updates.one")}</SectionAction>
          )
        }
      >
        {t("updates.title")}
      </SectionTitle>
      {writing && (
      <Card className="mb-4 p-3 focus-within:border-focus">
        <Textarea
          autoFocus
          onBlur={() => !text.trim() && setWriting(false)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
          }}
          rows={text ? 3 : 1}
          placeholder={t("updates.placeholder")}
          className="w-full resize-none bg-transparent px-1 text-[15px] outline-none placeholder:text-muted-foreground"
          aria-label={t("updates.write")}
        />
        {text && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {statusProperty && (
              <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-line bg-bg px-1.5 py-1 text-xs text-muted-foreground" aria-label={t("updates.status")}>
                <option value="">{t("updates.keepStatus")}</option>
                {statusProperty.options?.filter((o) => o.id !== item.props[statusProperty.id]).map((o) => (
                  <option key={o.id} value={o.id}>
                    → {o.name}
                  </option>
                ))}
              </NativeSelect>
            )}
            <Button variant="primary" onClick={submit}>
              <Send size={14} /> {t("updates.post")}
            </Button>
          </div>
        )}
      </Card>
      )}
      {entries.length > 0 && (
        <ol className="relative ml-1 space-y-4 border-l border-line pl-5">
          {entries.map(({ u, from }) => {
            const newStatus = statusProperty?.options?.find((o) => o.id === u.status) ?? ix.schemaOf(from)?.properties.flatMap((p) => p.options ?? []).find((o) => o.id === u.status);
            return (
              <li key={u.id} className="relative">
                <span className="absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-bg" style={{ background: u.by === "you" ? "var(--faint)" : "var(--ok)" }} />
                <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                  <span>{fmtDateTime(lang, u.at)}</span>
                  {from.id !== item.id && (
                    <span className="inline-flex items-center gap-1">
                      · <ItemIcon item={from} size={11} /> {from.title}
                    </span>
                  )}
                  <span title={u.by}>· {authorLabel(u.by, t)}</span>
                  {newStatus && <span>· {t("updates.statusTo", { name: newStatus.name })}</span>}
                </div>
                <div className="whitespace-pre-wrap text-[15px]">{u.text}</div>
              </li>
            );
          })}
        </ol>
      )}
      {every.length > UPDATES_FIRST && (
        <Button variant="plain" onClick={() => setAll(!all)} className="tap-y mt-2 text-[13px] text-muted-foreground hover:text-fg">
          {all ? t("updates.fewer") : t("updates.all", { count: every.length })}
        </Button>
      )}
    </section>
  );
}

/** Who wrote an update: "Du", an import, or the agent's name. */
function authorLabel(by: string, t: T): string {
  if (by === "you") return t("updates.you");
  if (by.startsWith("import:")) return t("updates.import");
  return agentLabel(agentName(by) ?? by, t);
}

/** A type with updates but none yet: one quiet row to write the first. */
function UpdateStarter({ onStart }: { onStart: () => void }) {
  const { t } = useT();
  return (
    <div className="mt-6">
      <SectionAction onClick={onStart} className="h-8 gap-1.5 px-1">
        {t("updates.one")}
      </SectionAction>
    </div>
  );
}
