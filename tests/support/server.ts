import { createServer } from "node:net";
import { resolve } from "node:path";

export const MCP_ACCEPT = "application/json, text/event-stream";
let rpcId = 0;
export const rpcBody = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
/** The text of a tools/call answer, all parts joined. */
export const toolText = (r: any) => (r.result.content as { text: string }[]).map((c) => c.text).join("\n");

export const ROOT = resolve(import.meta.dir, "../..");

export function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

/** Sets up OBTION_DATA with the examples ("setup de --examples"). Its PORT is a free one: the
 * setup refuses to run while a server answers on it, and on a machine that runs Obtion itself
 * (the self-hosted CI runner) one does on the default port. */
export async function seedExamples(env: Record<string, string | undefined>) {
  const seed = Bun.spawnSync(["bun", "apps/server/src/cli.ts", "setup", "de", "--examples"], { cwd: ROOT, env: { ...env, PORT: String(await freePort()) } });
  if (seed.exitCode !== 0) throw new Error("seed failed: " + seed.stderr.toString());
}

/** The server as a program on a free port, answering once /api/info does. */
export async function bootServer(env: Record<string, string>, stderr: "ignore" | "inherit" = "ignore") {
  const port = await freePort();
  const proc = Bun.spawn(["bun", "apps/server/src/index.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env }, stdout: "ignore", stderr });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (await fetch(url + "/api/info").then((r) => r.ok, () => false)) return { url, proc };
    await Bun.sleep(50);
  }
  proc.kill();
  throw new Error("server did not start");
}

const auth = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
export const post = (base: string, path: string, body: unknown, token?: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...auth(token), ...headers }, body: JSON.stringify(body) });
export const get = (base: string, path: string, token?: string) => fetch(base + path, { headers: auth(token) });
export const del = (base: string, path: string, token?: string, body?: unknown) =>
  fetch(base + path, { method: "DELETE", headers: { ...auth(token), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

/** A JSON-RPC request to a server's MCP endpoint. */
export const mcpPost = (base: string, path: string, token: string, method: string, params?: unknown) =>
  fetch(base + path, { method: "POST", headers: { ...auth(token), "content-type": "application/json", accept: MCP_ACCEPT }, body: rpcBody(method, params) });
/** An MCP tool call over HTTP; the answer's text. */
export async function mcpTool(base: string, token: string, name: string, args: unknown, path = "/mcp"): Promise<string> {
  return toolText(await (await mcpPost(base, path, token, "tools/call", { name, arguments: args })).json());
}

/** Signs up the server's first account and returns it with its workspaces. */
export async function firstAccount(url: string) {
  const signup = (await post(url, "/api/account/signup", { name: "E2E", email: "e2e@example.org", password: "geheim12345", lang: "de" }).then((r) => r.json())) as { token: string };
  const me = (await get(url, "/api/account", signup.token).then((r) => r.json())) as { user: unknown; workspaces: { id: string }[] };
  return { token: signup.token, me };
}
