// Workspace routes under /w/<id>/ need a member's token in the Authorization header. Besides the
// server's own page, only the apps in APP_ORIGINS (the desktop app, a web app served elsewhere) may
// call the server from a browser (CORS). ORBIS_WEB_APP=off serves no web app (headless).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type {
	AccountInfo,
	InviteCode,
	InviteInfo,
	InviteLink,
	McpConnect,
	McpTokenInfo,
	Ok,
	Role,
	ServerInfo,
	SignedIn,
	SignupPolicy,
	SignupRequest,
} from "@orbis/core/api";
import { acceptLang, LANGS, type Lang } from "@orbis/core/i18n";
import { agentOrigin, firstName, personOrigin } from "@orbis/core/origin";
import { upgradeSetup } from "@orbis/core/setup";
import type { Server, ServerWebSocket } from "bun";
import { AccountError, Accounts, FRESH_SECONDS, randomToken, SIGNUP_COOKIE } from "./accounts";
import { DATA, MAX_ATTACH, MAX_BLOB, MAX_WS_MESSAGE, PORT } from "./config";
import { body, fail, json } from "./http";
import { iconPath } from "./icons";
import { loginConfig, loginMethods } from "./login";
import { agentName } from "./mcp";
import { SETUP_ORIGIN, setUp, storeWriter } from "./setup";
import { allowedHosts } from "./trust";
import { type Conn, parseClientMsg, Workspace } from "./workspace";

const HOST = process.env.HOST ?? "127.0.0.1";
const DIST = resolve(process.env.ORBIS_WEB_DIST ?? join(import.meta.dir, "../../web/dist"));
const PUBLIC_URL = process.env.ORBIS_PUBLIC_URL ?? "";
/** Every server brings the web app; ORBIS_WEB_APP=off makes it a server for sync, API and MCP only (headless). */
const WEB_APP = !/^(off|0|false|no)$/i.test(process.env.ORBIS_WEB_APP ?? "on");
/** The first account may always sign up. */
const SIGNUP = (
	["open", "invite", "off"].includes(process.env.ORBIS_SIGNUP ?? "")
		? process.env.ORBIS_SIGNUP
		: "invite"
) as SignupPolicy;
/** Set by the Dockerfile, e.g. 0.0.2-nightly.20261030.41. */
const VERSION = process.env.ORBIS_BUILD_VERSION || "dev";
const COMMIT = (process.env.ORBIS_BUILD_COMMIT ?? "").slice(0, 7);

mkdirSync(DATA, { recursive: true });
const configPath = join(DATA, "config.json");
const config: { authSecret?: string } = existsSync(configPath)
	? JSON.parse(readFileSync(configPath, "utf8"))
	: {};
