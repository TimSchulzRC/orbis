// The lists of the app: a type's page (its entries with views as tabs, like a database in
// Notion), the files, and the inbox. A type keeps its views; the files and the inbox have one.
import { useEffect, useRef, useState } from "react";
import { ListFilter, X, MoreHorizontal, RotateCcw, SlidersHorizontal, Plus, Upload, Sparkles } from "lucide-react";
import { type FileType, type Item, type ViewTab, SETTINGS_ID, setSettings, setTab, setTabs, shortId } from "@obtion/core/model";
import { type QueryDef, andWhere, runQuery, tabDef } from "@obtion/core/query";
import { inboxWhere } from "@obtion/core/inbox";
import { keyBetween } from "@obtion/core/sortkey";
import { resetInbox, typeTabs } from "@obtion/core/setup";
import { useRepo, useRoute } from "../hooks";
import { spaceById, useAccounts } from "../accounts";
import { SpaceEyebrow, SpaceFilter, SpaceScope, useReplicas } from "../ui/Spaces";
import { Triage } from "../ui/Triage";
import { repo } from "../repo";
import { useT } from "../i18n";
import { files } from "../files";
import { Button, MenuItem, Popover, cx, Empty, IconButton } from "../ui/bits";
import { Results, defaultColumns, useQuery } from "../ui/Results";
import { viewGroups } from "../ui/Table";
import { type TabEdit, ViewSettings, ViewTabs, tabName, useTabChoice, useViewFields } from "../ui/Views";
import { AddFilter, QueryEditor } from "../ui/QueryEditor";
import { notify } from "../ui/feedback";
import { askAgent, createAndOpen } from "../actions";

/**
 * The entries of a type with its views as tabs. How a view looks (kind, grouping, sorting,
 * columns) is saved at once; trying out a filter is a draft until "Speichern".
 */
export function TypeList({ type }: { type: Item }) {
  const { t, lang } = useT();
  const tabs = typeTabs(type, lang);
  const [tab, pickTab] = useTabChoice(type.id, tabs);
  // the first change keeps the default views: they are written along with it
  const setT = (id: string, patch: Parameters<typeof setTab>[2]) =>
    repo.change(type.id, (d) => {
      if (!type.schema!.views) setTabs(d, tabs);
      setTab(d, id, patch);
    });
  const [draft, setDraft] = useState<{ tab: string; where: QueryDef["where"] } | null>(null);
  const tabWhere = draft?.tab === tab.id ? draft.where : tab.where;
  const base = { type: type.id };
  const def: QueryDef = tabDef(base, { ...tab, where: tabWhere });
  const dirty = !!draft && JSON.stringify(draft.where) !== JSON.stringify(tabs.find((x) => x.id === draft.tab)?.where);
  const saveLook = (patch: Partial<ViewTab>) => {
    const changed = Object.entries(patch).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((tab as any)[k]));
    if (!changed.length) return;
    setT(tab.id, Object.fromEntries(changed.map(([k, v]) => [k, v ?? null])));
    if (patch.kind && patch.kind !== tab.kind) notify(t("view.viewSet", { view: t("view." + patch.kind) }), () => setT(tab.id, { kind: tab.kind }));
  };
  // leaving with an unsaved filter: say that it was not kept
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => () => void (dirtyRef.current && notify(t("view.draftDropped"))), []);
  const pick = (id: string) => {
    if (dirty) (notify(t("view.draftDropped")), setDraft(null));
    pickTab(id);
  };
  const tabEdit: TabEdit = {
    add: (kind) => {
      const id = shortId("v");
      setT(id, { kind, pos: keyBetween(tabs.at(-1)?.pos ?? null, null), ...(kind === "board" ? { group: "status" } : {}) });
      pick(id);
    },
    rename: (id, name) => setT(id, { name: name || null }),
    duplicate: (id) => {
      const n = tabs.findIndex((x) => x.id === id);
      const { id: _, pos, ...rest } = tabs[n]!;
      const nid = shortId("v");
      setT(nid, { ...rest, name: t("view.copyName", { name: tabName(tabs[n]!, t) }), pos: keyBetween(pos, tabs[n + 1]?.pos ?? null) });
      pick(nid);
    },
    remove: (id) => {
      const { id: _, ...whole } = tabs.find((x) => x.id === id)!;
      setT(id, null);
      if (draft?.tab === id) setDraft(null);
      notify(t("view.removed", { name: tabName(whole, t) }), () => setT(id, whole));
    },
    move: (id, pos) => setT(id, { pos }),
    settings: () => setSettings_(true),
  };
  const { items, ctx } = useQuery(def);
  const [settings, setSettings_] = useState(false);
  const fields = useViewFields(base, items);
  const setTabFilter = (w: QueryDef["where"]) => JSON.stringify(w) !== JSON.stringify(tabWhere) && setDraft({ tab: tab.id, where: w });
  const saveDraft = () => {
    if (!draft) return;
    setT(draft.tab, { where: draft.where ?? null });
    setDraft(null);
    notify(t("view.saved"));
  };
  const name = type.schema!.name;
  return (
    <>
      <ViewTabs
        tabs={tabs}
        active={tab.id}
        onPick={pick}
        edit={tabEdit}
        right={
          <>
            <AddFilter onAdd={(c) => setTabFilter(andWhere(tabWhere, c))} trigger={(p) => <IconButton {...p} icon={ListFilter} label={t("view.addFilter")} />} />
            <IconButton icon={SlidersHorizontal} label={t("view.settings")} aria-pressed={settings} onClick={() => setSettings_(!settings)} className={settings ? "bg-hover text-fg" : undefined} />
            <Button variant="primary" onClick={() => createAndOpen({ type: type.id })} aria-label={t("view.new", { name })}>
              <Plus size={14} /> <span className="hidden sm:inline">{name}</span>
            </Button>
          </>
        }
      />
      {settings && (
        <ViewSettings
          tab={{ ...tab, where: tabWhere }}
          fields={fields}
          columns={tab.kind === "table" ? defaultColumns(items, ctx) : undefined}
          groups={viewGroups(items, def, ctx)}
          onLook={saveLook}
          onClose={() => setSettings_(false)}
        />
      )}
      {/* the view's own filter: only when it has one, as chips under the tabs (like Notion) */}
      {tabWhere && (
        <div className="mb-3">
          <QueryEditor bare def={{ where: tabWhere }} onChange={(d) => setTabFilter(d.where)} />
        </div>
      )}
      {dirty && <DraftBar onDiscard={() => setDraft(null)} onSave={saveDraft} />}
      {!items.length && tabWhere ? (
        // empty because of the view's filter: say so, with the way out
        <Empty title={t("view.emptyFiltered")}>
          <Button variant="outline" onClick={() => setTabFilter(undefined)}>
            {t("view.removeFilter")}
          </Button>
        </Empty>
      ) : (
        <Results def={def} keyPrefix={type.id} look={{ key: `${type.id}:${tab.id}`, tab: { ...tab, where: tabWhere }, onLook: saveLook, add: { type: type.id } }} empty={<Empty title={t("query.empty")} />} />
      )}
    </>
  );
}

