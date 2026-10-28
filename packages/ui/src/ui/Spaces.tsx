// Workspaces side by side: the sidebar and the inbox show every workspace of the account, each
// block in its own SpaceScope (useRepo and useFiles read that workspace's replica there, and
// links inside open in it). Moving an item from one workspace into another asks first if
// something changes on the way (a type copied, values that become free properties, links left behind).
import { useMemo, useState, useSyncExternalStore } from "react";
import type { Repo } from "@obtion/sync";
import { createSpace, replica, spaceById, useAccounts } from "../accounts";
import { ScopeContext } from "../scope";
import { spaceHref } from "../hooks";
import { MoveError, moveToSpace, planToSpace } from "../move";
import { useT, tr } from "../i18n";
import { Button, Dialog } from "./bits";
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
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} className="field mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
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