if (!config.authSecret) {
	config.authSecret = randomToken() + randomToken();
	writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

const login = (() => {
	try {
		return loginConfig(process.env, PUBLIC_URL);
	} catch (e) {
		console.error(`[orbis] ${e instanceof Error ? e.message : e}`);
		process.exit(1);
	}
})();
const accounts = new Accounts(DATA, {
	secret: config.authSecret,
	baseURL: PUBLIC_URL || `http://${HOST}:${PORT}`,
	policy: SIGNUP,
	login,
	// someone else proved the address this user signed up with
	onRevoke: (user) => closeConnsOf(user, "signed out"),
});

await accounts.init();

const open = new Map<string, Workspace>();
function workspace(id: string): Workspace | undefined {
	const known = open.get(id);
	if (known || !accounts.exists(id)) return known;
	const opened = new Workspace(accounts.dir(id));
	upgradeSetup(storeWriter(opened.store, SETUP_ORIGIN));
	open.set(id, opened);
	return opened;
}

/** `keep` spares connections, e.g. of the session that made the change. */
function closeConnsOf(userId: string, reason: string, keep?: (conn: Conn) => boolean) {
	for (const w of open.values())
		for (const ws of w.conns)
			if (ws.data.userId === userId && !keep?.(ws.data)) ws.close(4401, reason);
}

const methods = loginMethods(login);
const methodNames = [
	methods.password && "password",
	methods.emailCode && "email code",
	methods.passkey && "passkey",
	...methods.oauth.map((p) => p.id),
]
	.filter(Boolean)
	.join(", ");
console.log(
	`[orbis] ${VERSION}${COMMIT ? ` (${COMMIT})` : ""}, ${accounts.userCount()} accounts, signup ${SIGNUP}, sign-in by ${methodNames}, data in ${DATA}`,
);

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

/**
 * Apps on another origin that sign in and call the API like the server's own page: the desktop
 * app (its pages are orbis://app) and ORBIS_APP_ORIGINS, e.g. https://notes.example.org for the
 * web app served by another host. Every other site gets no CORS answer.
 */
const APP_ORIGINS = new Set([
	"orbis://app",
	...(process.env.ORBIS_APP_ORIGINS ?? "")
		.split(",")
		.map((o) => o.trim().replace(/\/$/, ""))
		// "null" is every opaque origin (sandboxed frames, file:), never an app
		.filter((o) => o && o !== "null"),
]);
const appOrigin = (req: Request) => {
	const origin = req.headers.get("origin");
	return origin && APP_ORIGINS.has(origin) ? origin : undefined;
};
/** What an app signs in with: a password or a code by email. Passkeys and OAuth stay on the own page. */
const APP_AUTH = new Set([
	"/api/auth/sign-in/email",
	"/api/auth/email-otp/send-verification-otp",
	"/api/auth/sign-in/email-otp",
]);
/** From the server's own page or one of the apps. */
const trusted = (req: Request) => sameOrigin(req) || !!appOrigin(req);

/** An answer readable by the app that asked from another origin. */
function withCors(req: Request, res: Response): Response {
	const origin = appOrigin(req);
	if (!origin) return res;
	const out = new Response(res.body, res);
	out.headers.set("access-control-allow-origin", origin);
	out.headers.set("access-control-expose-headers", "x-orbis-missing");
	out.headers.append("vary", "origin");
	return out;
}

const allowedHost = allowedHosts([
	PUBLIC_URL ? new URL(PUBLIC_URL).host : "",
	...(process.env.ORBIS_ALLOWED_HOSTS ?? "").split(","),
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
	const clean = iconPath(path.replace(/\.\.+/g, ""), VERSION);
	let file = Bun.file(join(DIST, clean === "/" ? "index.html" : clean));
	let isIndex = clean === "/";
	if (!(await file.exists())) {
		if (extname(clean)) return new Response("Not found", { status: 404 });
		file = Bun.file(join(DIST, "index.html"));
		isIndex = true;
		if (!(await file.exists()))
			return new Response("Web app not built. Run `bun run build`.", { status: 503 });
	}
	return new Response(file, { headers: { "cache-control": cacheControl(clean, isIndex) } });
}

const INVITES = "/api/invites/";
const isRole = (role: unknown): role is Role => role === "owner" || role === "member";

/** Returns null for paths it does not handle. */
async function accountApi(req: Request, path: string, url: URL): Promise<Response | null> {
	if (path === "/api/info") {
		return json<ServerInfo>({
			signup: SIGNUP,
			firstAccount: accounts.userCount() === 0,
			login: methods,
			version: VERSION,
			commit: COMMIT,
		});
	}

	// after an OAuth sign-in: the session in the cookie becomes the app's token, the cookie goes.
	// Only on the server's own page, where OAuth runs: no other origin trades a cookie.
	if (path === "/api/account/claim" && req.method === "POST") {
		if (appOrigin(req) || !sameOrigin(req)) return fail(403, "forbidden");
		const signedIn = await accounts.claim(req.headers);
		if (!signedIn) return fail(401, "unauthorized");
		const res = json<SignedIn>(signedIn);
		const ctx = await accounts.auth.$context;
		for (const c of [
			ctx.authCookies.sessionToken,
			ctx.authCookies.sessionData,
			ctx.authCookies.dontRememberToken,
		])
			res.headers.append(
				"set-cookie",
				`${c.name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${c.name.startsWith("__Secure-") ? "; Secure" : ""}`,
			);
		res.headers.append("set-cookie", `${SIGNUP_COOKIE}=; Path=/api/auth; Max-Age=0; SameSite=Lax`);
		return res;
	}

	if (path === "/api/account/signup" && req.method === "POST") {
		const b = await body<SignupRequest>(req);
		if (!login.password) return fail(403, "passwords off");
		if (!b?.email || !b.password) return fail(400, "email and password required");
		const details = {
			name: b.name ?? "",
			email: b.email,
			password: b.password,
			invite: b.invite || undefined,
		};
		return (
			login.sendCode
				? accounts.signUpWithCode({ ...details, lang: b.lang, code: b.code || undefined })
				: accounts.signUp(details)
		).then((r) => json(r), accountError);
	}

	if (path.startsWith(INVITES)) {
		const code = path.slice(INVITES.length);
		const inv = accounts.invite(code);
		if (!inv) return fail(404, "invite invalid");
		if (req.method === "GET")
			return json<InviteInfo>({
				workspace: inv.name,
				by: inv.by,
				role: inv.role,
				signup: accounts.canSignUp(code),
			});
	}

	const token = tokenOf(req);
	const session = await accounts.session(token);
	const user = session?.user;
	if (!user)
		return path.startsWith("/api/account") ||
			path.startsWith("/api/workspaces") ||
			path.startsWith(INVITES)
			? fail(401, "unauthorized")
			: null;
	try {
		if (path === "/api/account" && req.method === "GET") {
			return json<AccountInfo>({
				user,
				admin: accounts.isAdmin(user.id),
				password: await accounts.hasPassword(user.id),
				workspaces: accounts.workspacesOf(user.id),
			});
		}
		if (path === "/api/account" && req.method === "DELETE") {
			// needs the password, or a recent sign-in for accounts without one
			const password = (await body<{ password?: unknown }>(req))?.password;
			const missing =
				password === undefined ? await accounts.hasPassword(user.id) : typeof password !== "string";
			if (missing) return fail(400, "password required");
			await accounts.deleteAccount(user.id, password as string | undefined, session!.created);
			closeConnsOf(user.id, "account deleted");
			return json<Ok>({ ok: true });
		}
		if (path === "/api/account/password" && req.method === "POST") {
			const b = await body<{ current?: unknown; next?: unknown }>(req);
			if (typeof b?.current !== "string" || typeof b.next !== "string")
				return fail(400, "passwords required");
			await accounts.changePassword(user.id, token!, b.current, b.next);
			// the other sessions were revoked, so close their connections
			closeConnsOf(user.id, "password changed", (conn) => conn.session === token);
			return json<Ok>({ ok: true });
		}
		if (path === "/api/account/signout" && req.method === "POST") {
			await accounts.signOut(token!);
			return json<Ok>({ ok: true });
		}
		if (path === "/api/account/workspaces" && req.method === "PUT") {
			const b = await body<{ order?: unknown }>(req);
			if (!Array.isArray(b?.order) || !b.order.every((id) => typeof id === "string"))
				return fail(400, "order required");
			accounts.reorder(user.id, b.order as string[]);
			return json<Ok>({ ok: true });
		}
		if (path === "/api/workspaces" && req.method === "POST") {
			const b = await body<{ name?: string; setup?: unknown }>(req);
			if (!b?.name?.trim()) return fail(400, "name required");
			// setup: set it up here (the default types) for clients without the app – the app sends none and sets it up itself
			const setup = b.setup;
			if (setup !== undefined && typeof setup !== "boolean" && !LANGS.includes(setup as Lang))
				return fail(400, `setup must be true, false or one of ${LANGS.join(", ")}`);
			const info = accounts.createWorkspace(user.id, b.name);
			if (!setup) return json(info);
			const lang =
				setup === true ? acceptLang(req.headers.get("accept-language")) : (setup as Lang);
			const w = workspace(info.id)!;
			await setUp(w.store, w.blobs, lang);
			return json({ ...info, setup: lang });
		}
		if (path.startsWith(INVITES) && req.method === "POST")
			return json(accounts.join(path.slice(INVITES.length), user.id));
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
				for (const ws of open.get(id)?.conns ?? [])
					if (ws.data.userId === gone) ws.close(4401, "membership ended");
				return json<Ok>({ ok: true });
			}
			if (sub.startsWith("/members/") && req.method === "PATCH") {
				const role = (await body<{ role?: unknown }>(req))?.role;
				if (!isRole(role)) return fail(400, "role required");
				accounts.setRole(id, user.id, sub.slice("/members/".length), role);
				return json<Ok>({ ok: true });
			}
			if (sub === "/invites" && req.method === "GET")
				return json<InviteLink[]>(accounts.invites(id, user.id));
			if (sub === "/invites" && req.method === "POST") {
				const role = (await body<{ role?: unknown }>(req))?.role;
				if (role !== undefined && !isRole(role)) return fail(400, "role invalid");
				return json<InviteCode>({ code: accounts.createInvite(id, user.id, role ?? "member") });
			}
			if (sub.startsWith("/invites/") && req.method === "DELETE") {
				accounts.revokeInvite(id, user.id, sub.slice("/invites/".length));
				return json<Ok>({ ok: true });
			}
			// the token is shown only once
			if (sub === "/mcp-token" && req.method === "GET")
				return json<McpTokenInfo>({ created: accounts.mcpTokenCreated(id, user.id) });
			if (sub === "/mcp-token" && req.method === "DELETE") {
				accounts.revokeMcpToken(id, user.id);
				return json<Ok>({ ok: true });
			}
			if (sub === "/mcp-token" && req.method === "POST") {
				const base = PUBLIC_URL || `${url.protocol}//${req.headers.get("host")}`;
				const mcpUrl = `${base}/w/${id}/mcp`;
				const mcpToken = accounts.mcpToken(id, user.id);
				return json<McpConnect>({
					mcpUrl,
					token: mcpToken,
					claudeCode: `claude mcp add --transport http orbis ${mcpUrl} --header "Authorization: Bearer ${mcpToken}" -s user`,
					json: {
						mcpServers: {
							orbis: {
								type: "http",
								url: mcpUrl,
								headers: { Authorization: `Bearer ${mcpToken}` },
							},
						},
					},
					vault: join(accounts.dir(id), "vault"),
				});
			}
		}
	} catch (e) {
		return accountError(e);
	}
	return null;
}

