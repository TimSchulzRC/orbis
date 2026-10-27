import { useEffect, useRef, useState } from "react";
import { X, Send, Square, Plus, Mic, Wrench, Check, AlertTriangle, Sparkles } from "lucide-react";
import type { Item } from "@obtion/core/model";
import { Markdown } from "./Markdown";
import { Button, Empty, cx, IconButton, ItemIcon, shortcut, useModal } from "./bits";
import { go, useRepo } from "../hooks";
import { repo } from "../repo";
import { tr, useT } from "../i18n";

interface ToolCall {
  id: string;
  name: string;
  input: any;
  ok?: boolean;
  preview?: string;
}
interface Msg {
  role: "user" | "assistant";
  text: string;
  tools?: ToolCall[];
  error?: string;
}

const MODELS = [
  { id: "sonnet", label: "Sonnet", hint: "agent.model.fast" },
  { id: "opus", label: "Opus", hint: "agent.model.thorough" },
  { id: "haiku", label: "Haiku", hint: "agent.model.fastest" },
];

function load<T>(k: string, d: T): T {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "") as T;
  } catch {
    return d;
  }
}

function toolLabel(t: ToolCall): string {
  const i = t.input ?? {};
  // Agents often pass ids: show the item's title instead.
  const name = (ref?: string) => (ref ? (repo.get(ref)?.title ?? ref) : undefined);
  const target =
    (t.name === "create" ? (i.title ?? i.items?.map((x: any) => x.title).join(", ")) : undefined) ??
    name(i.ref) ??
    i.name ??
    i.title ??
    (i.query !== undefined ? `“${i.query}”` : undefined) ??
    (Array.isArray(i.refs) ? i.refs.map(name).join(", ") : undefined);
  const label = tr("agent.tool." + t.name);
  return `${label.startsWith("agent.tool.") ? t.name : label}${target ? ` ${typeof target === "string" ? target : ""}` : ""}`.trim();
}

const WRITE_TOOLS = new Set(["create", "update", "place", "add_update", "define_type", "update_type", "attach", "suggest", "delete", "restore"]);

