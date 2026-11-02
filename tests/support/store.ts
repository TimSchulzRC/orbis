import { Store } from "@obtion/server/store";
import { Ops } from "@obtion/server/ops";
import { handleMcp } from "@obtion/server/mcp";
import { runSetup } from "@obtion/core/setup";
import { storeWriter } from "@obtion/server/setup";
import { tempDir } from "./helpers";
import { MCP_ACCEPT, rpcBody, toolText } from "./server";

/** A server store in a fresh data directory, set up in German, with the agent's operations on it. */
export function setupStore(prefix: string, cacheSize?: number) {
  const dir = tempDir(prefix);
  const s = new Store(dir, cacheSize);
  runSetup(storeWriter(s, "system:setup"), "de");
  s.flush();
  return { dir, s, ops: new Ops(s) };
}

/** The step id in an agent call's answer ("… (step s… – undo it …)"). */
export const stepOf = (out: string) => /\(step (s\w+)/.exec(out)![1]!;

/** One MCP request straight into the store's handler, no server in between. */
export async function rpc(s: Store, method: string, params?: unknown): Promise<any> {
  const req = new Request("http://127.0.0.1/mcp", { method: "POST", headers: { "content-type": "application/json", accept: MCP_ACCEPT }, body: rpcBody(method, params) });
  return (await handleMcp(s, req)).json();
}
export async function tool(s: Store, name: string, args: unknown): Promise<{ text: string; error: boolean }> {
  const r = await rpc(s, "tools/call", { name, arguments: args });
  return { text: toolText(r), error: !!r.result.isError };
}
