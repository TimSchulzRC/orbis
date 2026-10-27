// Workspaces in the sidebar: the switcher at the top (all workspaces of all accounts, a new one,
// another server) and "Workspaces" below the open one's tree – every other workspace with its
// pinned items, side by side with the open one. An item dragged from the tree onto another
// workspace (or one of its pinned items) moves there.
import { useState, useSyncExternalStore } from "react";
import { ChevronRight, ChevronsUpDown, Plus, Server, SlidersHorizontal } from "lucide-react";
import type { Repo } from "@obtion/sync";
import { sidebarRoots } from "@obtion/core/placement";
import { type Space, accountOf, activate, connectServer, createSpace, hostOf, here, replica, useAccounts } from "../accounts";
import { moveToSpace, openIn, MoveError } from "../move";
import { useLocalStorage } from "../hooks";
import { useT, tr } from "../i18n";
import { Button, Dialog, ItemIcon, MenuItem, Popover, cx } from "./bits";
import { notify } from "./feedback";
import { Section, isDragging, takeDragged } from "./Sidebar";

/** Where an account lives, for display: its e-mail, plus the server if it is not this one. */
function accountLabel(s: Space) {
  const a = accountOf(s);
  return a.server === here ? a.user.email : `${a.user.email} · ${hostOf(a.server)}`;
}

/** The open workspace; a menu switches to another, makes one or adds a server. */
export function SpaceSwitcher() {
  const { t } = useT();
  const { accounts, spaces, active } = useAccounts();
  const [dialog, setDialog] = useState<"new" | "server" | null>(null);
  if (!active) return null;
  return (
    <>
      <Popover
        triggerClass="min-w-0 flex-1"
        trigger={(p) => (
          <button {...p} className="-mx-1.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-hover" aria-label={t("space.switch")}>
            <img src="/icon.svg" alt="" className="size-6 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold tracking-tight">{active.name}</span>
              {spaces.length > 1 && <span className="block truncate text-[11px] leading-tight text-muted">{accountLabel(active)}</span>}
            </span>
            <ChevronsUpDown size={14} className="shrink-0 text-faint" />
          </button>
        )}
      >
        {(close) => (
          <div className="w-72 p-1">
            {accounts.map((a) => (
              <div key={a.id} className="mb-1">
                <p className="truncate px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted">
                  {a.server === here ? a.user.email : `${a.user.email} · ${hostOf(a.server)}`}
                  {a.lost && ` · ${t("account.signedOut")}`}
                </p>
                {spaces
                  .filter((s) => s.account === a.id)
                  .map((s) => (
                    <MenuItem key={s.key} active={s.key === active.key} onClick={() => (close(), activate(s.key), (location.hash = "#/"))}>
                      {s.name}
                    </MenuItem>
                  ))}
              </div>
            ))}
            <div className="my-1 border-t border-line" />
            <MenuItem icon={<Plus size={14} />} onClick={() => (close(), setDialog("new"))}>
              {t("space.new")}
            </MenuItem>
            <MenuItem icon={<Server size={14} />} onClick={() => (close(), setDialog("server"))}>
              {t("space.addServer")}
            </MenuItem>
            <MenuItem icon={<SlidersHorizontal size={14} />} onClick={() => (close(), (location.hash = "#/settings"))}>
              {t("space.settings")}
            </MenuItem>
          </div>
        )}
      </Popover>
      {dialog === "new" && <NewSpaceDialog onClose={() => setDialog(null)} />}
      {dialog === "server" && <AddServerDialog onClose={() => setDialog(null)} />}
    </>
  );
}

export function NewSpaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { accounts, active } = useAccounts();
  const usable = accounts.filter((a) => !a.lost);
  const [account, setAccount] = useState(active ? accountOf(active).id : usable[0]?.id);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const acc = usable.find((a) => a.id === account);
  return (
    <Dialog title={t("space.new")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (acc) createSpace(acc, name).then(() => ((location.hash = "#/"), onClose()), (err) => setError((err as Error).message));
        }}
      >
        <label className="block text-sm font-medium">
          {t("space.name")}
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} className="field mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
        </label>
        {usable.length > 1 && (
          <label className="mt-4 block text-sm font-medium">
            {t("space.onServer")}
            <select value={account} onChange={(e) => setAccount(e.target.value)} className="field mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm">
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {hostOf(a.server)} · {a.user.email}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="mt-3 text-sm text-[var(--danger-text)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !acc}>
            {t("space.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function AddServerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  return (
    <Dialog title={t("space.addServer")} onClose={onClose}>
      <p className="text-sm text-muted">{t("space.addServerHint")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            connectServer(address.trim());
          } catch {
            setError(t("space.badAddress"));
          }
        }}
      >
        <label className="mt-4 block text-sm font-medium">
          {t("space.address")}
          <input autoFocus required placeholder="https://obtion.example.org" value={address} onChange={(e) => setAddress(e.target.value)} className="field mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm" />
        </label>
        {error && <p className="mt-3 text-sm text-[var(--danger-text)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!address.trim()}>
            {t("space.connect")}
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
  const others = spaces.filter((s) => s.key !== active?.key);
  if (!others.length) return null;
  return (
    <Section id="spaces" title={t("space.others")} touch={touch}>
      <div className={cx(!touch && "px-2")}>
        {others.map((s) => (
          <SpaceBlock key={s.key} space={s} touch={touch} />
        ))}
      </div>
    </Section>
  );
}

function SpaceBlock({ space, touch }: { space: Space; touch?: boolean }) {
  const { t } = useT();
  const r = useReplica(replica(space.key).repo);
  const [open, setOpen] = useLocalStorage<boolean>(`obtion.sidebar.space.${space.key}`, true);
  const [over, setOver] = useState<string | null>(null);
  const ix = r.index();
  const roots = r.status.loaded ? sidebarRoots(ix) : [];
  const acc = accountOf(space);
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
        <button onClick={() => (activate(space.key), (location.hash = "#/"))} className={cx(row, "min-w-0 flex-1 px-1 hover:bg-hover")}>
          <span className="min-w-0 flex-1 truncate font-medium">{space.name}</span>
          {acc.server !== here && <span className="shrink-0 truncate text-[11px] text-muted">{hostOf(acc.server)}</span>}
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
          {r.status.loaded && !roots.length && <li className="px-2.5 py-1 text-xs text-muted">{acc.lost ? t("account.signedOut") : r.status.synced ? t("nav.noPinned") : t("app.syncing")}</li>}
        </ul>
      )}
    </div>
  );
}
