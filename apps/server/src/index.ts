// Workspace routes under /w/<id>/ need a member's token. With a token any site may call them
// (CORS), so an app served by one server can hold workspaces of other servers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import type { ServerWebSocket } from "bun";
import { Store } from "./store";
import { Accounts, AccountError, FRESH_SECONDS, SIGNUP_COOKIE, randomToken } from "./accounts";
import { loginConfig, loginMethods } from "./login";
import type { AccountInfo, InviteCode, InviteInfo, InviteLink, McpConnect, Ok, Role, ServerInfo, SignedIn, SignupPolicy, SignupRequest } from "@obtion/core/api";
import { type Conn, Workspace, parseClientMsg } from "./workspace";
import { firstName, personOrigin } from "@obtion/core/origin";
import { type Lang, LANGS, translate } from "@obtion/core/i18n";
import { allowedHosts } from "./trust";
import { DATA, MAX_WS_MESSAGE, PORT } from "./config";
import { body, fail, json } from "./http";

const HOST = process.env.HOST ?? "127.0.0.1";
const DIST = resolve(process.env.OBTION_WEB_DIST ?? join(import.meta.dir, "../../web/dist"));
const PUBLIC_URL = process.env.OBTION_PUBLIC_URL ?? "";
const WEB_APP = !/^(off|0|false|no)$/i.test(process.env.OBTION_WEB_APP ?? "on");
/** The first account may always sign up. */
const SIGNUP = (["open", "invite", "off"].includes(process.env.OBTION_SIGNUP ?? "") ? process.env.OBTION_SIGNUP : "invite") as SignupPolicy;
/** Set by the Dockerfile, e.g. 0.0.2-nightly.20261030.41. */
const VERSION = process.env.OBTION_BUILD_VERSION || "dev";
const COMMIT = (process.env.OBTION_BUILD_COMMIT ?? "").slice(0, 7);

mkdirSync(DATA, { recursive: true });
const configPath = join(DATA, "config.json");
// token is the pre-accounts MCP token and still opens that data at /mcp.
const config: { token: string; authSecret?: string } = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : { token: randomToken() };
const freshConfig = !config.authSecret || !existsSync(configPath);
config.authSecret ??= randomToken() + randomToken();
if (freshConfig) writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

const legacyWorkspaceName = (lang?: string) => translate(LANGS.includes(lang as Lang) ? (lang as Lang) : "de", "account.personal");

