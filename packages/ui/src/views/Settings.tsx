// Settings in two kinds. Global (#/settings): the account, its workspaces, and what belongs to
// this device (language, appearance, files, its name).
// A workspace's own (#/w/<id>/settings, from its menu in the sidebar or the list here): name and
// members, capture, examples, agents, sync, and the way to its types, activity, graph and trash.
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Copy, Check, Crown, Eye, EyeOff, KeyRound, Link2, RotateCcw, ChevronRight, Shapes, Trash2, UserMinus, UserRound, Waypoints } from "lucide-react";
import { SETTINGS_ID, setSettings } from "@obtion/core/model";
import { ENDONYMS, LANGS, fmtBytes, fmtDate } from "@obtion/core/i18n";
import { resetInbox } from "@obtion/core/setup";
import { listExamples, removeExamples, restoreExamples } from "@obtion/core/examples";
import { useRepo, useSpaceId, spaceHref, useDocumentTitle } from "../hooks";
import { useT, setLang } from "../i18n";
import { Button, Dialog, IconButton, MenuItem, MoreMenu, Seg, SectionAction, SectionTitle } from "../ui/primitives";
import { ItemIcon, TypeGlyph } from "../ui/item-look";
import { cn, toggled } from "../lib/utils";
import { chooseAction, confirmAction, notify } from "../ui/feedback";
import { setTheme, useTheme } from "../theme";
import { type Space, ApiError, activeUser, addPasskey, changePassword, linkFailed, linkOAuth, linkedProviders, deleteAccount, deleteSpace, errorText, inviteLink, inviteLinks, joinUrl, leaveSpace, loginOf, mcpToken, members, passkeys, removeMember, removePasskey, renameSpace, replica, revokeInvite, serverInfo, setRole, signOut, spaceById, useAccounts } from "../accounts";
import { SignIn } from "./Account";
import { NewSpaceDialog } from "../ui/Spaces";
import type { InviteLink, McpConnect, Member, PasskeyInfo, ServerInfo } from "@obtion/core/api";

/** navigator.clipboard exists only over HTTPS; opened as http://<address> the old way copies. */
function copyText(text: string) {
  if (navigator.clipboard) return void navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

/** Copies `text`, with a check mark for a moment. */
function CopyButton({ text }: { text: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      size="sm"
      iconSize={14}
      label={t("settings.copy")}
      icon={copied ? Check : Copy}
      onClick={() => {
        copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    />
  );
}

function CopyBox({ text, secret, label }: { text: string; secret?: string; label: string }) {
  const { t } = useT();
  const [show, setShow] = useState(false);
  const shown = secret && !show ? text.replaceAll(secret, "•".repeat(12)) : text;
  return (
    <div className="relative rounded-lg border border-line bg-surface-2">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all p-3 pr-20 font-mono text-xs leading-relaxed" aria-label={label}>
        {shown}
      </pre>
      <div className="absolute right-1.5 top-1.5 flex">
        {secret && <IconButton size="sm" iconSize={14} onClick={() => setShow(!show)} label={show ? t("settings.hideToken") : t("settings.showToken")} icon={show ? EyeOff : Eye} />}
        <CopyButton text={text} />
      </div>
    </div>
  );
}

/**
 * A workspace's name, who is in it, leaving it. Owners also rename it, make others owners or
 * members, remove them (each confirmed first) and manage the invite links.
 */
function Members({ space, onRemoved }: { space: Space; onRemoved: () => void }) {
  const { t } = useT();
  const [name, setName] = useState(space.name);
  const [list, setList] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const load = () => members(space).then(setList, () => {});
  useEffect(() => void load(), [space.id]);
  const owner = space.role === "owner";
  const me = activeUser();
  const fail = (e: unknown) => setError(errorText(e, t, "space"));
  const who = (m: Member) => m.name || m.email;
  const changeRole = async (m: Member) => {
    const role = m.role === "owner" ? "member" : "owner";
    const yes = await confirmAction({ title: t(`space.make.${role}.confirm`, { name: who(m) }), body: t(`space.make.${role}.hint`, { name: who(m) }), yes: t(`space.make.${role}`) });
    if (yes) await setRole(space, m.id, role).then(load, fail);
  };
  const remove = async (m: Member) => {
    const yes = await confirmAction({ title: t("space.removeConfirm", { name: who(m), workspace: space.name }), body: t("space.removeHint", { name: who(m) }), yes: t("space.remove") });
    // their invite links went with them
    if (yes) await removeMember(space, m.id).then(() => (void load(), onRemoved()), fail);
  };
  return (
    <section>
      <SectionTitle>{t("space.members")}</SectionTitle>
      <p className="mb-3 text-sm text-muted-foreground">{t("space.intro", { server: location.host })}</p>
      {owner && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => (e.preventDefault(), renameSpace(space, name).catch(fail))}>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t("space.name")} className="bg-surface py-1.5" />
          <Button type="submit" variant="outline" disabled={!name.trim() || name === space.name}>
            {t("space.rename")}
          </Button>
        </form>
      )}
      <ul className="mt-3 space-y-1 text-sm" aria-label={t("space.memberList")}>
        {list.map((m) => (
          <li key={m.id} className="flex min-h-8 items-center gap-2">
            <span className="min-w-0 truncate">{who(m)}</span>
            <span className="truncate text-muted-foreground">{m.email}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t(`space.role.${m.role}`)}</span>
            {owner && m.id !== me ? (
              <MoreMenu size="sm" iconSize={14} label={t("space.memberMenu", { name: who(m) })}>
                {(close) => (
                  <>
                    <MenuItem icon={m.role === "owner" ? <UserRound size={14} /> : <Crown size={14} />} onClick={() => (close(), void changeRole(m))}>
                      {t(`space.make.${m.role === "owner" ? "member" : "owner"}`)}
                    </MenuItem>
                    <MenuItem danger icon={<UserMinus size={14} />} onClick={() => (close(), void remove(m))}>
                      {t("space.remove")}
                    </MenuItem>
                  </>
                )}
              </MoreMenu>
            ) : (
              owner && <span className="w-[22px] shrink-0" />
            )}
          </li>
        ))}
      </ul>
      {!owner && <p className="mt-3 text-sm text-muted-foreground">{t("space.inviteOwners")}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => leaveSpace(space).catch(fail)}>
          {t("space.leave")}
        </Button>
      </div>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}

