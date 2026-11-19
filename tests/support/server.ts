import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { Blobs } from "@obtion/server/blobs";
import { setUp } from "@obtion/server/setup";
import { Store } from "@obtion/server/store";

export const MCP_ACCEPT = "application/json, text/event-stream";
let rpcId = 0;
export const rpcBody = (method: string, params?: unknown) =>
	JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
/** The parts of an MCP JSON-RPC answer the tests read. */
export interface RpcAnswer {
	result: {
		content?: { text: string }[];
		isError?: boolean;
		prompts?: { name: string }[];
		messages?: { content: { text: string } }[];
		instructions?: string;
	};
}
export const toolText = (r: RpcAnswer) => r.result.content!.map((c) => c.text).join("\n");

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

/** The workspace folders in a data folder (workspaces/<id>). */
export function workspaceDirs(dataDir: string): string[] {
	const root = join(dataDir, "workspaces");
	return existsSync(root) ? readdirSync(root).map((n) => join(root, n)) : [];
}

/** Fills the first workspace of a data folder with the German setup and its examples, while no server runs on it. */
export async function seedExamples(dataDir: string) {
	const [dir] = workspaceDirs(dataDir);
	if (!dir) throw new Error(`no workspace in ${dataDir}`);
	const store = new Store(dir);
	const blobs = new Blobs(join(dir, "blobs"), store);
	await setUp(store, blobs, "de", { examples: true, quiet: false });
	blobs.stop();
	store.db.close();
}

/** The server as a program on a free port, answering once /api/info does. */
export async function bootServer(
	env: Record<string, string>,
	stderr: "ignore" | "inherit" = "ignore",
) {
	const port = await freePort();
	const proc = Bun.spawn(["bun", "apps/server/src/index.ts"], {
		cwd: ROOT,
		env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env },
		stdout: "ignore",
		stderr,
	});
	const url = `http://127.0.0.1:${port}`;
	// generous: beside the other checks on a CI runner, a boot can take over 10 s under load
	for (let i = 0; i < 400; i++) {
		if (
			await fetch(`${url}/api/info`).then(
				(r) => r.ok,
				() => false,
			)
		)
			return { url, proc };
		await Bun.sleep(50);
	}
	proc.kill();
	throw new Error("server did not start");
}

const auth = (token?: string): Record<string, string> =>
	token ? { authorization: `Bearer ${token}` } : {};
export const post = (
	base: string,
	path: string,
	body: unknown,
	token?: string,
	headers: Record<string, string> = {},
) =>
	fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/json", ...auth(token), ...headers },
		body: JSON.stringify(body),
	});
export const get = (base: string, path: string, token?: string) =>
	fetch(base + path, { headers: auth(token) });
export const del = (base: string, path: string, token?: string, body?: unknown) =>
	fetch(base + path, {
		method: "DELETE",
		headers: {
			...auth(token),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

export const mcpPost = (
	base: string,
	path: string,
	token: string,
	method: string,
	params?: unknown,
) =>
	fetch(base + path, {
		method: "POST",
		headers: { ...auth(token), "content-type": "application/json", accept: MCP_ACCEPT },
		body: rpcBody(method, params),
	});
export async function mcpTool(
	base: string,
	token: string,
	name: string,
	args: unknown,
	path: string,
): Promise<string> {
	return toolText(
		await (await mcpPost(base, path, token, "tools/call", { name, arguments: args })).json(),
	);
}

/** With `workspace`, creates one if the account has none, as the app would. */
export async function firstAccount(url: string, workspace = true) {
	const signup = (await post(url, "/api/account/signup", {
		name: "E2E",
		email: "e2e@example.org",
		password: "secret12345",
	}).then((r) => r.json())) as { token: string };
	const own = (await get(url, "/api/account", signup.token).then((r) => r.json())) as {
		workspaces: unknown[];
	};
	if (workspace && !own.workspaces.length)
		await post(url, "/api/workspaces", { name: "Persönlich" }, signup.token);
	const me = (await get(url, "/api/account", signup.token).then((r) => r.json())) as {
		user: unknown;
		workspaces: { id: string }[];
	};
	return { token: signup.token, me };
}
