// Talking to a running Obtion server: MCP tools for notes (create, update with base_version, place,
// delete), the item list for a subtree, and the HTTP file API for originals.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { CliError, type Config } from "./config";

export interface RemoteFile {
  name: string;
  hash: string;
  size: number;
  mime: string;
}

/** One item as GET /api/items lists it. */
export interface Node {
  id: string;
  kind: "info" | "file";
  title: string;
  type: string | null;
  version: string;
  parents: string[];
  home: string | null;
  source?: string;
  created: number;
  updated: number;
  body?: string;
  file?: RemoteFile;
  properties?: Record<string, unknown>;
  updates?: { at: number; text: string }[];
}

export interface Tree {
  root: string;
  items: Node[];
}

/** A tool said no ("Nothing changed. …"). `stale`: the base_version was out of date. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly stale = /changed since you read it/.test(message),
  ) {
    super(message);
  }
}

/** One line of a writing tool's answer: "- Title [id] · … · version v". */
export function writtenLines(text: string): { id: string; version?: string }[] {
  const out: { id: string; version?: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^- .*? \[([0-9a-z]{17})\] · /.exec(line);
    if (m) out.push({ id: m[1]!, version: / · version ([0-9a-f]{12})$/.exec(line)?.[1] });
  }
  return out;
}

let rpcId = 0;

export class Client {
  readonly base: string;
  constructor(readonly cfg: Config) {
    this.base = `${cfg.server}/w/${encodeURIComponent(cfg.workspace)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.token}`, "x-obtion-agent": "obtion-cli", ...extra };
  }

  private async fetch(path: string, init: RequestInit & { retry?: boolean } = {}): Promise<Response> {
    const tries = init.retry ? 3 : 1;
    for (let i = 1; ; i++) {
      try {
        const res = await fetch(this.base + path, init);
        if (res.status === 401 || res.status === 403) throw new CliError(`${res.status}: the token was not accepted for workspace ${this.cfg.workspace}. Log in again (obtion login).`);
        if (res.status >= 500 && i < tries) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        if (e instanceof CliError || i >= tries) throw e instanceof CliError ? e : new CliError(`${this.cfg.server}: ${(e as Error).message}`);
        await Bun.sleep(300 * i);
      }
    }
  }

  /** An MCP tool call; its answer text. A refused call throws ToolError. */
  async tool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.fetch("/mcp", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", accept: "application/json, text/event-stream" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    if (!res.ok) throw new CliError(`${name}: HTTP ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean }; error?: { message: string } };
    if (r.error) throw new CliError(`${name}: ${r.error.message}`);
    const text = (r.result?.content ?? []).map((c) => c.text).join("\n");
    if (r.result?.isError) throw new ToolError(text);
    return text;
  }

  /** The item and everything below it. */
  async tree(under: string): Promise<Tree> {
    const res = await this.fetch(`/api/items?under=${encodeURIComponent(under)}`, { headers: this.headers(), retry: true });
    if (res.status === 404) throw new CliError(`${await res.text()}`);
    if (!res.ok) throw new CliError(`Listing "${under}" failed: HTTP ${res.status} ${await res.text()}.`);
    return (await res.json()) as Tree;
  }

  /** These items now (unknown ones or those in the trash are missing). */
  async items(ids: string[]): Promise<Node[]> {
    const out: Node[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const res = await this.fetch(
        `/api/items?ids=${ids
          .slice(i, i + 100)
          .map(encodeURIComponent)
          .join(",")}`,
        { headers: this.headers(), retry: true },
      );
      if (!res.ok) throw new CliError(`Reading items failed: HTTP ${res.status} ${await res.text()}`);
      out.push(...((await res.json()) as { items: Node[] }).items);
    }
    return out;
  }

  /** A new file from disk (streamed), below `parent`. */
  async upload(path: string, name: string, parent: string): Promise<{ id: string; hash: string; size: number }> {
    const q = new URLSearchParams({ name, parent });
    const res = await this.fetch(`/api/files?${q}`, { method: "POST", headers: this.headers(), body: Bun.file(path) });
    if (res.status !== 201) throw new CliError(`Upload of ${name} failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as { id: string; hash: string; size: number };
  }

  /** New content for an existing file (the old one stays in its history), only while it still has `expect`. */
  async replace(id: string, path: string, expect: string): Promise<{ id: string; hash: string; size: number } | "stale"> {
    const res = await this.fetch(`/api/files/${encodeURIComponent(id)}`, { method: "PUT", headers: this.headers({ "if-match": `"${expect}"` }), body: Bun.file(path), retry: true });
    if (res.status === 412) return "stale";
    if (!res.ok) throw new CliError(`Replacing ${id} failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as { id: string; hash: string; size: number };
  }

  /** The original into `dest` (through a temporary file next to it), checked against its SHA-256. */
  async download(id: string, dest: string, tmp: string, expect?: string): Promise<{ hash: string; size: number }> {
    const res = await this.fetch(`/api/files/${encodeURIComponent(id)}`, { headers: this.headers(), retry: true });
    if (!res.ok || !res.body) throw new CliError(`Download of ${id} failed: HTTP ${res.status} ${await res.text()}`);
    const want = expect ?? res.headers.get("x-obtion-hash") ?? undefined;
    mkdirSync(dirname(tmp), { recursive: true });
    const h = createHash("sha256");
    const w = Bun.file(tmp).writer();
    let size = 0;
    try {
      for await (const chunk of res.body) {
        h.update(chunk);
        w.write(chunk);
        size += chunk.byteLength;
      }
      await w.end();
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new CliError(`Download of ${id} broke off: ${(e as Error).message}`);
    }
    const hash = h.digest("hex");
    if (want && hash !== want) {
      rmSync(tmp, { force: true });
      throw new CliError(`Download of ${id}: SHA-256 ${hash} instead of ${want}. Nothing written.`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(tmp, dest);
    return { hash, size };
  }
}

/** Runs `fn` over `items`, at most `n` at a time. */
export async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}
