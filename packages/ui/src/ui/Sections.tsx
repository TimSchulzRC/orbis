// Sections of a page, all derived from "Teil von" and the type's capabilities.
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { NativeSelect } from "../components/ui/native-select";
import { useState } from "react";
import { Plus, Send } from "lucide-react";
import { type Item, type ViewDef } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { fmtBytes, fmtDateTime } from "@obtion/core/i18n";
import { groupItems, runQuery, shownByBlocks } from "@obtion/core/query";
import { dueOf, dueProp, isDone, statusOf, statusProp } from "@obtion/core/traits";
import { repo } from "../repo";
import { itemHref, useIndex } from "../hooks";
import { useT, tr, titleOf } from "../i18n";
import { Card, Button, Seg, SectionTitle, ViewMenu, SectionAction, Popover, MenuItem } from "./primitives";
import { DueLabel, ItemIcon, RelTime, TypeGlyph } from "./item-look";
import { NOTE_ICON } from "./icons";
import { type PageGroup, PageTable } from "./PageTable";
import { shortPath } from "./Row";
import { agentLabel, agentName } from "./AgentNotice";
import { cmpKey } from "@obtion/core/sortkey";
import type { T } from "@obtion/core/i18n";

/** Entries per group of "Darunter" before "Alle …". */
const FEW = 8;
/** Updates shown at first, and at most after "Alle …". */
const UPDATES_FIRST = 3;
const UPDATES_MAX = 50;

/** The type's plural list name ("Tasks"); below an entry of the same type "Unter-{plural}". */
function listTitle(ix: Index, typeId: string, same: boolean): string {
  const plural = ix.typePlural(typeId);
  return same ? tr("children.subOf", { name: plural }) : plural;
}

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

/** A query block in the text lists the open ones already (e.g. "Offene Tasks", unter:diese): one list per page. */
export function listedInText(item: Item, typeId: string, ix: Index): boolean {
  const schema = ix.types.get(typeId)?.schema;
  const open = ix.items(ix.descendants(item.id)).filter((x) => x.type === typeId && !x.deleted && !isDone(x, schema));
  const inText = shownByBlocks(item, ix);
  return open.length > 0 && open.every((x) => inText.has(x.id));
}

export function mainGrouping(item: Item): "sub" | "status" {
  return item.views.main?.group === "status" ? "status" : "sub";
}

/**
 * A list of the page (design rules § 2.4, § 3.2): descendants of one type with a status, over all
 * levels (see `Index.listTypes`). Grouped by sub-project ("Direkt in …" first; groups show even with
 * nothing open) or by status.
 */
