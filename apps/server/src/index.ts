// Obtion server: accounts and workspaces, the sync WebSocket, the API and MCP endpoint of every
// workspace, the in-app agent; serves the web app too (unless OBTION_WEB_APP=off).
//
// Everything of a workspace lives under /w/<id>/… (sync, files, activity, undo, agent, MCP) and
// needs a member's token (Authorization: Bearer, on the WebSocket as subprotocol). With a token
// any site may call it (CORS): an app served by one server can hold workspaces of others.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import type { ServerWebSocket } from "bun";
import { Store } from "./store";
import { INSTRUCTIONS } from "./mcp";
import { agentAvailable } from "./agent";
import { Accounts, AccountError, type SignupPolicy } from "./accounts";
import { type Conn, Workspace } from "./workspace";
import { SETTINGS_ID } from "@obtion/core/model";
import type { ClientMsg } from "@obtion/core/protocol";
import { allowedHosts } from "./trust";

const PORT = Number(process.env.PORT ?? 8480);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA = resolve(process.env.OBTION_DATA ?? "data");
/** The built web app (apps/web/dist); OBTION_WEB_DIST points elsewhere. */
const DIST = resolve(process.env.OBTION_WEB_DIST ?? join(import.meta.dir, "../../web/dist"));
const PUBLIC_URL = process.env.OBTION_PUBLIC_URL ?? "";
/** Every server brings the web app; OBTION_WEB_APP=off makes it a server for sync, API and MCP only. */
const WEB_APP = !/^(off|0|false|no)$/i.test(process.env.OBTION_WEB_APP ?? "on");
/** Who may create an account (the first one always may, it becomes the admin): open | invite | off. */
const SIGNUP = (["open", "invite", "off"].includes(process.env.OBTION_SIGNUP ?? "") ? process.env.OBTION_SIGNUP : "invite") as SignupPolicy;
/** Who may use the in-app agent (it runs on the server's Claude login): admins | all | off. */
const AGENT = (process.env.OBTION_AGENT ?? "admins").toLowerCase();

mkdirSync(DATA, { recursive: true });
const configPath = join(DATA, "config.json");
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
// token: the MCP token from before accounts (still opens the data from then at /mcp);
// agentToken: lets the in-app agent call the MCP endpoint of any workspace (never leaves the server)
const config: { token: string; agentToken?: string; authSecret?: string } = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : { token: random() };
const freshConfig = !config.agentToken || !config.authSecret || !existsSync(configPath);
config.agentToken ??= random();
config.authSecret ??= random() + random();
if (freshConfig) writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

const accounts = new Accounts(DATA, { secret: config.authSecret, baseURL: PUBLIC_URL || `http://${HOST}:${PORT}`, policy: SIGNUP });
await accounts.init((dir) => {
  const s = new Store(dir);
  const lang = s.records.get(SETTINGS_ID)?.settings?.setupLang;
  s.db.close();
  return lang === "en" ? "Personal" : "Persönlich";
});
const legacyId = (accounts.db.query("SELECT id FROM workspaces WHERE legacy = 1").get() as { id: string } | null)?.id;

/** Workspaces in use, opened on first use. */
const open = new Map<string, Workspace>();
function workspace(id: string): Workspace | undefined {
  let w = open.get(id);
  if (!w && accounts.exists(id)) open.set(id, (w = new Workspace(id, accounts.dir(id))));
  return w;
}

console.log(`[obtion] ${accounts.userCount()} accounts, signup ${SIGNUP}, data in ${DATA}`);

// ---------- http ----------

/**
 * Browsers always send Origin on WebSocket upgrades and cross-site requests. Requests that
 * rely on nothing but being sent by a browser (the sign-in pages) must come from this site.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

// DNS rebinding guard (trust.ts): addresses and private names always, public names when configured.
const allowedHost = allowedHosts([
  PUBLIC_URL ? new URL(PUBLIC_URL).host : "",
  ...(process.env.OBTION_ALLOWED_HOSTS ?? "").split(","),
]);

/** The bearer token of a request; on a WebSocket (no headers in browsers) the subprotocol "auth.<token>". */
function tokenOf(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const proto = req.headers.get("sec-websocket-protocol");
  return proto
    ?.split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith("auth."))
    ?.slice(5);
}

