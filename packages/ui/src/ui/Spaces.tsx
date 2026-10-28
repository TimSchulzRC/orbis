// Workspaces in the sidebar: the switcher at the top (all workspaces, a new one) and "Workspaces"
// below the open one's tree – every other workspace with its pinned items, side by side with the
// open one. An item dragged from the tree onto another workspace (or one of its pinned items)
// moves there.
import { useState, useSyncExternalStore } from "react";
import { ChevronRight, ChevronsUpDown, Plus, SlidersHorizontal } from "lucide-react";
import type { Repo } from "@obtion/sync";
import { sidebarRoots } from "@obtion/core/placement";
import { type Space, activate, createSpace, replica, useAccounts } from "../accounts";
import { moveToSpace, openIn, MoveError } from "../move";
import { useLocalStorage } from "../hooks";
import { useT, tr } from "../i18n";
import { Button, Dialog, ItemIcon, MenuItem, Popover, cx } from "./bits";
import { notify } from "./feedback";
import { Section, isDragging, takeDragged } from "./Sidebar";

/** The open workspace; a menu switches to another or makes one. */
export function SpaceSwitcher() {
  const { t } = useT();
  const { account, spaces, active } = useAccounts();
  const [creating, setCreating] = useState(false);
  if (!active) return null;
  return (
    <>
      <Popover
        triggerClass="min-w-0 flex-1"
        trigger={(p) => (
          <button {...p} className="-mx-1.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-hover" aria-label={t("space.switch")}>
            <img src="/icon.svg" alt="" className="size-6 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-semibold tracking-tight">{active.name}</span>
            <ChevronsUpDown size={14} className="shrink-0 text-faint" />
          </button>
        )}
      >
        {(close) => (
          <div className="w-72 p-1">
            <p className="truncate px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted">
              {account?.user.email}
              {account?.lost && ` · ${t("account.signedOut")}`}
            </p>
            {spaces.map((s) => (
              <MenuItem key={s.id} active={s.id === active.id} onClick={() => (close(), activate(s.id), (location.hash = "#/"))}>
                {s.name}
              </MenuItem>
            ))}
            <div className="my-1 border-t border-line" />
            <MenuItem icon={<Plus size={14} />} onClick={() => (close(), setCreating(true))}>
              {t("space.new")}
            </MenuItem>
            <MenuItem icon={<SlidersHorizontal size={14} />} onClick={() => (close(), (location.hash = "#/settings"))}>
              {t("space.settings")}
            </MenuItem>
          </div>
        )}
      </Popover>
      {creating && <NewSpaceDialog onClose={() => setCreating(false)} />}
    </>
  );
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
          createSpace(name).then(() => ((location.hash = "#/"), onClose()), (err) => setError((err as Error).message));
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

/** Move by drag and drop onto another workspace: below `parent` there, or without a place. */
function dropInto(space: Space, parent?: string) {
  const d = takeDragged();
  if (!d) return;
  void moveTo(d.id, space, parent);
}

/** Move an item of the open workspace into another; tells how it went. */
export async function moveTo(id: string, space: Space, parent?: string) {
  try {
    const moved = await moveToSpace(id, space, parent);
    notify.action(tr("move.done", { workspace: space.name }), tr("move.open"), () => openIn(space, moved));
  } catch (e) {
    notify(e instanceof MoveError ? tr(`move.error.${e.message}`) : String((e as Error).message ?? e));
  }
}

/** Re-render with another workspace's replica (not the open one). */
function useReplica(r: Repo) {
  useSyncExternalStore(r.subscribe, r.getVersion);
  return r;
}

/** "Workspaces": the other workspaces with their pinned items. */
export function OtherSpaces({ touch }: { touch?: boolean }) {
  const { t } = useT();
  const { spaces, active } = useAccounts();
  const others = spaces.filter((s) => s.id !== active?.id);
  if (!others.length) return null;
  return (
    <Section id="spaces" title={t("space.others")} touch={touch}>
      <div className={cx(!touch && "px-2")}>
        {others.map((s) => (
          <SpaceBlock key={s.id} space={s} touch={touch} />
        ))}
      </div>
    </Section>
  );
}

function SpaceBlock({ space, touch }: { space: Space; touch?: boolean }) {
  const { t } = useT();
  const r = useReplica(replica(space.id).repo);
  const [open, setOpen] = useLocalStorage<boolean>(`obtion.sidebar.space.${space.id}`, true);
  const [over, setOver] = useState<string | null>(null);
  const ix = r.index();
  const roots = r.status.loaded ? sidebarRoots(ix) : [];
  const { account } = useAccounts();
  const row = cx("flex w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm", touch ? "min-h-11" : "py-1");
  const target = (key: string, parent?: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!isDragging()) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(key);
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(null);
      dropInto(space, parent);
    },
  });
  return (
    <div className="mt-0.5">
      <div className={cx("group flex items-center rounded-lg", over === "" && "bg-hover ring-1 ring-[var(--focus)]")} {...target("")}>
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="tap rounded p-1 text-faint hover:text-fg" aria-label={t("space.pinnedOf", { name: space.name })}>
          <ChevronRight size={13} className={cx("transition-transform", open && "rotate-90")} />
        </button>
        <button onClick={() => (activate(space.id), (location.hash = "#/"))} className={cx(row, "min-w-0 flex-1 px-1 hover:bg-hover")}>
          <span className="min-w-0 flex-1 truncate font-medium">{space.name}</span>
        </button>
      </div>
      {open && (
        <ul className="ml-3">
          {roots.map((item) => (
            <li key={item.id} {...target(item.id, item.id)}>
              <button onClick={() => openIn(space, item.id)} className={cx(row, "hover:bg-hover", over === item.id && "bg-hover ring-1 ring-[var(--focus)]")}>
                <ItemIcon item={item} size={15} ix={ix} />
                <span className="min-w-0 flex-1 truncate">{item.title || t("untitled")}</span>
              </button>
            </li>
          ))}
          {r.status.loaded && !roots.length && <li className="px-2.5 py-1 text-xs text-muted">{account?.lost ? t("account.signedOut") : r.status.synced ? t("nav.noPinned") : t("app.syncing")}</li>}
        </ul>
      )}
    </div>
  );
}
