import { Checkbox } from "../components/ui/checkbox";
import { Button as ShadcnButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
// Workspaces side by side: the sidebar and the inbox show the workspaces chosen in the
// selector (several at once; on this device, the account stays as it is). Each part of a page
// that belongs to one workspace sits in its SpaceScope (useRepo and useFiles read that
// workspace's replica there, and links inside open in it). Moving an item from one workspace into another asks first if
// something changes on the way (a type copied, values that become free properties, links left behind).
import { useMemo, useState, useSyncExternalStore } from "react";
import { ChevronsUpDown, Plus, SlidersHorizontal } from "lucide-react";
import type { Repo } from "@obtion/sync";
import { createSpace, replica, setShown, spaceById, useAccounts } from "../accounts";
import { ScopeContext } from "../scope";
import { spaceHref, useSpaceId } from "../hooks";
import { MoveError, moveToSpace, planToSpace } from "../move";
import { useT, tr } from "../i18n";
import { Button, Dialog, MenuItem, Popover, cx } from "./bits";
import { BrandLogo } from "./BrandLogo";
import { confirmAction, notify } from "./feedback";

/** A part of the page that belongs to workspace `id`. A link clicked inside opens there. */
export function SpaceScope({ id, children }: { id: string; children: React.ReactNode }) {
  const { active } = useAccounts();
  const value = useMemo(() => ({ id, ...replica(id) }), [id]);
  const onClickCapture = (e: React.MouseEvent) => {
    if (active?.id === id || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = (e.target as HTMLElement).closest("a")?.getAttribute("href");
    if (!href?.startsWith("#/")) return;
    e.preventDefault();
    location.hash = spaceHref(id, href.slice(1).replace(/^\/w\/[^/?]+/, ""));
  };
  return (
    <ScopeContext.Provider value={value}>
      <div className="contents" onClickCapture={onClickCapture}>
        {children}
      </div>
    </ScopeContext.Provider>
  );
}

/** Above the title of a page of one workspace: which one it is, once there are several. */
export function SpaceEyebrow() {
  const { spaces } = useAccounts();
  const id = useSpaceId();
  if (spaces.length < 2) return null;
  return <p className="mb-0.5 text-[13px] text-muted-foreground">{spaceById(id ?? "")?.name}</p>;
}

/** Which workspaces are seen: the label says it ("Alle Workspaces", one name, or the names); the menu ticks them. */
export function SpaceSelector({ className, onNew }: { className?: string; onNew: () => void }) {
  const { t } = useT();
  const { account, spaces, shown } = useAccounts();
  const ids = shown.map((s) => s.id);
  const label = shown.length === spaces.length && spaces.length > 1 ? t("space.all") : shown.map((s) => s.name).join(", ");
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    if (next.length) setShown(next);
  };
  return (
    <Popover
      triggerClass={cx("min-w-0", className)}
      trigger={(p) => (
        <ShadcnButton variant="plain" size="none" {...p} className="-mx-1.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-hover" aria-label={t("space.choose")}>
          <BrandLogo className="size-6 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</span>
          <ChevronsUpDown size={14} className="shrink-0 text-faint" />
        </ShadcnButton>
      )}
    >
      {(close) => (
        <div className="w-72 p-1">
          <p className="truncate px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {account?.user.email}
            {account?.lost && ` · ${t("account.signedOut")}`}
          </p>
          {/* several at once: boxes, not a choice of one */}
          {spaces.map((s) => (
            <label key={s.id} className="tap-row flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-hover">
              <Checkbox  checked={ids.includes(s.id)} disabled={ids.length === 1 && ids.includes(s.id)} onCheckedChange={() => toggle(s.id)} className="size-4 accent-[var(--focus)]" />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
            </label>
          ))}
          <div className="my-1 border-t border-line" />
          <MenuItem icon={<Plus size={14} />} onClick={() => (close(), onNew())}>
            {t("space.new")}
          </MenuItem>
          <MenuItem icon={<SlidersHorizontal size={14} />} onClick={() => (close(), (location.hash = "#/settings"))}>
            {t("nav.settings")}
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

/**
 * The workspaces seen, as chips above the inbox – the same choice as the selector in
 * the sidebar. From "Alle", a chip shows that workspace only; else chips add and take away.
 */
export function SpaceFilter() {
  const { t } = useT();
  const { spaces, shown } = useAccounts();
  if (spaces.length < 2) return null;
  const ids = shown.map((s) => s.id);
  const all = ids.length === spaces.length;
  const pick = (id: string) => {
    if (all) return setShown([id]);
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    if (next.length) setShown(next);
  };
  const chip = (on: boolean) => cx("shrink-0 whitespace-nowrap rounded-full border px-3 py-1", on ? "border-[var(--focus)] bg-surface text-fg" : "border-line text-muted-foreground hover:bg-hover hover:text-fg");
  return (
    <div className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 text-sm [scrollbar-width:none] md:mx-0 md:px-0" role="group" aria-label={t("space.choose")}>
      <ShadcnButton variant="plain" size="none" onClick={() => setShown(spaces.map((s) => s.id))} aria-pressed={all} className={chip(all)}>
        {t("inbox.all")}
      </ShadcnButton>
      {spaces.map((s) => (
        <ShadcnButton variant="plain" size="none" key={s.id} onClick={() => pick(s.id)} aria-pressed={!all && ids.includes(s.id)} className={chip(!all && ids.includes(s.id))}>
          {s.name}
        </ShadcnButton>
      ))}
    </div>
  );
}

/** The replicas of these workspaces, re-rendering when any of them changes. */
export function useReplicas(ids: string[]): Repo[] {
  const repos = ids.map((id) => replica(id).repo);
  const subscribe = useMemo(
    () => (l: () => void) => {
      const offs = repos.map((r) => r.subscribe(l));
      return () => offs.forEach((off) => off());
    },
    [ids.join()],
  );
  useSyncExternalStore(subscribe, () => repos.map((r) => r.getVersion()).join());
  return repos;
}

export function NewSpaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  return (
    <Dialog title={t("space.new")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          createSpace(name).then(onClose, (err) => setError((err as Error).message));
        }}
      >
        <label className="block text-sm font-medium">
          {t("space.name")}
          <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} className="field mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
        </label>
        {error && <p className="mt-3 text-sm text-[var(--danger-text)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {t("space.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Move `id` from workspace `from` into `to` (below `parent` there). If something changes on the
 * way it says what and asks; then tells how it went, with a way to the moved item.
 */
export async function moveTo(id: string, from: string, to: string, parent?: string) {
  const workspace = spaceById(to)?.name ?? "";
  try {
    const plan = await planToSpace(id, from, to);
    if (plan.copiedTypes.length || plan.freeProps.length || plan.droppedLinks) {
      const lines = [
        plan.items > 1 && tr(plan.files ? "move.preview.itemsFiles" : "move.preview.items", { count: plan.items, files: plan.files }),
        plan.copiedTypes.length && tr("move.preview.types", { count: plan.copiedTypes.length, names: plan.copiedTypes.join(", "), workspace }),
        plan.freeProps.length && tr("move.preview.free", { count: plan.freeProps.length, names: plan.freeProps.join(", ") }),
        plan.droppedLinks && tr("move.preview.links", { count: plan.droppedLinks, from: spaceById(from)?.name ?? "" }),
      ].filter(Boolean);
      const title = replica(from).repo.get(id)?.title || tr("untitled");
      if (!(await confirmAction({ title: tr("move.preview.title", { title, workspace }), body: lines.map((l) => `– ${l}`).join("\n"), yes: tr("move.confirm") }))) return;
    }
    const moved = await moveToSpace(id, from, to, parent);
    notify.action(tr("move.done", { workspace }), tr("move.open"), () => (location.hash = spaceHref(to, `/i/${encodeURIComponent(moved)}`)));
  } catch (e) {
    notify(e instanceof MoveError ? tr(`move.error.${e.message}`) : String((e as Error).message ?? e));
  }
}