const login = (() => {
  try {
    return loginConfig(process.env, PUBLIC_URL);
  } catch (e) {
    console.error(`[obtion] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
})();
const accounts = new Accounts(DATA, { secret: config.authSecret, baseURL: PUBLIC_URL || `http://${HOST}:${PORT}`, policy: SIGNUP, login,
  // someone else proved the address this user signed up with
  onRevoke: (user) => closeConnsOf(user, "signed out"),
});

await accounts.init((dir) => {
  const s = new Store(dir);
  const lang = s.lang();
  s.db.close();
  return legacyWorkspaceName(lang);
});
const legacyId = (accounts.db.query("SELECT id FROM workspaces WHERE legacy = 1").get() as { id: string } | null)?.id;

const open = new Map<string, Workspace>();
function workspace(id: string): Workspace | undefined {
  const known = open.get(id);
  if (known || !accounts.exists(id)) return known;
  const opened = new Workspace(accounts.dir(id));
  open.set(id, opened);
  return opened;
}

/** `keep` spares connections, e.g. of the session that made the change. */
function closeConnsOf(userId: string, reason: string, keep?: (conn: Conn) => boolean) {
  for (const w of open.values())
    for (const ws of w.conns) if (ws.data.userId === userId && !keep?.(ws.data)) ws.close(4401, reason);
}

const methods = loginMethods(login);
const methodNames = [methods.password && "password", methods.emailCode && "email code", methods.passkey && "passkey", ...methods.oauth.map((p) => p.id)].filter(Boolean).join(", ");
console.log(`[obtion] ${VERSION}${COMMIT ? ` (${COMMIT})` : ""}, ${accounts.userCount()} accounts, signup ${SIGNUP}, sign-in by ${methodNames}, data in ${DATA}`);

/** For requests trusted only because a browser sent them. Browsers always send Origin on WebSocket upgrades and cross-site requests. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

const allowedHost = allowedHosts([
  PUBLIC_URL ? new URL(PUBLIC_URL).host : "",
  ...(process.env.OBTION_ALLOWED_HOSTS ?? "").split(","),
]);

// Browsers cannot set headers on a WebSocket, so there the token comes as subprotocol "auth.<token>".
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

const accountError = (e: unknown) => {
  if (e instanceof AccountError) return fail(e.status, e.message);
  throw e;
};

const IMMUTABLE = "public, max-age=31536000, immutable";

function cacheControl(path: string, isIndex: boolean): string {
  if (path.startsWith("/assets/")) return IMMUTABLE;
  if (isIndex || path.endsWith("sw.js")) return "no-cache";
  return "public, max-age=3600";
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
  return new Response(file, { headers: { "cache-control": cacheControl(clean, isIndex) } });
}

const INVITES = "/api/invites/";
const isRole = (role: unknown): role is Role => role === "owner" || role === "member";

/** Returns null for paths it does not handle. */
async function accountApi(req: Request, path: string, url: URL): Promise<Response | null> {
  if (path === "/api/info") {
    return json<ServerInfo>({ signup: SIGNUP, firstAccount: accounts.userCount() === 0, login: methods, version: VERSION, commit: COMMIT });
  }

  // after an OAuth sign-in: the session in the cookie becomes the app's token, the cookie goes
  if (path === "/api/account/claim" && req.method === "POST") {
    const signedIn = await accounts.claim(req.headers);
    if (!signedIn) return fail(401, "unauthorized");
    const res = json<SignedIn>(signedIn);
    const ctx = await accounts.auth.$context;
    for (const c of [ctx.authCookies.sessionToken, ctx.authCookies.sessionData, ctx.authCookies.dontRememberToken])
      res.headers.append("set-cookie", `${c.name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${c.name.startsWith("__Secure-") ? "; Secure" : ""}`);
    res.headers.append("set-cookie", `${SIGNUP_COOKIE}=; Path=/api/auth; Max-Age=0; SameSite=Lax`);
    return res;
  }

  if (path === "/api/account/signup" && req.method === "POST") {
    const b = await body<SignupRequest>(req);
    if (!login.password) return fail(403, "passwords off");
    if (!b?.email || !b.password) return fail(400, "email and password required");
    const details = { name: b.name ?? "", email: b.email, password: b.password, invite: b.invite || undefined };
    return (login.sendCode ? accounts.signUpWithCode({ ...details, lang: b.lang, code: b.code || undefined }) : accounts.signUp(details)).then((r) => json(r), accountError);
  }

  if (path.startsWith(INVITES)) {
    const code = path.slice(INVITES.length);
    const inv = accounts.invite(code);
    if (!inv) return fail(404, "invite invalid");
    if (req.method === "GET") return json<InviteInfo>({ workspace: inv.name, by: inv.by, role: inv.role, signup: accounts.canSignUp(code) });
  }

  const token = tokenOf(req);
  const session = await accounts.session(token);
  const user = session?.user;
  if (!user) return path.startsWith("/api/account") || path.startsWith("/api/workspaces") || path.startsWith(INVITES) ? fail(401, "unauthorized") : null;
  try {
    if (path === "/api/account" && req.method === "GET") {
      return json<AccountInfo>({ user, admin: accounts.isAdmin(user.id), password: await accounts.hasPassword(user.id), workspaces: accounts.workspacesOf(user.id) });
    }
    if (path === "/api/account" && req.method === "DELETE") {
      // needs the password, or a recent sign-in for accounts without one
      const password = (await body<{ password?: unknown }>(req))?.password;
      const missing = password === undefined ? await accounts.hasPassword(user.id) : typeof password !== "string";
      if (missing) return fail(400, "password required");
      await accounts.deleteAccount(user.id, password as string | undefined, session!.created);
      closeConnsOf(user.id, "account deleted");
      return json<Ok>({ ok: true });
    }
    if (path === "/api/account/password" && req.method === "POST") {
      const b = await body<{ current?: unknown; next?: unknown }>(req);
      if (typeof b?.current !== "string" || typeof b.next !== "string") return fail(400, "passwords required");
      await accounts.changePassword(user.id, token!, b.current, b.next);
      // the other sessions were revoked, so close their connections
      closeConnsOf(user.id, "password changed", (conn) => conn.session === token);
      return json<Ok>({ ok: true });
    }
    if (path === "/api/account/signout" && req.method === "POST") return (await accounts.signOut(token!), json<Ok>({ ok: true }));
    if (path === "/api/workspaces" && req.method === "POST") {
      const b = await body<{ name?: string }>(req);
      if (!b?.name?.trim()) return fail(400, "name required");
      return json(accounts.createWorkspace(user.id, b.name));
    }
    if (path.startsWith(INVITES) && req.method === "POST") return json(accounts.join(path.slice(INVITES.length), user.id));
    const route = path.match(/^\/api\/workspaces\/(?<id>[\w-]+)(?<sub>\/[\w/-]*)?$/)?.groups;
    if (route) {
      const id = route.id!;
      const sub = route.sub ?? "";
      if (!accounts.role(id, user.id)) return fail(403, "not a member");
      if (sub === "" && req.method === "DELETE") {
        if (accounts.role(id, user.id) !== "owner") return fail(403, "only owners delete");
        open.get(id)?.shut();
        open.delete(id);
        accounts.deleteWorkspace(id, user.id);
        return json<Ok>({ ok: true });
      }
      if (sub === "" && req.method === "PATCH") {
        accounts.rename(id, user.id, (await body<{ name?: string }>(req))?.name ?? "");
        return json<Ok>({ ok: true });
      }
      if (sub === "/members" && req.method === "GET") return json(accounts.members(id));
      if (sub.startsWith("/members/") && req.method === "DELETE") {
        const gone = sub.slice("/members/".length);
        accounts.removeMember(id, user.id, gone);
        // stop their devices now, not at their next message
        for (const ws of open.get(id)?.conns ?? []) if (ws.data.userId === gone) ws.close(4401, "membership ended");
        return json<Ok>({ ok: true });
      }
      if (sub.startsWith("/members/") && req.method === "PATCH") {
        const role = (await body<{ role?: unknown }>(req))?.role;
        if (!isRole(role)) return fail(400, "role required");
        accounts.setRole(id, user.id, sub.slice("/members/".length), role);
        return json<Ok>({ ok: true });
      }
      if (sub === "/invites" && req.method === "GET") return json<InviteLink[]>(accounts.invites(id, user.id));
      if (sub === "/invites" && req.method === "POST") {
        const role = (await body<{ role?: unknown }>(req))?.role;
        if (role !== undefined && !isRole(role)) return fail(400, "role invalid");
        return json<InviteCode>({ code: accounts.createInvite(id, user.id, role ?? "member") });
      }
      if (sub.startsWith("/invites/") && req.method === "DELETE") return (accounts.revokeInvite(id, user.id, sub.slice("/invites/".length)), json<Ok>({ ok: true }));
      // the token is shown only once
      if (sub === "/mcp-token" && req.method === "POST") {
        const base = PUBLIC_URL || `${url.protocol}//${req.headers.get("host")}`;
        const mcpUrl = `${base}/w/${id}/mcp`;
        const mcpToken = accounts.mcpToken(id, user.id);
        return json<McpConnect>({
          mcpUrl,
          token: mcpToken,
          claudeCode: `claude mcp add --transport http obtion ${mcpUrl} --header "Authorization: Bearer ${mcpToken}" -s user`,
          json: { mcpServers: { obtion: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } } } },
          vault: join(accounts.dir(id), "vault"),
        });
      }
    }
  } catch (e) {
    return accountError(e);
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

    if (path.startsWith("/api/auth/")) {
      // an OAuth provider sends the browser back from its own site; Better Auth checks the state
      const callback = req.method === "GET" && path.startsWith("/api/auth/callback/");
      if (!callback && !sameOrigin(req)) return fail(403, "forbidden");
      // accounts are created through /api/account/signup
      if (path.startsWith("/api/auth/sign-up")) return fail(404, "not found");
      if (path.startsWith("/api/auth/passkey/") && !login.passkey) return fail(404, "not found");
      // linking a provider (its address may differ) needs a recent sign-in. Ask Better Auth for the
      // session so it reads the token the same way its handler will.
      if (path === "/api/auth/link-social") {
        const s = await accounts.auth.api.getSession({ headers: req.headers }).catch(() => null);
        if (!s || Date.now() - new Date(s.session.createdAt).getTime() > FRESH_SECONDS * 1000) return fail(403, "sign in again");
      }
      return accounts.auth.handler(req);
    }

    const api = path.startsWith("/api/") || path.startsWith("/w/") || path === "/mcp";
    // CSRF: a change without a token must come from this site
    if (api && req.method !== "GET" && !tokenOf(req) && !sameOrigin(req)) return fail(403, "forbidden");

    if (path === "/mcp") {
      // pre-accounts MCP address, opened by the old config token
      const old = legacyId ? workspace(legacyId) : undefined;
      if (!old || req.headers.get("authorization") !== `Bearer ${config.token}`) return fail(401, "unauthorized");
      return old.mcp(req);
    }

    if (path.startsWith("/api/")) return (await accountApi(req, path, url)) ?? fail(404, "not found");

    const route = path.match(/^\/w\/(?<id>[\w-]{1,40})(?<rest>\/.*)$/)?.groups;
    if (route) {
      const id = route.id!;
      const rest = route.rest!;
      // a file opened by URL (img, download link) carries the token as ?t=
      const blobRead = req.method === "GET" && rest.startsWith("/api/blobs/");
      const token = tokenOf(req) ?? (blobRead ? (url.searchParams.get("t") ?? undefined) : undefined);
      if (rest === "/mcp") {
        const user = token && accounts.mcpUser(id, token);
        if (!user || !workspace(id)) return fail(401, "unauthorized");
        return workspace(id)!.mcp(req, { id: user.id, name: firstName(user) });
      }
      const user = await accounts.userOf(token);
      if (!user) return fail(401, "unauthorized");
      if (!accounts.role(id, user.id)) return fail(403, "not a member");
      const w = workspace(id);
      if (!w) return fail(404, "no such workspace");
      const person = { id: user.id, name: firstName(user) };
      if (rest === "/sync") {
        const ok = srv.upgrade(req, { data: { workspace: id, areas: new Set<string>(), origin: personOrigin(person), user: person, userId: user.id, session: token }, headers: { "sec-websocket-protocol": "obtion" } });
        return ok ? undefined : fail(400, "expected WebSocket");
      }
      return w.handle(req, rest, { user: person });
    }

    if (!WEB_APP) return new Response("This Obtion server serves sync, API and MCP only (OBTION_WEB_APP=off).", { status: 404 });
    return serveStatic(path);
  },
  websocket: {
    maxPayloadLength: MAX_WS_MESSAGE,
    open(ws) {
      open.get(ws.data.workspace)?.conns.add(ws);
    },
    close(ws) {
      open.get(ws.data.workspace)?.conns.delete(ws);
    },
    message(ws: ServerWebSocket<Conn>, raw) {
      if (!accounts.role(ws.data.workspace, ws.data.userId)) {
        ws.close(4401, "membership ended");
        return;
      }
      const msg = parseClientMsg(String(raw));
      if (msg) open.get(ws.data.workspace)?.message(ws, msg);
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