/** Body limit of every route but the ones below. */
const SMALL_BODY = 1024 * 1024;
/** MCP: attach takes a file as base64 in the JSON. */
const MCP_BODY = Math.ceil((MAX_ATTACH * 4) / 3) + SMALL_BODY;
const FILE_ROUTE = /^\/w\/[\w-]{1,40}\/api\/(files(\/|$)|blobs\/)/;

/** Only the file routes take a file's content; they count it themselves while it streams. */
function bodyLimit(req: Request, path: string): number {
	if ((req.method === "POST" || req.method === "PUT") && FILE_ROUTE.test(path)) return MAX_BLOB;
	if (/^\/w\/[\w-]{1,40}\/mcp$/.test(path)) return MCP_BODY;
	return SMALL_BODY;
}

/**
 * 413 before anything reads a body over `max`: by Content-Length, or for a chunked body by reading
 * it up to `max` (the small routes read it whole anyway).
 */
async function capBody(req: Request, max: number): Promise<Request | Response> {
	const tooLarge = () => fail(413, `request too large (max ${Math.floor(max / 1024 / 1024)} MB)`);
	const length = req.headers.get("content-length");
	if (length !== null) return Number(length) > max ? tooLarge() : req;
	if (!req.body || max === MAX_BLOB) return req;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of req.body) {
		size += chunk.length;
		if (size > max) return tooLarge();
		chunks.push(chunk);
	}
	return new Request(req, { body: Buffer.concat(chunks) });
}

