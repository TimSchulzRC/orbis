// In-app agent: runs headless Claude Code (`claude -p`) with *only* the Obtion
// MCP tools (no shell, no file access) and streams its events to the browser.
// Uses the Claude Code login already present on the hub machine.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { todayISO } from "@obtion/core/model";

export interface AgentEvent {
  type: "session" | "text" | "tool" | "tool_result" | "done" | "error";
  [k: string]: unknown;
}

export interface AgentOptions {
  message: string;
  sessionId?: string;
  context?: string;
  model?: string;
  mcpUrl: string;
  token: string;
  dataDir: string;
  signal: AbortSignal;
}

const CLAUDE_BIN = process.env.OBTION_CLAUDE_BIN || "claude";
const MODELS = ["sonnet", "opus", "haiku"];

export function agentAvailable(): boolean {
  return !!Bun.which(CLAUDE_BIN);
}

export async function* runAgent(o: AgentOptions): AsyncGenerator<AgentEvent> {
  const cwd = join(o.dataDir, "agent");
  mkdirSync(cwd, { recursive: true });
  const mcpConfig = JSON.stringify({
    mcpServers: {
      obtion: { type: "http", url: o.mcpUrl, headers: { Authorization: `Bearer ${o.token}`, "x-obtion-agent": "chat" } },
    },
  });
  const system = [
    `You are the assistant inside Obtion, the user's personal knowledge graph and project manager. Today is ${todayISO()} (${new Date().toLocaleDateString("en-GB", { weekday: "long" })}).`,
    "Use the obtion MCP tools for everything; you have no other tools. Read before you write, and after changing data say briefly what you changed (titles, statuses).",
    "Always reply in the language of the user's latest message, even if the notes are in another language.",
    "Keep answers short and scannable – the user is often on a phone. Use Markdown lists. Mention nodes as [[Title]] so the app can link them.",
    "Use the app's own words: in German the inbox is the „Eingang“ (never „Posteingang“), an information without type but with a place is a „Notiz“; a type's list is named by its plural („Projekte“).",
    o.context ? `The user currently has this open in the app: ${o.context}. "this", "here" etc. refer to it.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--tools",
    "",
    "--allowedTools",
    "mcp__obtion",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--append-system-prompt",
    system,
  ];
  if (o.model && MODELS.includes(o.model)) args.push("--model", o.model);
  if (o.sessionId && /^[0-9a-f-]{36}$/i.test(o.sessionId)) args.push("--resume", o.sessionId);
  // "--" ends option parsing, so a message starting with "--" stays a prompt.
  args.push("--", o.message);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Do not leak a parent Claude Code session into the child.
    if (k === "CLAUDECODE" || (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN") || k === "CLAUDE_AGENT_SDK_VERSION") continue;
    env[k] = v;
  }

  const proc = Bun.spawn([CLAUDE_BIN, ...args], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const onAbort = () => proc.kill();
  o.signal.addEventListener("abort", onAbort);

  const toolNames = new Map<string, string>();
  let sessionId = o.sessionId;
  let gotResult = false;
  let streamedText = false;
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId = msg.session_id;
          yield { type: "session", id: sessionId };
        } else if (msg.type === "stream_event") {
          const ev = msg.event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            streamedText = true;
            yield { type: "text", delta: ev.delta.text };
          } else if (ev?.type === "message_start" && streamedText) {
            yield { type: "text", delta: "\n\n" };
          }
        } else if (msg.type === "assistant") {
          for (const c of msg.message?.content ?? []) {
            if (c.type === "tool_use") {
              const name = String(c.name).replace(/^mcp__obtion__/, "");
              toolNames.set(c.id, name);
              yield { type: "tool", id: c.id, name, input: c.input };
            }
          }
        } else if (msg.type === "user") {
          for (const c of msg.message?.content ?? []) {
            if (c.type === "tool_result") {
              const content = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("") : String(c.content ?? "");
              yield { type: "tool_result", id: c.tool_use_id, name: toolNames.get(c.tool_use_id), ok: !c.is_error, preview: content.slice(0, 300) };
            }
          }
        } else if (msg.type === "result") {
          gotResult = true;
          sessionId = msg.session_id ?? sessionId;
          if (msg.is_error) yield { type: "error", message: msg.result || msg.subtype || "Agent failed" };
          yield { type: "done", sessionId, cost: msg.total_cost_usd, turns: msg.num_turns };
        }
      }
    }
    const code = await proc.exited;
    if (!gotResult && !o.signal.aborted) {
      const err = await new Response(proc.stderr as ReadableStream).text();
      yield { type: "error", message: (err.trim() || `claude exited with code ${code}`).slice(0, 1000) };
      yield { type: "done", sessionId };
    }
  } finally {
    o.signal.removeEventListener("abort", onAbort);
    if (proc.exitCode === null) proc.kill();
  }
}
