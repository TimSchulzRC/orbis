import { useEffect, useState } from "react";
import { Copy, Check, Eye, EyeOff, RotateCcw } from "lucide-react";
import { SETTINGS_ID, setSettings } from "@obtion/core/model";
import { fmtBytes } from "@obtion/core/i18n";
import { resetInbox } from "@obtion/core/setup";
import { listExamples, removeExamples, restoreExamples } from "@obtion/core/examples";
import { useRepo } from "../hooks";
import { repo } from "../repo";
import { useT, setLang } from "../i18n";
import { files, useFileStatus } from "../files";
import { Button, Dialog, ItemIcon, Seg, SectionTitle, TypeGlyph, cx } from "../ui/bits";
import { notify } from "../ui/feedback";
import { History, Shapes, Trash2, Waypoints } from "lucide-react";
import { setTheme, useTheme } from "../theme";

interface Connect {
  mcpUrl: string;
  token: string;
  claudeCode: string;
  json: unknown;
  vault: string;
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
          <button onClick={() => setShow(!show)} className="tap rounded-md p-1.5 text-muted hover:bg-hover" aria-label={show ? t("settings.hideToken") : t("settings.showToken")}>
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
        <button
          onClick={() => {
            navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-md p-1.5 text-muted hover:bg-hover"
          aria-label={t("settings.copy")}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
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
    const ids = removeExamples(repo.writer, ix, [...chosen!]);
    setChosen(null);
    notify.undo(t("examples.removed", { count: ids.filter((id) => !list.find((e) => e.id === id)?.isType).length }), () => restoreExamples(repo.writer, ids));
  };
  const entries = list.filter((e) => !e.isType).length;
  const picked = chosen ? list.filter((e) => !e.isType && chosen.has(e.id)).length : 0;
  return (
    <section>
      <SectionTitle>{t("examples.title")}</SectionTitle>
      <p className="mb-3 text-sm text-muted">{t("examples.intro", { count: entries })}</p>
      <Button variant="outline" onClick={() => setChosen(new Set(list.filter((e) => !e.changed && !e.inUse).map((e) => e.id)))}>
        {t("examples.remove")}
      </Button>
      {chosen && (
        <Dialog title={t("examples.dialogTitle")} onClose={() => setChosen(null)} wide>
          <p className="text-sm text-muted">{t("examples.preview")}</p>
          <ul className="mt-3 max-h-[50vh] overflow-y-auto rounded-lg border border-line p-1">
            {list.map((e) => {
              const item = ix.get(e.id);
              return (
                <li key={e.id}>
                  <label className={cx("tap-row flex items-center gap-2 rounded-md px-2 py-1 text-sm", e.inUse ? "text-muted" : "cursor-pointer hover:bg-hover")}>
                    <input type="checkbox" checked={chosen.has(e.id)} disabled={e.inUse} onChange={() => toggle(e.id)} className="size-4 shrink-0 accent-[var(--focus)]" />
                    {e.isType ? <TypeGlyph schema={item?.schema} size={14} /> : item && <ItemIcon item={item} size={14} />}
                    <span className="min-w-0 truncate">{e.title || t("untitled")}</span>
                    {e.isType && <span className="text-xs text-muted">{t("examples.type")}</span>}
                    {e.inUse ? (
                      <span className="ml-auto shrink-0 text-xs text-muted">{t("examples.inUse")}</span>
                    ) : (
                      e.changed && <span className="ml-auto shrink-0 rounded-full border border-line px-1.5 text-xs text-muted">{t("examples.changed")}</span>
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

export function Settings() {
  const r = useRepo();
  const { t, lang } = useT();
  const theme = useTheme();
  const fs = useFileStatus();
  const [c, setC] = useState<Connect | null>(null);
  const [err, setErr] = useState(false);
  const [device, setDevice] = useState(r.device);
  useEffect(() => {
    fetch("/api/connect")
      .then((res) => res.json())
      .then(setC)
      .catch(() => setErr(true));
  }, [r.status.online]);
  // the built-in agent needs the Claude Code CLI on the hub: say how, here where it is set up
  const [agentMissing, setAgentMissing] = useState(false);
  useEffect(() => {
    fetch("/api/info")
      .then((res) => res.json())
      .then((i) => setAgentMissing(!i.agent))
      .catch(() => {});
  }, [r.status.online]);
  const s = r.status;
  const ix = r.index();
  const capture = r.get(SETTINGS_ID)?.settings?.captureTypes ?? [];
  const types = [...ix.types.values()].sort((a, b) => a.schema!.name.localeCompare(b.schema!.name));
  const toggleCapture = (id: string) =>
    repo.change(SETTINGS_ID, (d) => setSettings(d, { captureTypes: capture.includes(id) ? capture.filter((x) => x !== id) : [...capture, id] }));
  // the first capture type is the one "c" files to in the inbox
  const setFirst = (id: string) => repo.change(SETTINGS_ID, (d) => setSettings(d, { captureTypes: [id, ...capture.filter((x) => x !== id)] }));
  const chosen = capture.filter((id) => ix.types.has(id));

  return (
    <div className="page-read space-y-10">
      <div>
        <h1 className="page-title">{t("nav.settings")}</h1>
        <p className="text-sm text-muted">{t("settings.intro")}</p>
        {/* what left the sidebar: one click from here */}
        <nav className="mt-4 flex flex-wrap gap-2" aria-label={t("settings.more")}>
          {[
            ["/types", t("nav.types"), Shapes],
            ["/activity", t("nav.activity"), History],
            ["/graph", t("nav.graph"), Waypoints],
            ["/trash", t("nav.trash"), Trash2],
          ].map(([path, label, I]: any) => (
            <a key={path} href={"#" + path} className="tap-y inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm hover:bg-hover">
              <I size={15} className="text-muted" /> {label}
            </a>
          ))}
        </nav>
      </div>

      <Examples />

      <section>
        <SectionTitle>{t("settings.language")}</SectionTitle>
        <Seg label={t("settings.language")} value={lang} onChange={setLang} options={[{ value: "de", label: "Deutsch" }, { value: "en", label: "English" }]} />
        <p className="mt-2 text-xs text-muted">{t("settings.languageHint")}</p>
      </section>

      <section>
        <SectionTitle>{t("settings.theme")}</SectionTitle>
        <Seg label={t("settings.theme")} value={theme.choice} onChange={setTheme} options={(["system", "light", "dark"] as const).map((v) => ({ value: v, label: t("theme." + v) }))} />
        <p className="mt-2 text-xs text-muted">{t("settings.themeHint")}</p>
      </section>

      <section>
        <SectionTitle>{t("settings.files")}</SectionTitle>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["online", "local"] as const).map((m) => (
            <button
              key={m}
              onClick={() => (files.setMode(m), m === "online" && files.dropOriginals())}
              className={cx("rounded-xl border p-3 text-left", fs.mode === m ? "border-[var(--focus)] bg-surface" : "border-line hover:bg-hover")}
              aria-pressed={fs.mode === m}
            >
              <p className="text-sm font-medium">{t("settings.mode." + m)}</p>
              <p className="text-xs text-muted">{t("settings.mode." + m + "Hint")}</p>
            </button>
          ))}
        </div>
        <p className="mt-2 text-sm text-muted">
          {t("settings.filesStatus", { local: fs.originals, total: fs.total, size: fmtBytes(lang, fs.bytes) })}
          {fs.downloading > 0 && ` · ${t("settings.downloading", { count: fs.downloading })}`}
          {fs.uploading > 0 && ` · ${t("settings.uploading", { count: fs.uploading })}`}
        </p>
      </section>

      <section>
        <SectionTitle>{t("settings.capture")}</SectionTitle>
        <p className="mb-2 text-sm text-muted">{t("settings.captureHint")}</p>
        <div className="flex flex-wrap gap-1.5">
          {types.map((tp) => (
            <button key={tp.id} onClick={() => toggleCapture(tp.id)} aria-pressed={capture.includes(tp.id)} className={cx("tap-y inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", capture.includes(tp.id) ? "border-[var(--focus)] text-fg" : "border-line text-muted")}>
              <TypeGlyph schema={tp.schema} size={12} /> {tp.schema!.name}
            </button>
          ))}
        </div>
        {chosen.length > 0 && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <span className="text-muted">{t("settings.captureFirst")}</span>
            <select value={chosen[0]} onChange={(e) => setFirst(e.target.value)} className="tap-row rounded-md border border-line bg-surface px-2 py-1">
              {chosen.map((id) => (
                <option key={id} value={id}>
                  {ix.types.get(id)!.schema!.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section>
        <SectionTitle>{t("settings.agent")}</SectionTitle>
        <p className="mb-3 text-sm text-muted">{t("settings.agentIntro")}</p>
        {agentMissing && <p className="mb-3 rounded-lg border border-line bg-surface-2 p-3 text-sm text-muted">{t("agent.noCli")}</p>}
        {err && !c && <p className="text-sm text-muted">{t("settings.connectOffline")}</p>}
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
            <p className="text-sm text-muted">
              {t("settings.mirror")} <code className="rounded bg-surface-2 px-1 font-mono text-xs">{c.vault}</code>
            </p>
          </div>
        )}
      </section>

      <section>
        <SectionTitle>{t("settings.sync")}</SectionTitle>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
          <dt className="text-muted">{t("settings.hub")}</dt>
          <dd>{s.online ? t("settings.connected") : t("settings.offline")}</dd>
          {s.pending > 0 && (
            <>
              <dt className="text-muted">{t("settings.pending")}</dt>
              <dd>{s.pending}</dd>
            </>
          )}
          <dt className="text-muted">{t("settings.onDevice")}</dt>
          <dd>{t("settings.counts", { items: ix.live.filter((i) => i.kind === "info").length, files: ix.live.filter((i) => i.kind === "datei").length, types: ix.types.size })}</dd>
        </dl>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-muted hover:text-fg">{t("settings.advanced")}</summary>
          <dl className="mt-2 grid grid-cols-[10rem_1fr] gap-y-1.5">
            <dt className="text-muted">{t("settings.position")}</dt>
            <dd className="tabular-nums">#{s.lastSeq}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => r.resetLocal()}>
              {t("settings.redownload")}
            </Button>
            <Button variant="outline" onClick={() => resetInbox(repo.writer)}>
              <RotateCcw size={14} /> {t("inbox.reset")}
            </Button>
          </div>
        </details>
      </section>

      <section>
        <SectionTitle>{t("settings.device")}</SectionTitle>
        <label className="flex items-center gap-3 text-sm">
          <span className="text-muted">{t("settings.deviceName")}</span>
          <input
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            onBlur={() => {
              localStorage.setItem("obtion.device", device.trim() || r.device);
              r.device = device.trim() || r.device;
            }}
            className="rounded-md border border-line bg-surface px-2 py-1"
          />
        </label>
        <p className="mt-2 text-xs text-muted">{t("settings.deviceHint")}</p>
      </section>
    </div>
  );
}