function DraftBar({ onDiscard, onSave }: { onDiscard: () => void; onSave: () => void }) {
  const { t } = useT();
  return (
    <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--focus)] bg-surface px-3 py-2 text-sm" role="status">
      <span className="mr-auto text-muted">{t("view.draft")}</span>
      <Button variant="outline" onClick={onDiscard}>
        {t("view.discard")}
      </Button>
      <Button variant="primary" onClick={onSave}>
        {t("view.save")}
      </Button>
    </div>
  );
}

const FILE_KINDS: FileType[] = ["bild", "pdf", "audio", "video", "dokument", "sonstiges"];

/** "Dateien": all files, newest first; "Alle · Bilder · PDFs · Audio" (only kinds that are there), images as a gallery. */
export function FilesPage() {
  const { t } = useT();
  const route = useRoute();
  const [kind, setKind] = useState<FileType | null>((route.query.get("kind") as FileType | null) ?? null);
  const all = useQuery({ where: { file: true } }).items;
  const kinds = FILE_KINDS.map((k) => ({ k, n: all.filter((i) => i.file?.filetype === k).length })).filter((x) => x.n > 0);
  const def: QueryDef = { where: kind ? { and: [{ file: true }, { filetype: kind }] } : { file: true }, sort: [{ key: "created", desc: true }] };
  useEffect(() => void (document.title = t("nav.files")), []);
  return (
    <div className="page-wide">
      <SpaceEyebrow />
      <div className="mb-4 flex items-center gap-3">
        <h1 className="page-title">{t("nav.files")}</h1>
        <span className="flex-1 text-[15px] tabular-nums text-muted">{all.length}</span>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm font-medium hover:bg-hover">
          <Upload size={14} /> <span className="hidden sm:inline">{t("files.add")}</span>
          <input type="file" multiple className="hidden" onChange={async (e) => {
            for (const f of [...(e.target.files ?? [])]) await files.add(f, f.name);
          }} />
        </label>
      </div>
      {kinds.length > 1 && (
        <div className="-mx-4 mb-3 flex gap-1 overflow-x-auto px-4 text-sm [scrollbar-width:none] md:mx-0 md:px-0" role="group" aria-label={t("files.filter")}>
          {[{ k: null, n: all.length }, ...kinds].map(({ k, n }) => (
            <button
              key={k ?? "all"}
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={cx("shrink-0 whitespace-nowrap rounded-full border px-3 py-1", kind === k ? "border-[var(--focus)] bg-surface text-fg" : "border-line text-muted hover:bg-hover hover:text-fg")}
            >
              {k ? t("filetype.many." + k) : t("files.all")} <span className="tabular-nums text-muted">{n}</span>
            </button>
          ))}
        </div>
      )}
      <Results def={def} display={kind === "bild" ? "gallery" : "list"} keyPrefix="files" empty={<Empty title={t("files.empty")} />} />
    </div>
  );
}

