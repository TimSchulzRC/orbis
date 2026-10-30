import { Checkbox } from "../components/ui/checkbox";
import { Button as ShadcnButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
// Settings in two kinds. Global (#/settings): the account, its workspaces, and what belongs to
// this device (language, appearance, files, its name).
// A workspace's own (#/w/<id>/workspace, from its menu in the sidebar or the list here): name and
// members, capture, examples, agents, sync, and the way to its types, activity, graph and trash.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Copy, Check, Eye, EyeOff, RotateCcw, ChevronRight, History, Shapes, Trash2, Waypoints } from "lucide-react";
import { SETTINGS_ID, setSettings } from "@obtion/core/model";
import { fmtBytes } from "@obtion/core/i18n";
import { resetInbox } from "@obtion/core/setup";
import { listExamples, removeExamples, restoreExamples } from "@obtion/core/examples";
import { useRepo, useSpaceId, spaceHref } from "../hooks";
import { useT, setLang } from "../i18n";
import { Button, Dialog, ItemIcon, Seg, SectionTitle, TypeGlyph, cx } from "../ui/bits";
import { chooseAction, notify } from "../ui/feedback";
import { setTheme, useTheme } from "../theme";
import { type Space, deleteAccount, deleteSpace, inviteLink, leaveSpace, mcpToken, members, renameSpace, replica, serverInfo, signOut, spaceById, useAccounts } from "../accounts";
import { NewSpaceDialog } from "../ui/Spaces";

interface Connect {
  mcpUrl: string;
  token: string;
  claudeCode: string;
  json: unknown;
  vault: string;
}

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

function CopyBox({ text, secret, label }: { text: string; secret?: string; label: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [show, setShow] = useState(false);
  const shown = secret && !show ? text.replaceAll(secret, "•".repeat(12)) : text;
  return (
    <div className="relative rounded-lg border border-line bg-surface-2">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all p-3 pr-20 font-mono text-xs leading-relaxed" aria-label={label}>
        {shown}
      </pre>
      <div className="absolute right-1.5 top-1.5 flex">
        {secret && (
          <ShadcnButton variant="plain" size="none" onClick={() => setShow(!show)} className="tap rounded-md p-1.5 text-muted-foreground hover:bg-hover" aria-label={show ? t("settings.hideToken") : t("settings.showToken")}>
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </ShadcnButton>
        )}
        <ShadcnButton variant="plain" size="none"
          onClick={() => {
            copyText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-hover"
          aria-label={t("settings.copy")}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </ShadcnButton>
      </div>
    </div>
  );
}

/** A workspace's name, who is in it, an invite link, leaving it. */
function Members({ space }: { space: Space }) {
  const { t } = useT();
  const [name, setName] = useState(space.name);
  const [list, setList] = useState<{ id: string; name: string; email: string; role: string }[]>([]);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    members(space).then(setList, () => {});
  }, [space.id]);
  const owner = space.role === "owner";
  const fail = (e: unknown) => setError((e as Error).message === "last owner" ? t("space.lastOwner") : (e as Error).message);
  return (
    <section>
      <SectionTitle>{t("space.members")}</SectionTitle>
      <p className="mb-3 text-sm text-muted-foreground">{t("space.intro", { server: location.host })}</p>
      {owner && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => (e.preventDefault(), renameSpace(space, name).catch(fail))}>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t("space.name")} className="field rounded-lg border border-line bg-surface px-3 py-1.5 text-sm" />
          <Button type="submit" variant="outline" disabled={!name.trim() || name === space.name}>
            {t("space.rename")}
          </Button>
        </form>
      )}
      <ul className="mt-3 space-y-1 text-sm">
        {list.map((m) => (
          <li key={m.id} className="flex items-center gap-2">
            <span className="min-w-0 truncate">{m.name || m.email}</span>
            <span className="truncate text-muted-foreground">{m.email}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t(`space.role.${m.role}`)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => inviteLink(space).then(setLink, fail)}>
          {t("space.invite")}
        </Button>
        <Button variant="outline" onClick={() => leaveSpace(space).catch(fail)}>
          {t("space.leave")}
        </Button>
      </div>
      {link && (
        <div className="mt-3">
          <p className="mb-1 text-sm text-muted-foreground">{t("space.inviteHint")}</p>
          <CopyBox label={t("space.invite")} text={link} />
        </div>
      )}
      {error && <p className="mt-3 text-sm text-[var(--danger-text)]">{error}</p>}
    </section>
  );
}

/** The account: who is signed in, on which server, signing out. */
function AccountSection() {
  const { t } = useT();
  const { account } = useAccounts();
  const [deleting, setDeleting] = useState(false);
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
        <Button variant="outline" onClick={() => setDeleting(true)}>{t("account.delete")}</Button>
      </div>
      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
    </section>
  );
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog title={t("account.delete")} onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try { await deleteAccount(password); }
        catch (e) {
          const message = (e as Error).message;
          setError(t(message === "last owner" ? "account.deleteOwner" : message === "invalid password" ? "account.deletePassword" : "account.offline"));
          setBusy(false);
        }
      }}>
        <p className="mb-4 text-sm text-muted-foreground">{t("account.deleteHint")}</p>
        <label className="block text-sm">
          {t("account.password")}
          <Input type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert" className="mt-3 text-sm text-[var(--danger-text)]">{error}</p>}
        <div className="mt-4 flex gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
          <ShadcnButton type="submit" variant="destructive" disabled={busy || !password}>{t("account.delete")}</ShadcnButton>
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
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {spaces.map((s) => (
            <li key={s.id}>
              <a href={spaceHref(s.id, "/workspace")} className="tap-row flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-hover">
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
          <ShadcnButton variant="plain" size="none" key={m} onClick={() => setMode(m)} className={cx("rounded-xl border p-3 text-left", mode === m ? "border-[var(--focus)] bg-surface" : "border-line hover:bg-hover")} aria-pressed={mode === m}>
            <p className="text-sm font-medium">{t("settings.mode." + m)}</p>
            <p className="text-xs text-muted-foreground">{t("settings.mode." + m + "Hint")}</p>
          </ShadcnButton>
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

/** This device's name in the activity – for every workspace. */
function DeviceName() {
  const { t } = useT();
  const { spaces } = useAccounts();
  const first = spaces[0] ? replica(spaces[0].id).repo.device : "";
  const [device, setDevice] = useState(first);
  return (
    <section>
      <SectionTitle>{t("settings.device")}</SectionTitle>
      <label className="flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">{t("settings.deviceName")}</span>
        <Input
          value={device}
          onChange={(e) => setDevice(e.target.value)}
          onBlur={() => {
            const name = device.trim() || first;
            localStorage.setItem("obtion.device", name);
            for (const s of spaces) replica(s.id).repo.device = name;
          }}
          className="rounded-md border border-line bg-surface px-2 py-1"
        />
      </label>
      <p className="mt-2 text-xs text-muted-foreground">{t("settings.deviceHint")}</p>
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
        <Seg label={t("settings.language")} value={lang} onChange={setLang} options={[{ value: "de", label: "Deutsch" }, { value: "en", label: "English" }]} />
        <p className="mt-2 text-xs text-muted-foreground">{t("settings.languageHint")}</p>
      </section>

      <section>
        <SectionTitle>{t("settings.theme")}</SectionTitle>
        <Seg label={t("settings.theme")} value={theme.choice} onChange={setTheme} options={(["system", "light", "dark"] as const).map((v) => ({ value: v, label: t("theme." + v) }))} />
        <p className="mt-2 text-xs text-muted-foreground">{t("settings.themeHint")}</p>
      </section>


      <DeviceFilesSection />

      <DeviceName />

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
  const [c, setC] = useState<Connect | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => void (document.title = space?.name ?? t("space.settings")), [space?.name]);
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
          {[
            ["/types", t("nav.types"), Shapes],
            ["/activity", t("nav.activity"), History],
            ["/graph", t("nav.graph"), Waypoints],
            ["/trash", t("nav.trash"), Trash2],
          ].map(([path, label, I]: any) => (
            <a key={path} href={spaceHref(space.id, path)} className="tap-y inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm hover:bg-hover">
              <I size={15} className="text-muted-foreground" /> {label}
            </a>
          ))}
        </nav>
      </div>

      <Members space={space} />

      <Examples />

      <section>
        <SectionTitle>{t("settings.capture")}</SectionTitle>
        <p className="mb-2 text-sm text-muted-foreground">{t("settings.captureHint")}</p>
        <div className="flex flex-wrap gap-1.5">
          {types.map((tp) => (
            <ShadcnButton variant="plain" size="none" key={tp.id} onClick={() => toggleCapture(tp.id)} aria-pressed={capture.includes(tp.id)} className={cx("tap-y inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", capture.includes(tp.id) ? "border-[var(--focus)] text-fg" : "border-line text-muted-foreground")}>
              <TypeGlyph schema={tp.schema} size={12} /> {tp.schema!.name}
            </ShadcnButton>
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
    if (yes === "yes") await deleteSpace(space).catch((e) => setError(String((e as Error).message ?? e)));
  };
  return (
    <section>
      <SectionTitle>{t("space.delete")}</SectionTitle>
      {space.role === "owner" ? (
        <>
          <p className="mb-3 text-sm text-muted-foreground">{t("space.deleteHint")}</p>
          <Button variant="outline" className="text-[var(--danger-text)]" onClick={() => void run()}>
            {t("space.delete")}
          </Button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("space.deleteOwner")}</p>
      )}
      {error && <p className="mt-3 text-sm text-[var(--danger-text)]">{error}</p>}
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
  const toggle = (id: string) => setChosen((c) => new Set(c!.has(id) ? [...c!].filter((x) => x !== id) : [...c!, id]));
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
                  <label className={cx("tap-row flex items-center gap-2 rounded-md px-2 py-1 text-sm", e.inUse ? "text-muted-foreground" : "cursor-pointer hover:bg-hover")}>
                    <Checkbox  checked={chosen.has(e.id)} disabled={e.inUse} onCheckedChange={() => toggle(e.id)} className="size-4 shrink-0 accent-[var(--focus)]" />
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
            <Button variant="primary" className="!bg-danger !text-white" disabled={!picked} onClick={remove}>
              {t("examples.confirm", { count: picked })}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