const json = (x: unknown, status = 200) => Response.json(x, { status });
const fail = (e: unknown) => {
  if (e instanceof AccountError) return json({ error: e.message }, e.status);
  throw e;
};

async function body<T>(req: Request): Promise<T | null> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  return (await req.json().catch(() => null)) as T | null;
}

async function serveStatic(path: string): Promise<Response> {
  const clean = path.replace(/\.\.+/g, "");
  let file = Bun.file(join(DIST, clean === "/" ? "index.html" : clean));
  let isIndex = clean === "/";
  if (!(await file.exists())) {
    if (extname(clean)) return new Response("Not found", { status: 404 });
    file = Bun.file(join(DIST, "index.html"));
    isIndex = true;
    if (!(await file.exists())) return new Response("Web app not built. Run `bun run build`.", { status: 503 });
  }
  const immutable = clean.startsWith("/assets/");
  return new Response(file, {
    headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : isIndex || clean.endsWith("sw.js") ? "no-cache" : "public, max-age=3600" },
  });
}

const agentAllowed = (user: string) => agentAvailable() && (AGENT === "all" || (AGENT === "admins" && accounts.isAdmin(user)));

/** The account API: who am I, my workspaces, invites, tokens. `null`: not this path. */
async function accountApi(req: Request, path: string, url: URL): Promise<Response | null> {
  if (path === "/api/info") {
    return json({ signup: SIGNUP, firstAccount: accounts.userCount() === 0, agent: agentAvailable() });
  }

  if (path === "/api/account/signup" && req.method === "POST") {
    const b = await body<{ name?: string; email?: string; password?: string; invite?: string; lang?: string; none?: boolean }>(req);
    if (!b?.email || !b.password) return json({ error: "email and password required" }, 400);
    return accounts
      .signUp({ name: b.name ?? "", email: b.email, password: b.password, invite: b.invite || undefined, personal: b.none ? undefined : b.lang === "en" ? "Personal" : "Persönlich" })
      .then((r) => json(r), fail);
  }

  if (path.startsWith("/api/invites/")) {
    const code = path.slice("/api/invites/".length);
    const inv = accounts.invite(code);
    if (!inv) return json({ error: "invite invalid" }, 404);
    if (req.method === "GET") return json({ workspace: inv.name, by: inv.by, signup: accounts.canSignUp(code) });
  }

  const token = tokenOf(req);
  const user = await accounts.userOf(token);
  if (!user) return path.startsWith("/api/account") || path.startsWith("/api/workspaces") || path.startsWith("/api/invites/") ? json({ error: "unauthorized" }, 401) : null;
  try {
    if (path === "/api/account" && req.method === "GET") {
      return json({ user, admin: accounts.isAdmin(user.id), agent: agentAllowed(user.id), workspaces: accounts.workspacesOf(user.id) });
    }
    if (path === "/api/account/signout" && req.method === "POST") return (await accounts.signOut(token!), json({ ok: true }));
    if (path === "/api/workspaces" && req.method === "POST") {
      const b = await body<{ name?: string }>(req);
      if (!b?.name?.trim()) return json({ error: "name required" }, 400);
      return json(accounts.createWorkspace(user.id, b.name));
    }
    if (path.startsWith("/api/invites/") && req.method === "POST") return json(accounts.join(path.slice("/api/invites/".length), user.id));
    const m = path.match(/^\/api\/workspaces\/([\w-]+)(\/[\w/-]*)?$/);
    if (m) {
      const [, id, sub = ""] = m as unknown as [string, string, string?];
      if (!accounts.role(id, user.id)) return json({ error: "not a member" }, 403);
      if (sub === "" && req.method === "PATCH") {
        accounts.rename(id, user.id, (await body<{ name?: string }>(req))?.name ?? "");
        return json({ ok: true });
      }
      if (sub === "/members" && req.method === "GET") return json(accounts.members(id));
      if (sub.startsWith("/members/") && req.method === "DELETE") return (accounts.removeMember(id, user.id, sub.slice("/members/".length)), json({ ok: true }));
      if (sub === "/invites" && req.method === "POST") return json({ code: accounts.createInvite(id, user.id) });
      // MCP: a token for agents on this workspace, shown once
      if (sub === "/mcp-token" && req.method === "POST") {
        const base = PUBLIC_URL || `${url.protocol}//${req.headers.get("host")}`;
        const mcpUrl = `${base}/w/${id}/mcp`;
        const t = accounts.mcpToken(id, user.id);
        return json({
          mcpUrl,
          token: t,
          claudeCode: `claude mcp add --transport http obtion ${mcpUrl} --header "Authorization: Bearer ${t}" -s user`,
          json: { mcpServers: { obtion: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${t}` } } } },
          vault: join(accounts.dir(id), "vault"),
          instructions: INSTRUCTIONS,
        });
      }
    }
  } catch (e) {
    return fail(e);
  }
  return null;
}

const server = Bun.serve<Conn>({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!allowedHost(req.headers.get("host"))) return new Response("Unknown host. Add it to OBTION_ALLOWED_HOSTS or set OBTION_PUBLIC_URL.", { status: 421 });

    // sign-in and sign-up of the app's own page (Better Auth; accounts are created through /api/account/signup)
    if (path.startsWith("/api/auth/")) {
      if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
      if (path.startsWith("/api/auth/sign-up")) return new Response("Not found", { status: 404 });
      return accounts.auth.handler(req);
    }

    const api = path.startsWith("/api/") || path.startsWith("/w/") || path === "/mcp";
    // a change without a token must come from this site (CSRF): without one only the sign-up is open
    if (api && req.method !== "GET" && !tokenOf(req) && !sameOrigin(req)) return new Response("Forbidden", { status: 403 });

    if (path === "/mcp") {
      // the MCP address from before accounts: its token opens the data from then
      if (!legacyId || req.headers.get("authorization") !== `Bearer ${config.token}`) return json({ error: "unauthorized" }, 401);
      return workspace(legacyId)!.mcp(req);
    }

    if (path.startsWith("/api/")) return (await accountApi(req, path, url)) ?? new Response("Not found", { status: 404 });

    const m = path.match(/^\/w\/([\w-]{1,40})(\/.*)$/);
    if (m) {
      const [, id, rest] = m as unknown as [string, string, string];
      const token = tokenOf(req) ?? (req.method === "GET" && rest.startsWith("/api/blobs/") ? (url.searchParams.get("t") ?? undefined) : undefined);
      if (rest === "/mcp") {
        // the in-app agent (server-internal token) or an agent with a member's MCP token
        const agent = token === config.agentToken;
        const user = agent ? undefined : token && accounts.mcpUser(id, token);
        if ((!agent && !user) || !workspace(id)) return json({ error: "unauthorized" }, 401);
        return workspace(id)!.mcp(req);
      }
      const user = await accounts.userOf(token);
      if (!user) return json({ error: "unauthorized" }, 401);
      if (!accounts.role(id, user.id)) return json({ error: "not a member" }, 403);
      const w = workspace(id);
      if (!w) return json({ error: "no such workspace" }, 404);
      if (rest === "/sync") {
        const name = user.name.split(/\s+/)[0] || user.email.split("@")[0]!;
        const ok = srv.upgrade(req, { data: { workspace: id, areas: new Set<string>(), origin: `web:${name}`, user: name }, headers: { "sec-websocket-protocol": "obtion" } });
        return ok ? undefined : new Response("Expected WebSocket", { status: 400 });
      }
      return w.handle(req, rest, {
        user: user.name.split(/\s+/)[0] || user.email.split("@")[0]!,
        agent: { allowed: agentAllowed(user.id), mcpUrl: `http://127.0.0.1:${PORT}/w/${id}/mcp`, token: config.agentToken!, model: process.env.OBTION_AGENT_MODEL },
      });
    }

    if (!WEB_APP) return new Response("This Obtion server serves sync, API and MCP only (OBTION_WEB_APP=off).", { status: 404 });
    return serveStatic(path);
  },
  websocket: {
    maxPayloadLength: 64 * 1024 * 1024,
    open(ws) {
      open.get(ws.data.workspace)?.conns.add(ws);
    },
    close(ws) {
      open.get(ws.data.workspace)?.conns.delete(ws);
    },
    message(ws: ServerWebSocket<Conn>, raw) {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      open.get(ws.data.workspace)?.message(ws, msg);
    },
  },
});

console.log(`[obtion] listening on http://${server.hostname}:${server.port}${WEB_APP ? "" : " (no web app: OBTION_WEB_APP=off)"}`);

function stop() {
  for (const w of open.values()) w.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
