import { Button as ShadcnButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { NativeSelect } from "../components/ui/native-select";
// Sections of a page, all derived from "Teil von" and the type's capabilities:
// the main child list (e.g. tasks of a project, over all levels), same-type children
// (sub-projects), other children, notes (children without a type) and updates.
import { useState } from "react";
import { Plus, Send, Sparkles } from "lucide-react";
import { type Item, type ViewDef, titleKey } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { LANGS, translate } from "@obtion/core/i18n";
import { groupItems, runQuery, shownByBlocks } from "@obtion/core/query";
import { fmtBytes, fmtDateTime } from "@obtion/core/i18n";
import { dueOf, dueProp, isDone, priorityProp, statusOf, statusProp } from "@obtion/core/traits";
import { repo } from "../repo";
import { itemHref, useIndex } from "../hooks";
import { useT, tr } from "../i18n";
import { Button, DueLabel, ItemIcon, RelTime, Seg, SectionTitle, ViewMenu } from "./bits";
import { type PageGroup, PageTable } from "./Table";
import { shortPath } from "./Row";
import { askAgent } from "../actions";
import { agentLabel } from "./AgentNotice";

/**
 * What a list of entries of a type is called: the name of the type's list (a plural, "Tasks",
 * "Projekte"). Below an entry of the same type: "Unteraufgaben"
 * for the shipped task (found by name, in either language), otherwise "Unter-{plural}".
 */
function listTitle(ix: Index, typeId: string, same: boolean): string {
  const plural = ix.typePlural(typeId);
  if (!same) return plural;
  const name = titleKey(ix.typeName(typeId) ?? "");
  const isTask = LANGS.some((l) => titleKey(translate(l, "setup.task.name")) === name);
  return isTask ? tr("children.subtasks") : tr("children.subOf", { name: plural });
}

/** A quiet count next to a section title. */
function AddRow({ label, onAdd, autoFocus, onDone }: { label: string; onAdd: (title: string) => void; autoFocus?: boolean; onDone?: () => void }) {
  const [v, setV] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!v.trim()) return;
        onAdd(v.trim());
        setV("");
      }}
      className="field-within mt-1 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-muted-foreground focus-within:bg-hover"
    >
      <Plus size={17} />
      <Input
        value={v}
        autoFocus={autoFocus}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => !v.trim() && onDone?.()}
        onKeyDown={(e) => e.key === "Escape" && (setV(""), onDone?.())}
        placeholder={label}
        aria-label={label}
        className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint max-md:text-[15px]"
      />
    </form>
  );
}

/** How the main list of a page is grouped: by sub-project (default) or by status. */
export function mainGrouping(item: Item): "sub" | "status" {
  return item.views.main?.group === "status" ? "status" : "sub";
}

/**
 * The page's main list (design rules § 2.4, § 3.2): descendants of the type its main action
 * creates, over all levels, as one table. Grouped by sub-project – "Direkt in …" first, then a
 * group per sub-project with its status and progress, also with nothing open – or by status.
 * Done ones only after "n erledigte einblenden". The grouping is saved with the page.
 */