export function ChildList({ item, typeId }: { item: Item; typeId: string }) {
  const { t } = useT();
  const ix = useIndex();
  const schema = ix.types.get(typeId)!.schema;
  const view: ViewDef = { showDone: false, ...(item.views.main ?? {}) };
  const setView = (patch: Partial<ViewDef>) => repo.setView(item.id, "main", { ...view, ...patch });
  const same = item.type === typeId; // sub-tasks of a task
  const subOne = (name?: string) => t("children.subOf", { name: name ?? "" }); // "Unter-Task", "Unter-Projekt"
  const all = ix.items(ix.descendants(item.id)).filter((x) => x.type === typeId && !x.deleted);
  const doneCount = all.filter((x) => isDone(x, schema)).length;
  const shown = view.showDone ? all : all.filter((x) => !isDone(x, schema));
  const rank = (x: Item) => ({ active: 0, todo: 1, done: 2 })[statusOf(x, schema)?.group ?? "todo"];
  const due = (x: Item) => dueOf(x, schema) ?? "9999";
  const sorted = [...shown].sort((a, b) => rank(a) - rank(b) || cmpKey(due(a), due(b)) || a.title.localeCompare(b.title));
  const open = all.filter((x) => !isDone(x, schema));
  const title = listTitle(ix, typeId, same);
  if (!all.length) return null;
  // sub-projects: children of the page's own type; each one a group
  const subs = same ? [] : ix.items(ix.childrenOf(item.id)).filter((x) => x.type === item.type && !x.deleted);
  // without a status ("Eigene Liste" on a type without one) there is nothing open or done to group or count
  const hasStatus = !!statusProp(schema);
  const by = subs.length && hasStatus ? mainGrouping(item) : "sub";
  let groups: PageGroup[];
  if (by === "status")
    groups = groupItems(sorted, "status", { ix, thisId: item.id }).map((g) => ({ key: g.key || "_", label: g.label || t("group.none"), items: g.items }));
  else {
    const subOf = (x: Item) => (ix.relPath(item.id, x.id) ?? []).find((p) => subs.some((s) => s.id === p));
    const direct = sorted.filter((x) => !subOf(x));
    groups = [
      ...(direct.length || !subs.length ? [{ key: "direct", label: t("children.directIn", { title: titleOf(item, t) }), items: direct }] : []),
      ...subs.map((s) => ({ key: s.id, label: titleOf(s, t), ref: s.id, items: sorted.filter((x) => subOf(x) === s.id) })),
    ];
  }
  const dueProperty = dueProp(schema);
  const cols = dueProperty ? [{ key: "due", label: dueProperty.name }] : [];
  const subLabel = subOne(ix.typeName(item.type));
  const groupOptions = [{ value: "sub", label: subLabel }, { value: "status", label: t("group.status") }];
  const groupBy = (x: string) => setView({ group: x === "status" ? "status" : "path" });
  return (
    <section className="mt-10 max-md:mt-8">
      <SectionTitle
        count={hasStatus ? t("children.openCount", { count: open.length }) : all.length}
        right={
          subs.length > 0 && hasStatus && (
            <>
              <span className="max-md:hidden">
                <Seg label={t("children.groupBy")} value={by} onChange={groupBy} options={groupOptions} />
              </span>
              <span className="md:hidden">
                <ViewMenu label={by === "status" ? t("group.status") : subLabel} sections={[{ value: by, options: groupOptions, onChange: groupBy }]} />
              </span>
            </>
          )
        }
      >
        {title}
      </SectionTitle>
      <PageTable
        groups={groups}
        cols={cols}
        head={same ? subOne(schema.name) : schema.name}
        here={item.id}
        foldKey={`main:${item.id}`}
        add={{ init: { type: typeId, parents: [item.id] }, label: same ? subOne(schema.name) : t("children.newOf", { name: schema.name }) }}
        done={{ count: doneCount, shown: !!view.showDone, toggle: () => setView({ showDone: !view.showDone }) }}
      />
    </section>
  );
}

/** "+ Darunter anlegen": a child of any type, which then shows in its type's list or group. */
export function AddBelow({ item }: { item: Item }) {
  const { t } = useT();
  const ix = useIndex();
  // undefined: closed; null: a note (no type)
  const [type, setType] = useState<string | null | undefined>(undefined);
  if (type !== undefined)
    return (
      <div className="mt-6">
        <AddRow
          label={t("below.addOf", { name: (type ? ix.typeName(type) : undefined) ?? t("kind.note") })}
          autoFocus
          onAdd={(title) => repo.create({ title, parents: [item.id], ...(type ? { type } : {}) })}
          onDone={() => setType(undefined)}
        />
      </div>
    );
  return (
    <div className="mt-6">
      <Popover trigger={(p) => <SectionAction {...p}>{t("below.add")}</SectionAction>}>
        {(close) => (
          <>
            <MenuItem icon={<NOTE_ICON size={14} style={{ color: "var(--t-note)" }} />} onClick={() => (setType(null), close())}>
              {t("kind.note")}
            </MenuItem>
            {ix.typesByName().map((x) => (
              <MenuItem key={x.id} icon={<TypeGlyph schema={x.schema} size={14} />} onClick={() => (setType(x.id), close())}>
                {x.schema.name}
              </MenuItem>
            ))}
          </>
        )}
      </Popover>
    </div>
  );
}

/** Files of a page that gathers: below it, or used in an entry below it (same as the query unter:diese). */
function filesBelow(item: Item, ix: Index): Item[] {
  return runQuery({ where: { and: [{ file: true }, { under: { id: item.id } }] }, sort: [{ key: "created", desc: true }] }, { ix, thisId: item.id }).items;
}