export function AgentPanel({ context, onClose, overlay }: { context?: Item; onClose: () => void; overlay: boolean }) {
  const r = useRepo();
  const { t, lang } = useT();
  const [msgs, setMsgs] = useState<Msg[]>(() => load("obtion.chat", []));
  const [session, setSession] = useState<string | undefined>(() => load("obtion.chatSession", undefined));
  const [model, setModel] = useState<string>(() => localStorage.getItem("obtion.model") ?? "sonnet");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [useContext, setUseContext] = useState(true);
  const [available, setAvailable] = useState<boolean | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/info")
      .then((res) => res.json())
      .then((i) => setAvailable(!!i.agent))
      .catch(() => setAvailable(false));
  }, [r.status.online]);

  useEffect(() => {
    localStorage.setItem("obtion.chat", JSON.stringify(msgs.slice(-60)));
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [msgs]);
  useEffect(() => {
    localStorage.setItem("obtion.chatSession", JSON.stringify(session ?? null));
  }, [session]);

  const sendRef = useRef<(t: string, shown?: string) => void>(() => {});
  useEffect(() => {
    const consume = () => {
      const draft = sessionStorage.getItem("obtion.agentDraft");
      if (draft) {
        sessionStorage.removeItem("obtion.agentDraft");
        let d: { text: string; shown?: string };
        try {
          d = JSON.parse(draft);
        } catch {
          d = { text: draft };
        }
        sendRef.current(d.text, d.shown);
      } else if (matchMedia("(min-width: 1024px)").matches) inputRef.current?.focus(); // no keyboard pop-up on phones
    };
    consume();
    window.addEventListener("obtion:ask", consume);
    return () => window.removeEventListener("obtion:ask", consume);
  }, []);

  const patchLast = (fn: (m: Msg) => Msg) => setMsgs((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1]!)]);

  async function send(text: string, shown?: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMsgs((ms) => [...ms, { role: "user", text: shown?.trim() || message }, { role: "assistant", text: "", tools: [] }]);
    const ac = new AbortController();
    abort.current = ac;
    const ctx = useContext && context ? `${context.kind === "datei" ? "file" : (r.index().typeName(context.type) ?? "information")} "${context.title}" (id ${context.id})` : undefined;
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, sessionId: session, context: ctx, model }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(t("agent.unavailable", { status: res.status }));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!chunk.startsWith("data: ")) continue;
          const ev = JSON.parse(chunk.slice(6));
          if (ev.type === "session") setSession(ev.id);
          else if (ev.type === "text") patchLast((m) => ({ ...m, text: m.text + ev.delta }));
          else if (ev.type === "tool") patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), { id: ev.id, name: ev.name, input: ev.input }] }));
          else if (ev.type === "tool_result")
            patchLast((m) => ({ ...m, tools: (m.tools ?? []).map((t) => (t.id === ev.id ? { ...t, ok: ev.ok, preview: ev.preview } : t)) }));
          else if (ev.type === "error") patchLast((m) => ({ ...m, error: ev.message }));
          else if (ev.type === "done" && ev.sessionId) setSession(ev.sessionId);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        patchLast((m) => ({ ...m, error: r.status.online ? (e as Error).message : t("agent.offline") }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  sendRef.current = send;

  const newChat = () => {
    abort.current?.abort();
    setMsgs([]);
    setSession(undefined);
    inputRef.current?.focus();
  };

  // on a phone the agent covers the page: a modal sheet (focus stays in, Escape closes)
  const sheet = useRef<HTMLElement | null>(null);
  useModal(overlay ? sheet : { current: null }, onClose);
  const suggestions = [t("agent.s1"), context ? t("agent.sContext", { title: context.title }) : t("agent.s2"), t("agent.s3"), t("agent.s4")];

  return (
    <aside
      ref={sheet}
      role={overlay ? "dialog" : undefined}
      aria-modal={overlay || undefined}
      className={cx(
        "flex flex-col bg-surface",
        overlay ? "fixed inset-0 z-40 pt-safe pb-safe" : "w-[400px] shrink-0 border-l border-line",
      )}
      aria-label={t("nav.agent")}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Sparkles size={16} className="text-muted" />
        <span className="font-medium">Agent</span>
        {/* how things stand, in one word: ready, not set up, offline (the hub was asked, not guessed) */}
        {available !== null && (
          <span className="inline-flex items-center gap-1 text-xs text-muted" role="status">
            <span className="size-1.5 rounded-full" style={{ background: available && r.status.online ? "var(--ok)" : "var(--faint)" }} />
            {!r.status.online ? t("agent.stateOffline") : available ? t("agent.stateReady") : t("agent.stateMissing")}
          </span>
        )}
        <select
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            localStorage.setItem("obtion.model", e.target.value);
          }}
          className="ml-1 rounded-md bg-transparent px-1 py-0.5 text-xs text-muted hover:bg-hover"
          aria-label={t("agent.model")}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {t(m.hint)}
            </option>
          ))}
        </select>
        <IconButton onClick={newChat} label={t("agent.newChat")} icon={Plus} className="ml-auto" />
        <IconButton onClick={onClose} label={t("agent.close", { key: shortcut("J", lang) })} icon={X} />
      </header>

      <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* not usable here: one sentence and the one next step, no suggestions to click into an error */}
        {available === false && (
          <div className="pt-6">
            <Empty title={r.status.online ? t("agent.notSetUp") : t("agent.offline")}>
              {r.status.online && (
                <Button variant="outline" onClick={() => (onClose(), go("/settings"))}>
                  {t("agent.openSetup")}
                </Button>
              )}
            </Empty>
          </div>
        )}
        {available !== false && msgs.length === 0 && (
          <div className="pt-6">
            <p className="mb-1 text-lg font-medium">{t("agent.hello")}</p>
            <p className="mb-4 text-sm text-muted">
              {t("agent.helloHint")}
            </p>
            <div className="flex flex-col gap-2">
              {suggestions.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-lg border border-line px-3 py-2 text-left text-sm text-muted hover:bg-hover hover:text-fg">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-8 whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-[15px]">
              {m.text}
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {!!m.tools?.length && (
                <div className="flex flex-wrap gap-1.5">
                  {m.tools.map((tc) => (
                    <span
                      key={tc.id}
                      title={tc.preview}
                      className={cx(
                        "inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-xs",
                        WRITE_TOOLS.has(tc.name) ? "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok" : "bg-surface-2 text-muted",
                      )}
                    >
                      {tc.ok === undefined ? <Wrench size={11} className="animate-pulse" /> : tc.ok ? <Check size={11} /> : <AlertTriangle size={11} className="text-danger" />}
                      <span className="truncate">{toolLabel(tc)}</span>
                    </span>
                  ))}
                </div>
              )}
              {m.text ? (
                <Markdown src={m.text} className="text-[15px]" />
              ) : busy && i === msgs.length - 1 ? (
                <div className="typing flex gap-1 py-2 text-muted" aria-label={t("agent.thinking")}>
                  <span>●</span>
                  <span>●</span>
                  <span>●</span>
                </div>
              ) : null}
              {m.error && <div className="rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-danger">{m.error}</div>}
            </div>
          ),
        )}
      </div>

      <div className="border-t border-line p-3">
        {context && (
          <button
            onClick={() => setUseContext(!useContext)}
            className={cx("mb-2 inline-flex max-w-full items-center gap-1.5 truncate rounded-md px-2 py-0.5 text-xs", useContext ? "bg-surface-2 text-muted" : "text-muted line-through")}
            title={t("agent.contextHint")}
          >
            <ItemIcon item={context} size={12} />
            <span className="truncate">{context.title || t("untitled")}</span>
          </button>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-end gap-2 rounded-xl border border-line bg-bg px-2 py-1.5 focus-within:border-[var(--focus)]"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={Math.min(6, Math.max(1, input.split("\n").length))}
            data-autofocus
            placeholder={available === false ? t("agent.notSetUpShort") : t("agent.placeholder")}
            disabled={available === false}
            className="max-h-40 flex-1 resize-none bg-transparent px-1 py-1 text-[15px] outline-none placeholder:text-muted focus-visible:outline-none"
          />
          <Dictate onText={(x) => setInput((v) => (v ? v + " " : "") + x)} />
          {busy ? (
            <button type="button" onClick={() => abort.current?.abort()} className="rounded-lg bg-ink p-2 text-ink-text" aria-label={t("agent.stop")}>
              <Square size={14} />
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() || available === false} className="rounded-lg bg-ink p-2 text-ink-text disabled:opacity-30" aria-label={t("agent.send")}>
              <Send size={14} />
            </button>
          )}
        </form>
      </div>
    </aside>
  );
}

/** Voice input via the Web Speech API where the browser supports it. */
function Dictate({ onText }: { onText: (t: string) => void }) {
  const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const [on, setOn] = useState(false);
  const rec = useRef<any>(null);
  if (!SR) return null;
  const toggle = () => {
    if (on) {
      rec.current?.stop();
      return;
    }
    const r = new SR();
    r.lang = navigator.language || "de-DE";
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e: any) => onText(Array.from(e.results as ArrayLike<any>).map((x: any) => x[0].transcript).join(" "));
    r.onend = () => setOn(false);
    r.onerror = () => setOn(false);
    rec.current = r;
    r.start();
    setOn(true);
  };
  return (
    <button type="button" onClick={toggle} className={cx("rounded-lg p-2", on ? "bg-danger text-white" : "text-muted hover:bg-hover")} aria-label={on ? tr("agent.dictateStop") : tr("agent.dictate")} title={tr("agent.dictate")}>
      <Mic size={14} />
    </button>
  );
}