/** The invite links of a workspace that still work: a new one, who made each, until when, revoking. Owners only. */
function InviteLinks({ space, version }: { space: Space; version: number }) {
  const { t, lang } = useT();
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [error, setError] = useState("");
  const load = () => inviteLinks(space).then(setLinks, (e) => setError(errorText(e, t, "space")));
  useEffect(() => void load(), [space.id, version]);
  const day = (ts: number) => fmtDate(lang, new Date(ts).toISOString());
  const fail = (e: unknown) => setError(errorText(e, t, "space"));
  return (
    <section>
      <SectionTitle right={<SectionAction icon={Link2} onClick={() => inviteLink(space).then(load, fail)}>{t("space.inviteNew")}</SectionAction>}>{t("space.invites")}</SectionTitle>
      <p className="mb-3 text-sm text-muted-foreground">{t("space.inviteHint")}</p>
      {links.length ? (
        <ul className="space-y-2" aria-label={t("space.invites")}>
          {links.map((l) => (
            <li key={l.code} className="rounded-lg border border-line bg-surface-2 py-1.5 pl-3 pr-1.5">
              <div className="flex items-center gap-1">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{joinUrl(l.code)}</code>
                <CopyButton text={joinUrl(l.code)} />
                <Button small onClick={() => revokeInvite(space, l.code).then(load, fail)}>
                  {t("space.revoke")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t(l.by ? "space.inviteBy" : "space.inviteMade", { by: l.by, created: day(l.created), expires: day(l.expires) })}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("space.invitesNone")}</p>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}

/** The account: who is signed in, on which server, its passkeys, signing out. */
function AccountSection() {
  const { t } = useT();
  const { account } = useAccounts();
  const [deleting, setDeleting] = useState(false);
  const [changing, setChanging] = useState(false);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => void serverInfo().then(setInfo, () => {}), []);
  if (!account) return null;
  return (
    <section>
      <SectionTitle>{t("account.title")}</SectionTitle>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line p-3 text-sm">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{account.user.email}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {t("account.thisServer", { server: location.host })}
            {account.lost && ` · ${t("account.signedOut")}`}
          </span>
        </span>
        <Button variant="outline" onClick={() => void signOut()}>
          {t("account.signOut")}
        </Button>
        {/* an account that signs in by code, passkey or provider has no password to change */}
        {account.password !== false && <Button variant="outline" onClick={() => setChanging(true)}>{t("account.changePassword")}</Button>}
        <Button variant="outline" onClick={() => setDeleting(true)}>{t("account.delete")}</Button>
      </div>
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
      {loginOf(info).passkey && !account.lost && <Passkeys />}
      {loginOf(info).oauth.length > 0 && !account.lost && <Providers providers={loginOf(info).oauth} />}
      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
    </section>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  if (done)
    return (
      <Dialog title={t("account.changePassword")} onClose={onClose}>
        <p role="status" className="text-sm">{t("account.passwordChanged")}</p>
        <div className="mt-4 flex gap-2">
          <Button onClick={onClose}>{t("close")}</Button>
        </div>
      </Dialog>
    );
  return (
    <Dialog title={t("account.changePassword")} onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        if (next !== repeat) return setError(t("account.passwordMismatch"));
        setBusy(true);
        setError("");
        try {
          await changePassword(current, next);
          setDone(true);
        } catch (e) {
          setError(errorText(e, t, "password"));
        }
        setBusy(false);
      }}>
        <p className="mb-4 text-sm text-muted-foreground">{t("account.changePasswordHint")}</p>
        <label className="block text-sm">
          {t("account.currentPassword")}
          <Input type="password" autoComplete="current-password" required value={current} disabled={busy} onChange={(e) => setCurrent(e.target.value)} className="mt-1 block" />
        </label>
        <label className="mt-3 block text-sm">
          {t("account.newPassword")}
          <Input type="password" autoComplete="new-password" required minLength={8} value={next} disabled={busy} onChange={(e) => setNext(e.target.value)} className="mt-1 block" />
        </label>
        <label className="mt-3 block text-sm">
          {t("account.repeatPassword")}
          <Input type="password" autoComplete="new-password" required minLength={8} value={repeat} disabled={busy} onChange={(e) => setRepeat(e.target.value)} className="mt-1 block" />
        </label>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" disabled={busy || !current || !next || !repeat}>{t("account.changePassword")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Confirming who is signed in, for what needs a recent sign-in (adding a passkey, linking a
 * provider, deleting an account without a password): signing in again with a way this account
 * already has, which keeps everything on this device. Then what asked for it goes on.
 */
function Reauth({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { account } = useAccounts();
  // the passkey button only for an account that has one (unknown when the list fails: offered)
  const [hasPasskey, setHasPasskey] = useState<boolean | undefined>(false);
  useEffect(() => void passkeys().then((l) => setHasPasskey(l.length > 0), () => setHasPasskey(undefined)), []);
  const who = account?.user.id;
  // a passkey of another account signs that one in instead: then nothing goes on
  const done = () => (activeUser() === who ? onDone() : onClose());
  if (!account) return null;
  return (
    <Dialog title={t("account.reauth")} onClose={onClose}>
      <p className="text-sm text-muted-foreground">{t("account.reauthHint")}</p>
      <p className="mt-3 truncate text-sm font-medium">{account.user.email}</p>
      <SignIn email={account.user.email} hasPassword={account.password !== false} hasPasskey={hasPasskey} onDone={done} />
    </Dialog>
  );
}

/** The account's passkeys: signing in without a password, with this device or a phone. */
function Passkeys() {
  const { t } = useT();
  const [list, setList] = useState<PasskeyInfo[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const load = () => passkeys().then(setList, () => setList([]));
  useEffect(() => void load(), []);
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      await addPasskey();
      notify(t("account.passkeyAdded"));
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setReauth(true);
      else if (!(e instanceof Error && e.name === "NotAllowedError")) setError(t("account.passkeyFailed"));
    } finally {
      setBusy(false);
    }
  };
  const supported = !!window.PublicKeyCredential && window.isSecureContext;
  return (
    <div className="mt-3 rounded-lg border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{t("account.passkeys")}</span>
          <span className="block text-xs text-muted-foreground">{t(supported ? "account.passkeysHint" : "account.passkeysUnsupported")}</span>
        </span>
        <Button variant="outline" disabled={busy || !supported} onClick={() => void add()}>
          <KeyRound size={14} /> {t("account.addPasskey")}
        </Button>
      </div>
      {list && list.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-2 py-2">
              <KeyRound size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{p.name || t("account.passkey")}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{new Date(p.createdAt).toLocaleDateString()}</span>
              <Button variant="plain" className="tap rounded-md p-1.5 text-muted-foreground hover:bg-hover" aria-label={t("account.removePasskey")} title={t("account.removePasskey")}
                onClick={() => void removePasskey(p.id).then(load, () => setError(t("account.offline")))}>
                <Trash2 size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      {reauth && <Reauth onClose={() => setReauth(false)} onDone={() => (setReauth(false), void add())} />}
    </div>
  );
}

/** OAuth providers to sign in with: linked ones, and the way to link another. */
function Providers({ providers }: { providers: { id: string; name: string }[] }) {
  const { t } = useT();
  const [linked, setLinked] = useState<string[] | null>(null);
  const [error, setError] = useState(linkFailed ? t(linkFailed === "taken" ? "account.linkTaken" : "account.linkFailed") : "");
  const [reauth, setReauth] = useState<string | null>(null);
  useEffect(() => void linkedProviders().then(setLinked, () => setLinked([])), []);
  const link = (id: string) => {
    setError("");
    // a sign-in of the last minutes first (403): confirm, then go on
    void linkOAuth(id).catch((e: unknown) => (e instanceof ApiError && e.status === 403 ? setReauth(id) : setError(t("account.linkFailed"))));
  };
  return (
    <div className="mt-3 rounded-lg border border-line p-3 text-sm">
      <span className="block font-medium">{t("account.providers")}</span>
      <ul className="mt-2 divide-y divide-line border-t border-line">
        {providers.map((p) => (
          <li key={p.id} className="flex items-center gap-2 py-2">
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {linked?.includes(p.id) ? (
              <span className="text-xs text-muted-foreground">{t("account.linked")}</span>
            ) : (
              <Button variant="outline" disabled={!linked} onClick={() => link(p.id)}>
                {t("account.link")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      {reauth && <Reauth onClose={() => setReauth(null)} onDone={() => (setReauth(null), link(reauth))} />}
    </div>
  );
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { account } = useAccounts();
  // without a password: a recent sign-in is the proof
  const withPassword = account?.password !== false;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await deleteAccount(withPassword ? password : undefined); }
    catch (e) {
      if (!withPassword && e instanceof ApiError && e.status === 403 && e.message === "sign in again") setReauth(true);
      else setError(errorText(e, t, "deleteAccount"));
      setBusy(false);
    }
  };
  if (reauth) return <Reauth onClose={onClose} onDone={() => (setReauth(false), void remove())} />;
  return (
    <Dialog title={t("account.delete")} onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={(e) => (e.preventDefault(), void remove())}>
        <p className="mb-4 text-sm text-muted-foreground">{t("account.deleteHint")}</p>
        {withPassword && (
          <label className="block text-sm">
            {t("account.password")}
            <Input type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} className="mt-1 block" />
          </label>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={busy || (withPassword && !password)}>{t("account.delete")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The account's workspaces, each a way to its own settings, and a new one. */
function Workspaces() {
  const { t } = useT();
  const { spaces } = useAccounts();
  const [creating, setCreating] = useState(false);
  return (
    <section>
      <SectionTitle>{t("settings.workspaces")}</SectionTitle>
      <p className="mb-3 text-sm text-muted-foreground">{t("settings.workspacesHint")}</p>
      {spaces.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {spaces.map((s) => (
            <li key={s.id}>
              <a href={spaceHref(s.id, "/settings")} className="tap-row flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-hover">
                <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{t(`space.role.${s.role}`)}</span>
                <ChevronRight size={15} className="shrink-0 text-faint" />
              </a>
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" className="mt-3" onClick={() => setCreating(true)}>
        {t("space.new")}
      </Button>
      {creating && <NewSpaceDialog onClose={() => setCreating(false)} />}
    </section>
  );
}

/** The file contents of every workspace on this device: one choice for all, re-rendering when any changes. */
function useAllFiles() {
  const { spaces } = useAccounts();
  const ids = spaces.map((s) => s.id).join();
  const list = useMemo(() => spaces.map((s) => replica(s.id).files), [ids]);
  const subscribe = useMemo(
    () => (l: () => void) => {
      const offs = list.map((f) => f.subscribe(l));
      return () => offs.forEach((off) => off());
    },
    [list],
  );
  useSyncExternalStore(subscribe, () => list.map((f) => f.getVersion()).join());
  return list;
}

function DeviceFilesSection() {
  const { t, lang } = useT();
  const all = useAllFiles();
  const mode = all[0]?.mode ?? "online";
  const sum = (k: "originals" | "total" | "bytes" | "downloading" | "uploading") => all.reduce((n, f) => n + f.status[k], 0);
  const setMode = (m: "online" | "local") => {
    for (const f of all) (f.setMode(m), m === "online" && void f.dropOriginals());
  };
  return (
    <section>
      <SectionTitle>{t("settings.files")}</SectionTitle>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["online", "local"] as const).map((m) => (
          <Button variant="plain" key={m} onClick={() => setMode(m)} className={cn("rounded-xl border p-3 text-left", mode === m ? "border-focus bg-surface" : "border-line hover:bg-hover")} aria-pressed={mode === m}>
            <p className="text-sm font-medium">{t("settings.mode." + m)}</p>
            <p className="text-xs text-muted-foreground">{t("settings.mode." + m + "Hint")}</p>
          </Button>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("settings.filesStatus", { local: sum("originals"), total: sum("total"), size: fmtBytes(lang, sum("bytes")) })}
        {sum("downloading") > 0 && ` · ${t("settings.downloading", { count: sum("downloading") })}`}
        {sum("uploading") > 0 && ` · ${t("settings.uploading", { count: sum("uploading") })}`}
      </p>
    </section>
  );
}

/** Which build the server runs (dev, nightly or stable): with three instances, the one this is. Offline: nothing. */
function Version() {
  const { t } = useT();
  const [info, setInfo] = useState<{ version: string; commit: string }>();
  useEffect(() => {
    serverInfo().then(setInfo, () => {});
  }, []);
  if (!info?.version) return null;
  return <p className="text-xs text-muted-foreground">{t("settings.version", { version: info.version + (info.commit ? ` (${info.commit})` : "") })}</p>;
}

/** The settings of the app on this device and the account, with its workspaces. */
export function Settings() {
  const { t, lang } = useT();
  useDocumentTitle(t("nav.settings"));
  const theme = useTheme();
  return (
    <div className="page-read space-y-10">
      <div>
        <h1 className="page-title">{t("nav.settings")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.intro")}</p>
      </div>

      <AccountSection />

      <Workspaces />

      <section>
        <SectionTitle>{t("settings.language")}</SectionTitle>
        <Seg label={t("settings.language")} value={lang} onChange={setLang} options={LANGS.map((l) => ({ value: l, label: ENDONYMS[l] }))} />
        <p className="mt-2 text-xs text-muted-foreground">{t("settings.languageHint")}</p>
      </section>

      <section>
        <SectionTitle>{t("settings.theme")}</SectionTitle>
        <Seg label={t("settings.theme")} value={theme.choice} onChange={setTheme} options={(["system", "light", "dark"] as const).map((v) => ({ value: v, label: t("theme." + v) }))} />
        <p className="mt-2 text-xs text-muted-foreground">{t("settings.themeHint")}</p>
      </section>

      <DeviceFilesSection />

      <Version />
    </div>
  );
}

/** The settings of the workspace in the address. */
export function SpaceSettingsPage() {
  const r = useRepo();
  const { t } = useT();
  const space = spaceById(useSpaceId() ?? "");
  // an MCP token is made on request (each is a new one, shown once)
  const [c, setC] = useState<McpConnect | null>(null);
  const [err, setErr] = useState(false);
  const [removed, setRemoved] = useState(0);
  useDocumentTitle(space?.name ?? t("space.settings"));
  if (!space) return null;
  const newToken = () => mcpToken(space).then(setC, () => setErr(true));
  const s = r.status;
  const ix = r.index();
  const capture = r.get(SETTINGS_ID)?.settings?.captureTypes ?? [];
  const types = [...ix.types.values()].sort((a, b) => a.schema!.name.localeCompare(b.schema!.name));
  const toggleCapture = (id: string) => r.change(SETTINGS_ID, (d) => setSettings(d, { captureTypes: capture.includes(id) ? capture.filter((x) => x !== id) : [...capture, id] }));
  // the first capture type is the one "c" files to in the inbox
  const setFirst = (id: string) => r.change(SETTINGS_ID, (d) => setSettings(d, { captureTypes: [id, ...capture.filter((x) => x !== id)] }));
  const chosen = capture.filter((id) => ix.types.has(id));

  return (
    <div className="page-read space-y-10">
      <div>
        <p className="mb-0.5 text-[13px] text-muted-foreground">{t("space.settings")}</p>
        <h1 className="page-title">{space.name}</h1>
        {/* the workspace's other pages: one click from here */}
        <nav className="mt-4 flex flex-wrap gap-2" aria-label={t("settings.more")}>
          {([
            ["/types", t("nav.types"), Shapes],
            ["/graph", t("nav.graph"), Waypoints],
          ] as const).map(([path, label, I]) => (
            <a key={path} href={spaceHref(space.id, path)} className="tap-y inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm hover:bg-hover">
              <I size={15} className="text-muted-foreground" /> {label}
            </a>
          ))}
        </nav>
      </div>

      <Members space={space} onRemoved={() => setRemoved((n) => n + 1)} />

      {space.role === "owner" && <InviteLinks space={space} version={removed} />}

      <Examples />

      <section>
        <SectionTitle>{t("settings.capture")}</SectionTitle>
        <p className="mb-2 text-sm text-muted-foreground">{t("settings.captureHint")}</p>
        <div className="flex flex-wrap gap-1.5">
          {types.map((tp) => (
            <Button variant="plain" key={tp.id} onClick={() => toggleCapture(tp.id)} aria-pressed={capture.includes(tp.id)} className={cn("tap-y inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", capture.includes(tp.id) ? "border-focus text-fg" : "border-line text-muted-foreground")}>
              <TypeGlyph schema={tp.schema} size={12} /> {tp.schema!.name}
            </Button>
          ))}
        </div>
        {chosen.length > 0 && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("settings.captureFirst")}</span>
            <NativeSelect value={chosen[0]} onChange={(e) => setFirst(e.target.value)} className="tap-row rounded-md border border-line bg-surface px-2 py-1">
              {chosen.map((id) => (
                <option key={id} value={id}>
                  {ix.types.get(id)!.schema!.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
      </section>

      <section>
        <SectionTitle>{t("settings.agent")}</SectionTitle>
        <p className="mb-3 text-sm text-muted-foreground">{t("settings.agentIntro")}</p>
        {err && !c && <p className="text-sm text-muted-foreground">{t("settings.connectOffline")}</p>}
        {!c && (
          <Button variant="outline" onClick={() => void newToken()}>
            {t("settings.newToken")}
          </Button>
        )}
        {c && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-sm font-medium">Claude Code</div>
              <CopyBox label="Claude Code" text={c.claudeCode} secret={c.token} />
            </div>
            <div>
              <div className="mb-1 text-sm font-medium">{t("settings.otherClients")}</div>
              <CopyBox label="MCP JSON" text={JSON.stringify(c.json, null, 2)} secret={c.token} />
            </div>
            <p className="text-sm text-muted-foreground">
              {t("settings.mirror")} <code className="rounded bg-surface-2 px-1 font-mono text-xs">{c.vault}</code>
            </p>
          </div>
        )}
      </section>

      <section>
        <SectionTitle>{t("settings.sync")}</SectionTitle>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{t("settings.server")}</dt>
          <dd>{s.online ? t("settings.connected") : t("settings.offline")}</dd>
          {s.pending > 0 && (
            <>
              <dt className="text-muted-foreground">{t("settings.pending")}</dt>
              <dd>{s.pending}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("settings.onDevice")}</dt>
          <dd>{t("settings.counts", { items: ix.live.filter((i) => i.kind === "info").length, files: ix.live.filter((i) => i.kind === "datei").length, types: ix.types.size })}</dd>
        </dl>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-fg">{t("settings.advanced")}</summary>
          <dl className="mt-2 grid grid-cols-[10rem_1fr] gap-y-1.5">
            <dt className="text-muted-foreground">{t("settings.position")}</dt>
            <dd className="tabular-nums">#{s.lastSeq}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => r.resetLocal()}>
              {t("settings.redownload")}
            </Button>
            <Button variant="outline" onClick={() => resetInbox(r.writer)}>
              <RotateCcw size={14} /> {t("inbox.reset")}
            </Button>
          </div>
        </details>
      </section>

      <DeleteSpace space={space} />
    </div>
  );
}

/** Deleting the workspace for good, on the server for everyone: owners only. */
function DeleteSpace({ space }: { space: Space }) {
  const { t } = useT();
  const [error, setError] = useState("");
  const run = async () => {
    const yes = await chooseAction({ title: t("space.deleteConfirm", { name: space.name }), body: t("space.deleteHint"), choices: [{ key: "yes", label: t("space.delete"), danger: true }] });
    if (yes === "yes") await deleteSpace(space).catch((e) => setError(errorText(e, t, "space")));
  };
  return (
    <section>
      <SectionTitle>{t("space.delete")}</SectionTitle>
      {space.role === "owner" ? (
        <>
          <p className="mb-3 text-sm text-muted-foreground">{t("space.deleteHint")}</p>
          <Button variant="danger-outline" onClick={() => void run()}>
            {t("space.delete")}
          </Button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("space.deleteOwner")}</p>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}

/** "Beispiele entfernen": the examples of the setup to the trash, with a preview; changed ones stay unless chosen. */
function Examples() {
  const r = useRepo();
  const { t } = useT();
  const ix = r.index();
  const list = listExamples(ix);
  const [chosen, setChosen] = useState<Set<string> | null>(null); // while the preview is open
  if (!list.length) return null;
  const toggle = (id: string) => setChosen((c) => toggled(c!, id));
  const remove = () => {
    const ids = removeExamples(r.writer, ix, [...chosen!]);
    setChosen(null);
    notify.undo(t("examples.removed", { count: ids.filter((id) => !list.find((e) => e.id === id)?.isType).length }), () => restoreExamples(r.writer, ids));
  };
  const entries = list.filter((e) => !e.isType).length;
  const picked = chosen ? list.filter((e) => !e.isType && chosen.has(e.id)).length : 0;
  return (
    <section>
      <SectionTitle>{t("examples.title")}</SectionTitle>
      <p className="mb-3 text-sm text-muted-foreground">{t("examples.intro", { count: entries })}</p>
      <Button variant="outline" onClick={() => setChosen(new Set(list.filter((e) => !e.changed && !e.inUse).map((e) => e.id)))}>
        {t("examples.remove")}
      </Button>
      {chosen && (
        <Dialog title={t("examples.dialogTitle")} onClose={() => setChosen(null)} wide>
          <p className="text-sm text-muted-foreground">{t("examples.preview")}</p>
          <ul className="mt-3 max-h-[50vh] overflow-y-auto rounded-lg border border-line p-1">
            {list.map((e) => {
              const item = ix.get(e.id);
              return (
                <li key={e.id}>
                  <label className={cn("tap-row flex items-center gap-2 rounded-md px-2 py-1 text-sm", e.inUse ? "text-muted-foreground" : "cursor-pointer hover:bg-hover")}>
                    <Checkbox checked={chosen.has(e.id)} disabled={e.inUse} onCheckedChange={() => toggle(e.id)} className="size-4 shrink-0" />
                    {e.isType ? <TypeGlyph schema={item?.schema} size={14} /> : item && <ItemIcon item={item} size={14} />}
                    <span className="min-w-0 truncate">{e.title || t("untitled")}</span>
                    {e.isType && <span className="text-xs text-muted-foreground">{t("examples.type")}</span>}
                    {e.inUse ? (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t("examples.inUse")}</span>
                    ) : (
                      e.changed && <span className="ml-auto shrink-0 rounded-full border border-line px-1.5 text-xs text-muted-foreground">{t("examples.changed")}</span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setChosen(null)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" disabled={!picked} onClick={remove}>
              {t("examples.confirm", { count: picked })}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