/**
 * The inbox: one list of the entries of the workspaces seen (the selector in the sidebar, also
 * here above the list), newest first; each entry is sorted in its own workspace. What lands there
 * is each workspace's rule, behind "…".
 */
export function InboxPage() {
  const { t } = useT();
  const { shown } = useAccounts();
  const [rule, setRule] = useState<string | null>(null);
  const repos = useReplicas(shown.map((s) => s.id));
  const spaceOf = new WeakMap<Item, string>();
  const per = shown.map((s, n) => {
    const r = repos[n]!;
    if (!r.get(SETTINGS_ID)) return [];
    const ix = r.index();
    const items = runQuery({ where: inboxWhere(ix), sort: [{ key: "created", desc: true }] }, { ix }).items;
    for (const i of items) spaceOf.set(i, s.id);
    return items;
  });
  const items = per.flat().sort((a, b) => b.created - a.created);
  // the agent sorts in one workspace: the one it worked in last if that has entries, else the first that has
  const last = localStorage.getItem("obtion.agent.space");
  const agentSpace = (shown.find((s, n) => s.id === last && per[n]!.length) ?? shown.find((_, n) => per[n]!.length))?.id;
  const sortWithAgent = () => agentSpace && askAgent(t("triage.agentPrompt"), undefined, agentSpace);
  useEffect(() => void (document.title = t("nav.inbox")), []);
  return (
    <div className="page-wide">
      <div className="mb-4 flex items-center gap-3">
        {/* its name and how many wait, in one line (design rules § 5.1) */}
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="page-title truncate">{t("nav.inbox")}</h1>
          <span className="text-[15px] tabular-nums text-muted">{items.length}</span>
        </div>
        {agentSpace && (
          <Button variant="ghost" onClick={sortWithAgent} title={t("triage.withAgent")}>
            <Sparkles size={14} /> <span className="hidden sm:inline">{shown.length > 1 ? t("triage.withAgentIn", { name: spaceById(agentSpace)?.name ?? "" }) : t("triage.withAgent")}</span>
          </Button>
        )}
        <Popover align="right" trigger={(p) => <IconButton {...p} label={t("more")} icon={MoreHorizontal} />}>
          {(close) =>
            shown.map((s) => (
              <MenuItem key={s.id} icon={<SlidersHorizontal size={14} />} onClick={() => (close(), setRule(s.id))}>
                {shown.length > 1 ? t("inbox.whatLandsIn", { name: s.name }) : t("inbox.whatLands")}
              </MenuItem>
            ))
          }
        </Popover>
      </div>
      <SpaceFilter />
      {rule && shown.some((s) => s.id === rule) && (
        <SpaceScope id={rule}>
          <InboxRule name={shown.length > 1 ? spaceById(rule)?.name : undefined} onClose={() => setRule(null)} />
        </SpaceScope>
      )}
      {items.length ? <Triage items={items} spaceOf={(i) => spaceOf.get(i)!} /> : <Empty title={t("inbox.empty")} />}
    </div>
  );
}

/** What lands in a workspace's inbox: its rule (a draft until "Speichern") and the way back to the default. */
function InboxRule({ name, onClose }: { name?: string; onClose: () => void }) {
  const { t } = useT();
  const repo = useRepo();
  const where = inboxWhere(repo.index());
  const [draft, setDraft] = useState<QueryDef["where"] | null>(null);
  const restore = () => (setDraft(null), resetInbox(repo.writer), notify(t("inbox.restored")));
  return (
    <>
      <div className="mb-4 space-y-2 rounded-xl border border-line bg-surface p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{name ? t("inbox.whatLandsIn", { name }) : t("inbox.whatLands")}</p>
            <p className="text-xs text-muted">{t("inbox.ruleHint")}</p>
          </div>
          <Button variant="ghost" onClick={restore}>
            <RotateCcw size={14} /> {t("inbox.restoreDefault")}
          </Button>
          <IconButton icon={X} label={t("view.closeSettings")} onClick={onClose} />
        </div>
        <QueryEditor autoFocus def={{ where: draft ?? where }} onChange={(d) => setDraft(d.where ?? null)} />
      </div>
      {draft && JSON.stringify(draft) !== JSON.stringify(where) && (
        <DraftBar onDiscard={() => setDraft(null)} onSave={() => (repo.change(SETTINGS_ID, (d) => setSettings(d, { inbox: draft })), setDraft(null), notify(t("view.saved")))} />
      )}
    </>
  );
}