export function ChildList({ item, typeId }: { item: Item; typeId: string }) {
  const { t } = useT();
  const ix = useIndex();
  const schema = ix.types.get(typeId)!.schema!;
  const v: ViewDef = { showDone: false, ...(item.views.main ?? {}) };
  const setV = (patch: Partial<ViewDef>) => repo.setView(item.id, "main", { ...v, ...patch });
  const same = item.type === typeId; // sub-tasks of a task
  const all = [...ix.descendants(item.id)].map((id) => ix.get(id)!).filter((x) => x && x.type === typeId && !x.deleted);
  const doneCount = all.filter((x) => isDone(x, schema)).length;
  const shown = v.showDone ? all : all.filter((x) => !isDone(x, schema));
  const rank = (x: Item) => ({ active: 0, todo: 1, done: 2 })[statusOf(x, schema)?.group ?? "todo"];
  const due = (x: Item) => dueOf(x, schema) ?? "9999";
  const sorted = [...shown].sort((a, b) => rank(a) - rank(b) || (due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : a.title.localeCompare(b.title)));
  // a query block in the text lists these already (e.g. "Offene Tasks", unter:diese): one list per page
  const inText = shownByBlocks(item, ix);
  const open = all.filter((x) => !isDone(x, schema));
  const title = listTitle(ix, typeId, same);
  if (open.length > 0 && open.every((x) => inText.has(x.id))) return null;
  // nothing yet: on a task one quiet row for the first sub-task (a project has "+ Task" in its head)
  if (!all.length)
    return same ? (
      <section className="mt-8">
        <AddRow label={t("children.addSubtaskShort")} onAdd={(t2) => repo.create({ title: t2, type: typeId, parents: [item.id] })} />
      </section>
    ) : null;
  // sub-projects: children of the page's own type; each one a group
  const subs = same ? [] : ix.childrenOf(item.id).map((id) => ix.get(id)!).filter((x) => x && x.type === item.type && !x.deleted);
  const by = subs.length ? mainGrouping(item) : "sub";
  let groups: PageGroup[];
  if (by === "status")
    groups = groupItems(sorted, "status", { ix, thisId: item.id }).map((g) => ({ key: g.key || "_", label: g.label || t("group.none"), items: g.items }));
  else {
    const subOf = (x: Item) => (ix.relPath(item.id, x.id) ?? []).find((p) => subs.some((s) => s.id === p));
    const direct = sorted.filter((x) => !subOf(x));
    groups = [
      ...(direct.length || !subs.length ? [{ key: "direct", label: t("children.directIn", { title: item.title || t("untitled") }), items: direct }] : []),
      ...subs.map((s) => ({ key: s.id, label: s.title || t("untitled"), ref: s.id, items: sorted.filter((x) => subOf(x) === s.id) })),
    ];
  }
  const cols = [
    ...(dueProp(schema) ? [{ key: "due", label: dueProp(schema)!.name }] : []),
    ...(!same && priorityProp(schema) ? [{ key: priorityProp(schema)!.name, label: priorityProp(schema)!.name }] : []),
  ];
  return (
    <section className="mt-10 max-md:mt-8">
      <SectionTitle
        count={t("children.openCount", { count: open.length })}
        right={
          subs.length > 0 && (
            <>
              <span className="max-md:hidden">
                <Seg label={t("children.groupBy")} value={by} onChange={(x: string) => setV({ group: x === "status" ? "status" : "path" })} options={[{ value: "sub", label: t("children.bySub") }, { value: "status", label: t("group.status") }]} />
              </span>
              <span className="md:hidden">
                <ViewMenu label={by === "status" ? t("group.status") : t("children.bySub")} sections={[{ value: by, options: [{ value: "sub", label: t("children.bySub") }, { value: "status", label: t("group.status") }], onChange: (x) => setV({ group: x === "status" ? "status" : "path" }) }]} />
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
        head={same ? t("children.subtaskOne") : schema.name}
        here={item.id}
        foldKey={`main:${item.id}`}
        add={{ init: { type: typeId, parents: [item.id] }, label: same ? t("children.subtaskOne") : t("children.newOf", { name: schema.name }) }}
        done={{ count: doneCount, shown: !!v.showDone, toggle: () => setV({ showDone: !v.showDone }) }}
      />
    </section>
  );
}

/** Files of a page that gathers: below it, or used in an entry below it (same as the query unter:diese). */
export function filesBelow(item: Item, ix: Index): Item[] {
  return runQuery({ where: { and: [{ file: true }, { under: { id: item.id } }] }, sort: [{ key: "created", desc: true }] }, { ix, thisId: item.id }).items;
}

/** Notes (entries without a type) on every level below, for pages that gather like a project. */
export function notesBelow(item: Item, ix: Index): Item[] {
  const hidden = shownByBlocks(item, ix);
  return [...ix.descendants(item.id)]
    .map((id) => ix.get(id)!)
    .filter((x) => x && x.kind === "info" && !ix.typeOf(x) && !hidden.has(x.id))
    .sort((a, b) => b.updated - a.updated);
}

/**
 * "Darunter" (design rules § 3.1, zone 4): what lies below the page and is not shown above – one
 * card with groups "Notizen", "Dateien" and one per type. A page that gathers (a project) shows
 * notes and files of all levels, each with where it sits as a second line. Nothing below: no
 * section, only "+ Notiz darunter" on pages without a list of their own.
 */
export function BelowCard({ item, exclude, gathers, quietAdd }: { item: Item; exclude: Set<string>; gathers: boolean; quietAdd: boolean }) {
  const { t, lang } = useT();
  const ix = useIndex();
  const [adding, setAdding] = useState(false);
  const [more, setMore] = useState<Set<string>>(new Set());
  const hidden = shownByBlocks(item, ix);
  const direct = ix.childrenOf(item.id).map((id) => ix.get(id)!).filter((c) => c && !c.deleted && !hidden.has(c.id) && !exclude.has(c.id) && !(c.type && exclude.has("type:" + c.type)));
  // without a type: overviews (they have entries below) apart from notes
  const untyped = gathers ? notesBelow(item, ix) : direct.filter((c) => c.kind === "info" && !ix.typeOf(c));
  const overviews = untyped.filter((c) => ix.childrenOf(c.id).length > 0);
  const notes = untyped.filter((c) => !overviews.includes(c));
  const files = gathers ? filesBelow(item, ix) : direct.filter((c) => c.kind === "datei");
  const rest = direct.filter((c) => !(c.kind === "info" && !ix.typeOf(c)) && c.kind !== "datei");
  const byType = new Map<string, Item[]>();
  for (const c of rest) (byType.get(c.type ?? "") ?? byType.set(c.type ?? "", []).get(c.type ?? "")!).push(c);
  const groups: { key: string; label: string; items: Item[] }[] = [
    ...(overviews.length ? [{ key: "overviews", label: t("below.overviews"), items: overviews }] : []),
    ...(notes.length ? [{ key: "notes", label: t("below.untyped"), items: notes }] : []),
    ...(files.length ? [{ key: "files", label: t("below.files"), items: files }] : []),
    ...[...byType.entries()].sort((a, b) => (ix.typeName(a[0]) ?? "").localeCompare(ix.typeName(b[0]) ?? "")).map(([k, items]) => ({ key: "type:" + k, label: listTitle(ix, k, false) || (ix.typeName(k) ?? ""), items })),
  ];
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const addNote = (title: string) => repo.create({ title, parents: [item.id] });
  if (!count && !adding)
    return quietAdd ? (
      <div className="mt-2">
        <AddRow label={t("below.addNoteBelow")} onAdd={addNote} />
      </div>
    ) : null;
  const FEW = 8;
  const right = (x: Item) =>
    x.file ? (
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtBytes(lang, x.file.size)}</span>
    ) : x.kind === "info" && !ix.typeOf(x) ? (
      <span className="shrink-0 text-xs text-muted-foreground"><RelTime ts={x.updated} /></span>
    ) : (
      <DueLabel due={dueOf(x, ix.schemaOf(x))} />
    );
  return (
    <section className="mt-10 max-md:mt-8">
      <SectionTitle
        count={count}
        right={
          <ShadcnButton variant="plain" size="none" onClick={() => setAdding(true)} className="tap-y flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg">
            <Plus size={14} /> {t("below.note")}
          </ShadcnButton>
        }
      >
        {t("below.title")}
      </SectionTitle>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {adding && (
          <div className="border-b border-line px-1">
            <AddRow label={t("below.addNote")} autoFocus onAdd={addNote} onDone={() => setAdding(false)} />
          </div>
        )}
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
                      <span className="truncate text-sm max-md:text-[15px]">{x.title || x.file?.name || t("untitled")}</span>
                      {rel.length > 0 && <span className="truncate text-xs text-muted-foreground">{shortPath(rel)}</span>}
                    </span>
                    {right(x)}
                  </a>
                );
              })}
              {g.items.length > FEW && (
                <ShadcnButton variant="plain" size="none" onClick={() => setMore(new Set(all ? [...more].filter((k) => k !== g.key) : [...more, g.key]))} className="tap-y block w-full border-t border-line px-3 py-2 text-left text-[13px] text-muted-foreground hover:text-fg">
                  {all ? t("notes.fewer") : t("notes.all", { count: g.items.length })}
                </ShadcnButton>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Dated updates of this page and its descendants, with an optional status change. */
export function Updates({ item }: { item: Item }) {
  const ix = useIndex();
  const { t, lang } = useT();
  const schema = ix.schemaOf(item);
  const sp = statusProp(schema);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [writing, setWriting] = useState(false);
  const [all, setAll] = useState(false);
  const every = [item, ...[...ix.descendants(item.id)].map((id) => ix.get(id)!)]
    .flatMap((x) => x.updates.map((u) => ({ u, from: x })))
    .sort((a, b) => b.u.at - a.u.at);
  // the newest three; the rest one click away
  const entries = every.slice(0, all ? 50 : 3);
  const submit = () => {
    if (!text.trim()) return;
    repo.addUpdate(item.id, text.trim(), status && sp ? { prop: sp.id, option: status } : undefined);
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
            <ShadcnButton variant="plain" size="none" onClick={() => setWriting(true)} className="tap-y flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg">
              <Plus size={14} /> {t("updates.one")}
            </ShadcnButton>
          )
        }
      >
        {t("updates.title")}
      </SectionTitle>
      {writing && (
      <div className="mb-4 rounded-xl border border-line bg-surface p-3 focus-within:border-[var(--focus)]">
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
            {sp && (
              <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-line bg-bg px-1.5 py-1 text-xs text-muted-foreground" aria-label={t("updates.status")}>
                <option value="">{t("updates.keepStatus")}</option>
                {sp.options?.filter((o) => o.id !== item.props[sp.id]).map((o) => (
                  <option key={o.id} value={o.id}>
                    → {o.name}
                  </option>
                ))}
              </NativeSelect>
            )}
            <Button variant="outline" className="ml-auto" onClick={() => askAgent(t("updates.agentPrompt", { title: item.title, text: text.trim() }))}>
              <Sparkles size={14} /> {t("updates.viaAgent")}
            </Button>
            <Button variant="primary" onClick={submit}>
              <Send size={14} /> {t("updates.post")}
            </Button>
          </div>
        )}
      </div>
      )}
      {entries.length > 0 && (
        <ol className="relative ml-1 space-y-4 border-l border-line pl-5">
          {entries.map(({ u, from }) => {
            const opt = sp?.options?.find((o) => o.id === u.status) ?? ix.schemaOf(from)?.properties.flatMap((p) => p.options ?? []).find((o) => o.id === u.status);
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
                  <span title={u.by}>· {u.by === "you" ? t("updates.you") : u.by.startsWith("import:") ? t("updates.import") : agentLabel(u.by.replace(/^agent:/, ""), t)}</span>
                  {opt && <span>· {t("updates.statusTo", { name: opt.name })}</span>}
                </div>
                <div className="whitespace-pre-wrap text-[15px]">{u.text}</div>
              </li>
            );
          })}
        </ol>
      )}
      {every.length > 3 && (
        <ShadcnButton variant="plain" size="none" onClick={() => setAll(!all)} className="tap-y mt-2 text-[13px] text-muted-foreground hover:text-fg">
          {all ? t("updates.fewer") : t("updates.all", { count: every.length })}
        </ShadcnButton>
      )}
    </section>
  );
}

/** A type with updates but none yet: one quiet row to write the first. */
function UpdateStarter({ onStart }: { onStart: () => void }) {
  const { t } = useT();
  return (
    <div className="mt-6">
      <ShadcnButton variant="plain" size="none" onClick={onStart} className="tap-y flex h-8 items-center gap-1.5 rounded-md px-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg">
        <Plus size={14} /> {t("updates.one")}
      </ShadcnButton>
    </div>
  );
}