/** Notes (entries without a type) on every level below, for pages that gather like a project. */
function notesBelow(item: Item, ix: Index): Item[] {
  const hidden = shownByBlocks(item, ix);
  return [...ix.descendants(item.id)]
    .map((id) => ix.get(id)!)
    .filter((x) => x && x.kind === "info" && !ix.typeOf(x) && !hidden.has(x.id))
    .sort((a, b) => b.updated - a.updated);
}

/**
 * "Darunter" (design rules § 3.1, zone 4): what lies below the page and is not shown above. A page
 * that gathers (a project) shows notes and files of all levels.
 */
export function BelowCard({ item, exclude, gathers }: { item: Item; exclude: Set<string>; gathers: boolean }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const [more, setMore] = useState<Set<string>>(new Set());
  const hidden = shownByBlocks(item, ix);
  const isNote = (x: Item) => x.kind === "info" && !ix.typeOf(x);
  const direct = ix.items(ix.childrenOf(item.id)).filter((c) => !c.deleted && !hidden.has(c.id) && !exclude.has(c.id) && !(c.type && exclude.has("type:" + c.type)));
  const notes = gathers ? notesBelow(item, ix) : direct.filter(isNote);
  const files = gathers ? filesBelow(item, ix) : direct.filter((c) => c.kind === "datei");
  const rest = direct.filter((c) => !isNote(c) && c.kind !== "datei");
  const byType = new Map<string, Item[]>();
  for (const c of rest) (byType.get(c.type ?? "") ?? byType.set(c.type ?? "", []).get(c.type ?? "")!).push(c);
  const groups: { key: string; label: string; items: Item[] }[] = [
    ...(notes.length ? [{ key: "notes", label: t("below.untyped"), items: notes }] : []),
    ...(files.length ? [{ key: "files", label: t("below.files"), items: files }] : []),
    ...[...byType.entries()].sort((a, b) => (ix.typeName(a[0]) ?? "").localeCompare(ix.typeName(b[0]) ?? "")).map(([k, items]) => ({ key: "type:" + k, label: listTitle(ix, k, false) || (ix.typeName(k) ?? ""), items })),
  ];
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  if (!count) return null;
  const right = (x: Item) =>
    x.file ? (
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtBytes(lang, x.file.size)}</span>
    ) : isNote(x) ? (
      <span className="shrink-0 text-xs text-muted-foreground"><RelTime ts={x.updated} /></span>
    ) : (
      <DueLabel due={dueOf(x, ix.schemaOf(x))} />
    );
  return (
    <section className="mt-10 max-md:mt-8">
      <SectionTitle count={count}>{t("below.title")}</SectionTitle>
      <Card className="overflow-hidden">
        {groups.map((g) => {
          const all = more.has(g.key);
          return (
            <div key={g.key}>
              <p className="px-3 pb-1 pt-2.5 text-xs font-semibold text-muted-foreground">{g.label}</p>
              {(all ? g.items : g.items.slice(0, FEW)).map((x) => {
                const rel = gathers ? (ix.relPath(item.id, x.id) ?? []) : [];
                return (
                  <a key={x.id} href={itemHref(x.id)} data-id={x.id} className="flex min-h-11 items-center gap-2.5 border-t border-line px-3 py-1.5 first-of-type:border-t-0 hover:bg-hover max-md:min-h-[52px]">
                    <ItemIcon item={x} size={15} className="shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm max-md:text-[15px]">{titleOf(x, t)}</span>
                      {rel.length > 0 && <span className="truncate text-xs text-muted-foreground">{shortPath(rel)}</span>}
                    </span>
                    {right(x)}
                  </a>
                );
              })}
              {g.items.length > FEW && (
                <Button variant="plain" onClick={() => setMore(new Set(all ? [...more].filter((k) => k !== g.key) : [...more, g.key]))} className="tap-y block w-full border-t border-line px-3 py-2 text-left text-[13px] text-muted-foreground hover:text-fg">
                  {all ? t("notes.fewer") : t("notes.all", { count: g.items.length })}
                </Button>
              )}
            </div>
          );
        })}
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