/** A request's answer; undefined once it became a WebSocket. */
async function route(incoming: Request, srv: Server<Conn>): Promise<Response | undefined> {
	const url = new URL(incoming.url);
	const path = url.pathname;
	if (!allowedHost(incoming.headers.get("host")))
		return new Response("Unknown host. Add it to ORBIS_ALLOWED_HOSTS or set ORBIS_PUBLIC_URL.", {
			status: 421,
		});

	const api = path.startsWith("/api/") || path.startsWith("/w/");
	// an app on another origin asks first whether it may (CORS preflight)
	if (
		api &&
		incoming.method === "OPTIONS" &&
		incoming.headers.get("access-control-request-method") &&
		appOrigin(incoming)
	) {
		return new Response(null, {
			status: 204,
			headers: {
				"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
				"access-control-allow-headers": "authorization, content-type, x-orbis-probe",
				"access-control-max-age": "86400",
			},
		});
	}
	let req = await capBody(incoming, bodyLimit(incoming, path));
	if (req instanceof Response) return req;

	// Better Auth: everything for the server's own page, signing in for the apps in APP_ORIGINS
	if (path.startsWith("/api/auth/")) {
		// an OAuth provider sends the browser back from its own site; Better Auth checks the state
		const callback = req.method === "GET" && path.startsWith("/api/auth/callback/");
		// an app counts as one even where its origin's host looks like this server's (orbis://app, host "app")
		const app = appOrigin(req);
		if (!callback && (app || !sameOrigin(req))) {
			if (!app || !APP_AUTH.has(path)) return fail(403, "forbidden");
			// an app signs in with what it sends: cookies the browser keeps for this server stay out
			const headers = new Headers(req.headers);
			headers.delete("cookie");
			req = new Request(req, { headers });
		}
		// accounts are created through /api/account/signup
		if (path.startsWith("/api/auth/sign-up")) return fail(404, "not found");
		if (path.startsWith("/api/auth/passkey/") && !login.passkey) return fail(404, "not found");
		// linking a provider (its address may differ) needs a recent sign-in. Ask Better Auth for the
		// session so it reads the token the same way its handler will.
		if (path === "/api/auth/link-social") {
			const s = await accounts.auth.api.getSession({ headers: req.headers }).catch(() => null);
			if (!s || Date.now() - new Date(s.session.createdAt).getTime() > FRESH_SECONDS * 1000)
				return fail(403, "sign in again");
		}
		const res = await accounts.auth.handler(req);
		if (!app) return res;
		// an app keeps the token from the body: no session cookie for this server from another origin
		const out = new Response(res.body, res);
		out.headers.delete("set-cookie");
		return out;
	}

	// CSRF: a change without a token must come from this site or an app in APP_ORIGINS
	if (api && req.method !== "GET" && !tokenOf(req) && !trusted(req)) return fail(403, "forbidden");

	if (path.startsWith("/api/")) return (await accountApi(req, path, url)) ?? fail(404, "not found");

	const m = path.match(/^\/w\/(?<id>[\w-]{1,40})(?<rest>\/.*)$/)?.groups;
	if (m) {
		const id = m.id!;
		const rest = m.rest!;
		// tokens come in the header only, never in the URL
		const token = tokenOf(req);
		const base = PUBLIC_URL || `${url.protocol}//${req.headers.get("host")}`;
		const filesUrl = `${base}/w/${id}/api/files`;
		if (rest === "/mcp") {
			const user = token && accounts.mcpUser(id, token);
			if (!user || !workspace(id)) return fail(401, "unauthorized");
			return workspace(id)!.mcp(req, { id: user.id, name: firstName(user) }, filesUrl);
		}
		// the file API (only it) also takes the workspace's MCP token: agents and scripts move files with it
		const files = rest === "/api/files" || rest.startsWith("/api/files/");
		const agent = files && token ? accounts.mcpUser(id, token) : undefined;
		if (agent) {
			const w = workspace(id);
			if (!w) return fail(404, "no such workspace");
			const person = { id: agent.id, name: firstName(agent) };
			return w.handle(req, rest, {
				user: person,
				origin: agentOrigin(agentName(req), person),
				filesUrl,
			});
		}
		const user = await accounts.userOf(token);
		if (!user) return fail(401, "unauthorized");
		if (!accounts.role(id, user.id)) return fail(403, "not a member");
		const w = workspace(id);
		if (!w) return fail(404, "no such workspace");
		const person = { id: user.id, name: firstName(user) };
		if (rest === "/sync") {
			const ok = srv.upgrade(req, {
				data: {
					workspace: id,
					areas: new Set<string>(),
					origin: personOrigin(person),
					user: person,
					userId: user.id,
					session: token,
				},
				headers: { "sec-websocket-protocol": "orbis" },
			});
			return ok ? undefined : fail(400, "expected WebSocket");
		}
		return w.handle(req, rest, { user: person, filesUrl });
	}

	if (!WEB_APP)
		return new Response("This Orbis server serves sync, API and MCP only (ORBIS_WEB_APP=off).", {
			status: 404,
		});
	return serveStatic(path);
}

const server = Bun.serve<Conn>({
	port: PORT,
	hostname: HOST,
	idleTimeout: 0,
	// a file's content may be as large as MAX_BLOB (Bun's default stops at 128 MB); bodyLimit keeps
	// every other route far below
	maxRequestBodySize: MAX_BLOB,
	async fetch(req, srv) {
		const res = await route(req, srv);
		return res && withCors(req, res);
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

console.log(
	`[orbis] listening on http://${server.hostname}:${server.port}${WEB_APP ? "" : " (no web app: ORBIS_WEB_APP=off)"}`,
);

function stop() {
	for (const w of open.values()) w.close();
	process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
