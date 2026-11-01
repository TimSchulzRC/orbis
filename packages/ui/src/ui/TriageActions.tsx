// Sorting actions shared by the sort list and the review, each with one undo.
import { Input } from "../components/ui/input";
import { useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import { type Item, setMeta, titleKey } from "@obtion/core/model";
import type { Values } from "@obtion/core/i18n";
import { onlyBelow } from "@obtion/core/trash";
import { tomorrow } from "@obtion/core/inbox";
import { useRepo } from "../hooks";
import { replica } from "../accounts";
import { SpaceScope } from "./Spaces";
import { useT, titleOf } from "../i18n";
import { createType, rememberPlace } from "../actions";
import { Button, Dialog, Kbd } from "./primitives";
import { TypeGlyph } from "./item-look";
import { cn } from "../lib/utils";
import { PlacePicker } from "./Picker";
import { chooseAction, notify } from "./feedback";

/** Longest title a notice quotes before it is cut off with "…". */
const TITLE_MAX = 40;

export interface Undo {
  label: string;
  steps: { space: string; id: string; type?: string | null; addedParents?: string[]; deleted?: boolean; pinned?: boolean; later?: number | null }[];
}

export function revert(u: Undo) {
  for (const step of u.steps) {
    const repo = replica(step.space).repo;
    if (step.deleted) repo.restore(step.id);
    if (step.type !== undefined) repo.setType(step.id, step.type);
    for (const parent of step.addedParents ?? []) repo.removeParent(step.id, parent);
    if (step.pinned) repo.pin(step.id, false);
    if (step.later !== undefined) repo.change(step.id, (doc) => setMeta(doc, { later: step.later }));
  }
}

/** The types a workspace offers first (its capture types, as set in its settings). */
export function captureTypes(space: string): string[] {
  return replica(space).repo.index().captureTypes();
}

/**
 * Each action returns its undo (or nothing when nothing happened). A place and a type belong to one
 * workspace, so those act on entries of one workspace only (the pickers enforce it). `quiet`: no
 * notice, the caller shows what was done.
 */
export function useTriageActions(spaceOf: (i: Item) => string, opts: { quiet?: boolean } = {}) {
  const { t } = useT();
  const last = useRef<Undo | null>(null);
  const repoOf = (i: Item) => replica(spaceOf(i)).repo;
  const firstType = (i?: Item) => (i ? captureTypes(spaceOf(i))[0] : undefined);
  const done = (u: Undo) => {
    last.current = u;
    if (!opts.quiet) notify.undo(u.label, () => (revert(u), (last.current = null)));
    return u;
  };
  const short = (i?: Item) => {
    const name = i ? titleOf(i, t) : t("untitled");
    return name.length > TITLE_MAX ? name.slice(0, TITLE_MAX - 1) + "…" : name;
  };
  // one entry: its short title, unless `values` brings one
  const label = (list: Item[], key: string, values: Values = {}) =>
    list.length > 1 ? t(key + "Many", { count: list.length, ...values }) : t(key, { title: short(list[0]), ...values });
  const giveType = (list: Item[], type: string) => {
    const infos = list.filter((i) => i.kind === "info");
    if (!infos.length) return;
    const repo = repoOf(infos[0]!);
    const name = repo.index().typeName(type);
    const u = done({ label: list.length > 1 ? label(infos, "triage.typed", { name }) : t("triage.typedOne", { title: short(infos[0]), name }), steps: infos.map((i) => ({ space: spaceOf(i), id: i.id, type: i.type })) });
    for (const i of infos) repo.setType(i.id, type);
    return u;
  };
  const trash = async (list: Item[]): Promise<Undo | null> => {
    // entries with notes below: delete those too, or let them back into the inbox?
    const below = list.reduce((n, i) => n + onlyBelow(repoOf(i).index(), i.id).length, 0);
    let children: "trash" | "inbox" = "trash";
    if (below) {
      const c = await chooseAction({
        title: list.length > 1 ? t("triage.deleteMany", { count: list.length }) : t("delete.title", { title: titleOf(list[0]!, t) }),
        body: t("delete.children", { count: below }),
        choices: [
          { key: "inbox", label: t("delete.backToInbox") },
          { key: "trash", label: t("delete.all", { count: below + list.length }), primary: true, danger: true },
        ],
      });
      if (!c) return null;
      children = c;
    }
    const u = done({ label: label(list, children === "inbox" && below ? "triage.trashedKeep" : "triage.trashed", { count: below, title: short(list[0]) }), steps: list.map((i) => ({ space: spaceOf(i), id: i.id, deleted: true })) });
    for (const i of list) repoOf(i).remove(i.id, children);
    return u;
  };
  const place = (list: Item[], parent: string) => {
    if (!list.length) return;
    const repo = repoOf(list[0]!);
    const ok = list.filter((i) => repo.addParent(i.id, parent));
    if (!ok.length) return;
    rememberPlace(parent);
    const where = repo.index().get(parent)?.title ?? "";
    return done({ label: ok.length > 1 ? t("triage.placedMany", { count: ok.length, title: where }) : t("triage.placedOne", { title: short(ok[0]), place: where }), steps: ok.map((i) => ({ space: spaceOf(i), id: i.id, addedParents: [parent] })) });
  };
  // out of the inbox: into the sidebar, or back tomorrow
  const pin = (list: Item[]) => {
    const fresh = list.filter((i) => !i.pinned);
    if (!fresh.length) return;
    const u = done({ label: label(fresh, "triage.pinned", { title: short(fresh[0]) }), steps: fresh.map((i) => ({ space: spaceOf(i), id: i.id, pinned: true })) });
    for (const i of fresh) repoOf(i).pin(i.id, true);
    return u;
  };
  const later = (list: Item[]) => {
    if (!list.length) return;
    const u = done({ label: label(list, "triage.later", { title: short(list[0]) }), steps: list.map((i) => ({ space: spaceOf(i), id: i.id, later: i.later ?? null })) });
    for (const i of list) repoOf(i).change(i.id, (doc) => setMeta(doc, { later: tomorrow() }));
    return u;
  };
  // "u": takes back the last one (the notice offers the same)
  const undo = () => {
    if (!last.current) return;
    revert(last.current);
    last.current = null;
  };
  return { firstType, giveType, trash, place, pin, later, undo };
}

export function usePickers(spaceOf: (i: Item) => string, place: (list: Item[], p: string) => void, giveType: (list: Item[], t: string) => void, after?: () => void) {
  const { t } = useT();
  const [placing, setPlacingRaw] = useState<Item[] | null>(null);
  const [typing, setTypingRaw] = useState<Item[] | null>(null);
  // a place or a type is one workspace's: entries of several are sorted one workspace at a time
  const one = (list: Item[]) => new Set(list.map(spaceOf)).size <= 1 || (notify(t("triage.oneSpace")), false);
  const setPlacing = (list: Item[] | null) => (!list || one(list)) && setPlacingRaw(list);
  const setTyping = (list: Item[] | null) => (!list || one(list)) && setTypingRaw(list);
  const node = (
    <>
      {placing && placing.length > 0 && (
        <SpaceScope id={spaceOf(placing[0]!)}>
          <PlacePicker list={placing} onPick={(p) => (place(placing, p), setPlacingRaw(null), after?.())} onClose={() => setPlacingRaw(null)} />
        </SpaceScope>
      )}
      {typing && typing.length > 0 && (
        <SpaceScope id={spaceOf(typing[0]!)}>
          <TypePicker current={typing.length === 1 ? typing[0]!.type : null} onPick={(type) => (giveType(typing, type), setTypingRaw(null), after?.())} onClose={() => setTypingRaw(null)} />
        </SpaceScope>
      )}
    </>
  );
  return { node, placing, typing, setPlacing, setTyping };
}

/** Choose a type by keyboard: type to filter, arrows, Enter, 1–9; "Neuer Typ …" at the end. */
function TypePicker({ current, onPick, onClose }: { current: string | null; onPick: (id: string) => void; onClose: () => void }) {
  const { t } = useT();
  const repo = useRepo();
  const ix = repo.index();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  // "Neuer Typ …" without a name: the field asks for one
  const [naming, setNaming] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const types = ix.typesByName().filter((type) => !q.trim() || type.schema.name.toLowerCase().includes(titleKey(q)));
  const exact = types.some((type) => type.schema.name.toLowerCase() === titleKey(q));
  const rows: { id?: string; create?: string }[] = [...types.map((type) => ({ id: type.id })), { create: q.trim() && !exact ? q.trim() : "" }];
  const pick = (row?: (typeof rows)[number]) => {
    if (!row) return;
    if (row.id) return onPick(row.id);
    const name = row.create?.trim();
    if (name) onPick(createType(name, repo));
    else (setNaming(true), field.current?.focus());
  };
  return (
    <Dialog title={t("triage.chooseType")} onClose={onClose}>
      <Input
        ref={field}
        autoFocus
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(rows.length - 1, s + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
          else if (e.key === "Enter") (e.preventDefault(), pick(naming && q.trim() ? { create: q } : rows[sel]));
          else if (!q && /^[1-9]$/.test(e.key) && rows[Number(e.key) - 1]?.id) (e.preventDefault(), pick(rows[Number(e.key) - 1]));
        }}
        placeholder={naming ? t("types.new") : t("triage.typeFilter")}
        className="mb-2 focus:border-focus"
      />
      <div role="listbox" className="flex flex-col">
        {rows.map((row, n) => {
          const type = row.id ? ix.types.get(row.id) : undefined;
          return (
            <Button variant="plain"
              key={row.id ?? "new"}
              role="option"
              aria-selected={n === sel}
              onMouseEnter={() => setSel(n)}
              onClick={() => pick(row)}
              className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", n === sel && "bg-selected", !row.id && "mt-1 border-t border-line pt-2")}
            >
              {type ? <TypeGlyph schema={type.schema} size={15} /> : <Plus size={15} className="text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{type ? type.schema.name : row.create ? t("triage.newTypeNamed", { name: row.create }) : t("triage.newType")}</span>
              {type && row.id === current && <Check size={14} className="text-ok" />}
              {type && n < 9 && !q && <Kbd>{n + 1}</Kbd>}
            </Button>
          );
        })}
      </div>
    </Dialog>
  );
}
