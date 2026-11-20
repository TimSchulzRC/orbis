// The accounts on this device and their workspaces ("spaces"). The app's own server (platform.ts)
// has one account; the desktop app can connect further servers, one account each. Each workspace is
// its own replica with its own storage; one is open in the app, the others sync alongside. Kept in
// localStorage so the app opens offline.

import type {
	AccountInfo,
	ErrorBody,
	InviteCode,
	InviteInfo,
	InviteLink,
	InviteRequest,
	LoginMethods,
	McpConnect,
	McpTokenInfo,
	Member,
	Ok,
	PasskeyInfo,
	Role,
	ServerInfo,
	SignedIn,
	User,
	VerifyFirst,
	WorkspaceInfo,
} from "@orbis/core/api";
import { type ExampleFile, exampleFiles, fileFacts, writeExamples } from "@orbis/core/examples";
import type { T } from "@orbis/core/i18n";
import { type FileMeta, SETTINGS_ID } from "@orbis/core/model";
import { firstName } from "@orbis/core/origin";
import { runSetup } from "@orbis/core/setup";
import { Repo } from "@orbis/sync";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useSyncExternalStore } from "react";
import { navigate, parseHash, spaceHref } from "./address";
import { browserHost, type SpaceLink, storageNames } from "./browser";
import { DeviceFiles, setFiles } from "./files";
import { getLang } from "./i18n";
import { moveInArray } from "./lib/utils";
import { canConnect, desktop, homeUrl } from "./platform";
import { setRepo } from "./repo";
import { globalPage } from "./scope";
import { KEYS } from "./ui/storage";

export interface Account {
	token: string;
	user: User;
	admin?: boolean;
	/** has a password to sign in with */
	password?: boolean;
	/** the server no longer accepts the token */
	lost?: boolean;
}

/** A further server's account (desktop app): its address (an origin) and the account. */
export interface Remote {
	url: string;
	account: Account;
}

/** A workspace; `server`: the further server it lies on, none for the app's own. */
export type Space = WorkspaceInfo & { server?: string };

const read = <T>(k: string, def: T): T => {
	try {
		return (JSON.parse(localStorage.getItem(k) ?? "null") as T) ?? def;
	} catch {
		return def;
	}
};

// the desktop app's own server always has its account signed in (the app made it)
let account: Account | null = desktop
	? { token: desktop.local.token, user: desktop.local.user }
	: read(KEYS.account, null);
let remotes: Remote[] = canConnect ? read(KEYS.servers, []) : [];
let spaces: Space[] = read<Space[]>(KEYS.spaces, []).filter(
	(s) => !s.server || remotes.some((r) => r.url === s.server),
);
let active: string | null = localStorage.getItem(KEYS.active);
/** Workspaces shown on this device (sidebar, inbox); null = all. */
let shown: string[] | null = read(KEYS.shown, null);
let version = 0;
const listeners = new Set<() => void>();

function save() {
	localStorage.setItem(KEYS.account, JSON.stringify(account));
	localStorage.setItem(KEYS.servers, JSON.stringify(remotes));
	localStorage.setItem(KEYS.spaces, JSON.stringify(spaces));
	if (active) localStorage.setItem(KEYS.active, active);
	else localStorage.removeItem(KEYS.active);
	localStorage.setItem(KEYS.shown, JSON.stringify(shown));
	version++;
	for (const l of listeners) l();
}

export function useAccounts() {
	useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => version,
	);
	// no choice made ("All"), as opposed to every workspace picked one by one
	const allSeen = !shown || !spaces.some((s) => shown!.includes(s.id));
	return {
		account,
		remotes,
		spaces,
		active: spaces.find((s) => s.id === active),
		shown: shownSpaces(),
		allSeen,
	};
}

/** The workspaces chosen to be seen; never none (a choice that left none shows all). */
export function shownSpaces(): Space[] {
	const list = spaces.filter((s) => !shown || shown.includes(s.id));
	return list.length ? list : spaces;
}

/**
 * Picking every workspace is stored as "all" so new ones show too – unless `picked` (one by one via
 * the chips), which stays an explicit list.
 */
export function setShown(ids: string[], picked = false) {
	shown = !picked && spaces.every((s) => ids.includes(s.id)) ? null : ids;
	save();
}

export const activeUser = () => account?.user.id;
export const activeSpace = () => spaces.find((s) => s.id === active);
export const spaceById = (id: string) => spaces.find((s) => s.id === id);

/** The workspaces on further server `url` (desktop app), in their order. */
export const spacesOn = (url: string) => spaces.filter((s) => s.server === url);

// ---------- servers ----------

/** The address of a server: a further one's own, or the app's (none). */
export const baseOf = (server?: string) => server ?? homeUrl();
export const accountOf = (server?: string): Account | null =>
	server ? (remotes.find((r) => r.url === server)?.account ?? null) : account;
/** A workspace on the desktop app's own server: on this device only, no members, no invites. */
export const isLocal = (s: Space) => !!desktop && !s.server;

/** How a server is named to the user: its host. */
export const serverName = (server?: string) => new URL(baseOf(server)).host;

/**
 * What the user typed as a server's address, as its origin: "nas:8480" → http://nas:8480,
 * "notes.example.org" → https://…; an invite link (…/#/join/<code>) also gives the code.
 */
export function parseServer(input: string): { url: string; invite?: string } | null {
	const text = input.trim();
	if (!text) return null;
	const host = text
		.replace(/^[a-z]+:\/\//i, "")
		.split(/[/?#]/)[0]!
		.replace(/:\d+$/, "");
	const plain =
		!host.includes(".") ||
		/^[\d.]+$/.test(host) ||
		host.startsWith("[") ||
		/\.(local|lan|home\.arpa|internal)$/.test(host);
	try {
		const url = new URL(
			/^[a-z]+:\/\//i.test(text) ? text : `${plain ? "http" : "https"}://${text}`,
		);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return { url: url.origin, invite: /^#\/join\/([\w-]+)/.exec(url.hash)?.[1] };
	} catch {
		return null;
	}
}

// ---------- replicas ----------

const open = new Map<string, { repo: Repo; files: DeviceFiles }>();

function link(s: Space): SpaceLink {
	// the token as it is now: a new sign-in (also to confirm it is them) reaches replicas already open
	const acc = accountOf(s.server)!;
	return {
		base: `${baseOf(s.server)}/w/${s.id}`,
		get token() {
			return accountOf(s.server)?.token ?? acc.token;
		},
		person: { id: acc.user.id, name: firstName(acc.user) },
		storage: storageNames(s),
	};
}

export function replica(id: string): { repo: Repo; files: DeviceFiles } {
	let entry = open.get(id);
	if (!entry) {
		const spaceLink = link(spaces.find((s) => s.id === id)!);
		const repo = new Repo(browserHost(spaceLink));
		entry = { repo, files: new DeviceFiles(repo, spaceLink) };
		open.set(id, entry);
		setUpWhenEmpty(id, entry);
		repo.init().catch((e) => console.error("could not open local storage", e));
	}
	return entry;
}

/** Workspaces created on this device and not set up yet; value: with examples. */
const created = new Map<string, boolean>();

/**
 * One created here is set up as soon as its storage is open; any other (made by the server or an
 * agent) only once it is in sync and still has no settings, so it isn't set up twice.
 */
function setUpWhenEmpty(id: string, { repo, files }: { repo: Repo; files: DeviceFiles }) {
	const off = repo.subscribe(() => {
		if (repo.get(SETTINGS_ID)) return void off();
		const examples = created.get(id);
		if (!repo.status.loaded || (examples === undefined && !repo.status.synced)) return;
		off();
		created.delete(id);
		void setUp(repo, files, examples ?? false);
	});
}

async function setUp(repo: Repo, files: DeviceFiles, examples: boolean) {
	const lang = getLang();
	// the files first (stored here, uploaded later), then everything in one go
	const metas: Partial<Record<ExampleFile["key"], FileMeta>> = {};
	if (examples)
		for (const f of exampleFiles(lang)) {
			const meta = await files.prepare(new Blob([f.bytes], { type: f.mime }), f.name);
			metas[f.key] = { ...fileFacts(f, meta.hash), ...meta };
		}
	// set up meanwhile by another device: the examples chosen here still come (they skip what is there)
	if (!repo.get(SETTINGS_ID)) runSetup(repo.writer, lang, repo.origin);
	if (examples) writeExamples(repo.writer, lang, metas);
}

/** Pending local changes while the server is reachable, in any open workspace. */
export function unsynced(): boolean {
	return [...open.values()].some(({ repo }) => repo.status.pending > 0 && repo.status.online);
}

function activate(id: string) {
	if (!spaces.some((s) => s.id === id)) return;
	const { repo, files } = replica(id);
	setRepo(repo);
	setFiles(files);
	if (active !== id) {
		active = id;
		save();
	}
}

export class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
	}
}

/** A call of a server's API (the app's own without `server`); `token: null` calls without one. */
async function call<R>(
	path: string,
	o: { body?: unknown; method?: string; server?: string; token?: string | null } = {},
): Promise<R> {
	const token = o.token === undefined ? accountOf(o.server)?.token : o.token;
	const res = await fetch(baseOf(o.server) + path, {
		method: o.method ?? (o.body === undefined ? "GET" : "POST"),
		headers: {
			...(o.body !== undefined ? { "content-type": "application/json" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: o.body === undefined ? undefined : JSON.stringify(o.body),
	});
	const data: unknown = await res.json().catch(() => ({}));
	if (!res.ok)
		throw new ApiError((data as Partial<ErrorBody> | null)?.error ?? res.statusText, res.status);
	return data as R;
}

export const spaceCall = <R>(id: string, path: string) =>
	call<R>(`/w/${id}${path}`, { server: spaceById(id)?.server });

export function errorText(
	e: unknown,
	t: T,
	what: "signIn" | "code" | "space" | "deleteAccount" | "password",
): string {
	const status = e instanceof ApiError ? e.status : undefined;
	const message = e instanceof Error ? e.message : String(e);
	if (status === 429) return t("account.tooMany");
	switch (what) {
		case "code":
			if (status === 403) return t("account.closed");
			if (status === 400) return t("account.codeWrong");
			return status ? message : t("account.offline");
		case "signIn":
			if (status === 401) return t("account.wrong");
			if (status === 409 || status === 422) return t("account.exists");
			if (status === 403) return t("account.closed");
			// no answer at all (a further server out of reach)
			return status === undefined ? t("account.offline") : message;
		case "password":
			if (message === "invalid password") return t("account.deletePassword");
			if (message === "password too long") return t("account.passwordLong");
			return status === 400 ? t("account.passwordShort") : t("account.offline");
		case "deleteAccount":
			if (message === "last owner") return t("account.deleteOwner");
			if (message === "invalid password") return t("account.deletePassword");
			return t("account.offline");
		case "space":
			return message === "last owner" ? t("space.lastOwner") : message;
	}
}

/** Ask one server for its account's workspaces; also marks the account `lost` when the server rejects the token. Returns the ones gone there. */
async function refreshServer(server?: string): Promise<Space[]> {
	const acc = accountOf(server);
	if (!acc) return [];
	let me: AccountInfo;
	try {
		me = await call<AccountInfo>("/api/account", { server });
	} catch (e) {
		if (!(e instanceof ApiError && e.status === 401)) return []; // offline: keep what is known
		// the desktop app's own server: the app signs in again by itself
		if (server || !desktop) {
			acc.lost = true;
			return [];
		}
		Object.assign(acc, await desktop.renewLocal());
		me = await call<AccountInfo>("/api/account");
	}
	Object.assign(acc, { user: me.user, admin: me.admin, password: me.password, lost: false });
	const mine = spaces.filter((s) => s.server === server);
	const known = new Map(mine.map((s) => [s.id, s]));
	const fresh: Space[] = me.workspaces.map((w) => ({
		...known.get(w.id),
		...w,
		...(server ? { server } : {}),
	}));
	// the app's own server first, then the others in the order they were added
	spaces = [undefined, ...remotes.map((r) => r.url)].flatMap((srv) =>
		srv === server ? fresh : spaces.filter((s) => s.server === srv),
	);
	// gone on the server (deleted, or this account removed): the copy here goes too
	return mine.filter((s) => !me.workspaces.some((w) => w.id === s.id));
}

/** Ask every server for its account's workspaces. */
export async function refresh() {
	const gone = (
		await Promise.all(
			[undefined, ...remotes.map((r) => r.url)].map((srv) => refreshServer(srv).catch(() => [])),
		)
	).flat();
	if (!activeSpace() && spaces[0]) activate(spaces[0].id);
	save();
	// last: deleting makes open replicas reload the page
	for (const s of gone) await forget(s);
}

/**
 * A different account signed in before is forgotten first; the same one signing in again (to
 * confirm it is them) keeps its workspaces and ends the old session.
 */
async function keep(token: string) {
	const me = await call<AccountInfo>("/api/account", { token });
	if (account && account.user.id !== me.user.id) await forgetAll();
	else if (account && account.token !== token && !account.lost)
		await call<Ok>("/api/account/signout", { body: {} }).catch(() => {
			// the old session ends on its own if the server cannot be reached
		});
	account = { token, user: me.user };
	await refresh();
}

/** Before the server answered: password only. */
export const loginOf = (info: ServerInfo | null): LoginMethods =>
	info?.login ?? { password: true, emailCode: false, passkey: false, oauth: [] };

/** The server reads this cookie when a code or OAuth sign-in creates the user. */
function signupContext(invite: string | undefined, lang: string) {
	// biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API needs a secure context, which a self-hosted server on plain http lacks
	document.cookie = `orbis_signup=${encodeURIComponent(JSON.stringify({ invite, lang }))}; path=/api/auth; max-age=1800; samesite=lax`;
}

/** Sign in with a password (on `server`: a further one, desktop app; `invite`: join it there too). */
export async function signIn(email: string, password: string, server?: string, invite?: string) {
	const res = await call<SignedIn>("/api/auth/sign-in/email", {
		body: { email, password },
		server,
		token: null,
	});
	await (server ? adopt(server, res, invite) : keep(res.token));
}

/**
 * On `server`: a further one (desktop app). Where email codes are on, the address is verified
 * first: without `code` a code is sent and the result is "verify"; then call again with the code.
 */
export async function signUp(
	b: {
		name: string;
		email: string;
		password: string;
		invite?: string;
		lang: string;
		code?: string;
	},
	server?: string,
): Promise<"verify" | undefined> {
	const res = await call<SignedIn | VerifyFirst>("/api/account/signup", {
		body: b,
		server,
		token: null,
	});
	if ("verify" in res) {
		await sendCode(b.email, { invite: b.invite, lang: b.lang }, server);
		return "verify";
	}
	await (server ? adopt(server, res) : keep(res.token));
}

/** An address without an account gets a code too where sign-up is open. */
export async function sendCode(
	email: string,
	ctx: { invite?: string; lang: string },
	server?: string,
) {
	signupContext(ctx.invite, ctx.lang);
	await call<Ok>("/api/auth/email-otp/send-verification-otp", {
		body: { email, type: "sign-in" },
		server,
		token: null,
	});
}

/** A new address becomes an account named `name`. */
export async function signInWithCode(
	email: string,
	otp: string,
	name: string | undefined,
	ctx: { invite?: string; lang: string },
	server?: string,
) {
	signupContext(ctx.invite, ctx.lang);
	const res = await call<SignedIn>("/api/auth/sign-in/email-otp", {
		body: { email, otp: otp.trim(), ...(name?.trim() ? { name: name.trim() } : {}) },
		server,
		token: null,
	});
	await (server ? adopt(server, res, ctx.invite) : keep(res.token));
}

/**
 * Connect a further server (desktop app) with an account signed in there: its workspaces show
 * here too. An invite (from a pasted link) is joined.
 */
async function adopt(url: string, res: SignedIn, invite?: string) {
	if (url === homeUrl()) throw new ApiError("this is the app's own server", 400);
	const known = remotes.find((r) => r.url === url);
	// another account of the same server: the workspaces of the one before leave this device (and the page starts anew below)
	const switched = !!known && known.account.user.id !== res.user.id;
	if (switched) await forgetServer(url);
	const acc: Account = { token: res.token, user: res.user };
	if (remotes.some((r) => r.url === url))
		remotes = remotes.map((r) => (r.url === url ? { url, account: acc } : r));
	else remotes = [...remotes, { url, account: acc }];
	save();
	if (invite)
		await call(`/api/invites/${invite}`, { server: url, body: {} }).catch(() => {
			// an invite that no longer counts: signed in all the same
		});
	await refresh();
	if (switched) {
		location.replace("#/");
		location.reload();
	}
}

/** Sign out of a further server: its workspaces leave this device, with their local copies. */
export async function disconnectServer(url: string) {
	await call<Ok>("/api/account/signout", { server: url, body: {} }).catch(() => {
		// signing out offline still forgets everything on this device
	});
	await forgetServer(url);
	navigate("/", { replace: true });
	location.reload();
}

async function forgetServer(url: string) {
	const previous = spaces.filter((s) => s.server === url);
	remotes = remotes.filter((r) => r.url !== url);
	spaces = spaces.filter((s) => s.server !== url);
	if (active && !spaces.some((s) => s.id === active)) active = spaces[0]?.id ?? null;
	save();
	// the open copies step aside without reloading the page (browser.ts) until all are gone
	localStorage.setItem(KEYS.leaving, url);
	try {
		for (const s of previous) await forget(s);
	} finally {
		localStorage.removeItem(KEYS.leaving);
	}
}

/**
 * Whether `url` answers at all, even where it does not let this app in (no CORS for it: an older
 * server, or the app's origin not in its ORBIS_APP_ORIGINS).
 */
export function answers(url: string): Promise<boolean> {
	return fetch(`${url}/api/info`, { mode: "no-cors" }).then(
		() => true,
		() => false,
	);
}

export async function signInWithPasskey() {
	const optionsJSON = await call<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
		"/api/auth/passkey/generate-authenticate-options",
	);
	const response = await startAuthentication({ optionsJSON });
	const res = await call<{ session: { token: string } }>(
		"/api/auth/passkey/verify-authentication",
		{ body: { response } },
	);
	await keep(res.session.token);
}

const OAUTH_RETURN = "orbis.oauthReturn";

/** Leaves the page; the provider returns to "/?signin=oauth", where finishOAuth takes over. */
export async function signInWithOAuth(provider: string, ctx: { invite?: string; lang: string }) {
	signupContext(ctx.invite, ctx.lang);
	sessionStorage.setItem(OAUTH_RETURN, location.hash);
	const urls = { callbackURL: "/?signin=oauth", errorCallbackURL: "/?signin=failed" };
	const res = await call<{ url: string }>("/api/auth/sign-in/social", {
		body: { provider, ...urls },
	});
	location.href = res.url;
}

/**
 * Why the last OAuth sign-in failed. "closed": no account and sign-up is closed; "notLinked": an
 * account has the address but hasn't linked this provider.
 */
export let oauthFailed: "closed" | "notLinked" | "failed" | undefined;
/** "taken": that provider account belongs to another account here. */
export let linkFailed: "taken" | "failed" | undefined;

/** The session the provider left in a cookie becomes this app's token. */
async function finishOAuth() {
	const params = new URLSearchParams(location.search);
	const how = params.get("signin");
	if (!how) return;
	const back = sessionStorage.getItem(OAUTH_RETURN) ?? location.hash;
	sessionStorage.removeItem(OAUTH_RETURN);
	history.replaceState(history.state, "", location.pathname + back);
	// biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API needs a secure context, which a self-hosted server on plain http lacks
	document.cookie = "orbis_signup=; path=/api/auth; max-age=0";
	if (how === "linked") return;
	const error = params.get("error") ?? "";
	if (how === "linkFailed") {
		linkFailed = error === "account_already_linked_to_different_user" ? "taken" : "failed";
		return;
	}
	if (how !== "oauth") {
		oauthFailed = oauthFailure(error);
		return;
	}
	try {
		const res = await call<SignedIn>("/api/account/claim", { body: {} });
		await keep(res.token);
	} catch {
		oauthFailed = "failed";
		save();
	}
}

function oauthFailure(error: string): NonNullable<typeof oauthFailed> {
	if (/^(signup_closed|invite_invalid)$/.test(error)) return "closed";
	if (error === "account_not_linked") return "notLinked";
	return "failed";
}

export const linkedProviders = () =>
	call<{ providerId: string }[]>("/api/auth/list-accounts").then((l) => l.map((a) => a.providerId));

export async function linkOAuth(provider: string) {
	// the settings are a dialog: "#/settings" opens them again
	sessionStorage.setItem(OAUTH_RETURN, "#/settings");
	const res = await call<{ url: string }>("/api/auth/link-social", {
		body: { provider, callbackURL: "/?signin=linked", errorCallbackURL: "/?signin=linkFailed" },
	});
	location.href = res.url;
}

export const passkeys = () => call<PasskeyInfo[]>("/api/auth/passkey/list-user-passkeys");

/** Needs a recent sign-in (403: confirm first). */
export async function addPasskey() {
	const optionsJSON = await call<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
		"/api/auth/passkey/generate-register-options",
	);
	const response = await startRegistration({ optionsJSON });
	await call<Ok>("/api/auth/passkey/verify-registration", {
		body: { response, name: deviceLabel() },
	});
}

export const removePasskey = (id: string) =>
	call<Ok>("/api/auth/passkey/delete-passkey", { body: { id } });

/** First match wins: an iPad's agent also says "Mac", Chrome's also says "Safari". */
const OS_NAMES: [RegExp, string][] = [
	[/iPhone|iPad/, "iOS"],
	[/Android/, "Android"],
	[/Mac/, "macOS"],
	[/Windows/, "Windows"],
	[/Linux/, "Linux"],
];
const BROWSER_NAMES: [RegExp, string][] = [
	[/Edg\//, "Edge"],
	[/Firefox\//, "Firefox"],
	[/Chrome\//, "Chrome"],
	[/Safari\//, "Safari"],
];

const nameIn = (ua: string, names: [RegExp, string][]) =>
	names.find(([pattern]) => pattern.test(ua))?.[1] ?? "";

function deviceLabel(): string {
	const ua = navigator.userAgent;
	return [nameIn(ua, BROWSER_NAMES), nameIn(ua, OS_NAMES)].filter(Boolean).join(" · ") || "Passkey";
}

export async function signOut() {
	await call<Ok>("/api/account/signout", { body: {} }).catch(() => {
		// signing out offline still forgets everything on this device
	});
	await forgetAll();
	save();
	restart();
}

/** Back to the start page, loaded afresh. */
function restart() {
	navigate("/", { replace: true });
	location.reload();
}

/** The server signs out the other devices; this one stays signed in. */
export async function changePassword(current: string, next: string, server?: string) {
	await call<Ok>("/api/account/password", { body: { current, next }, server });
}

/** Proof is the password, or without one a recent sign-in (403: confirm first). */
export async function deleteAccount(password?: string, server?: string) {
	await call<Ok>("/api/account", {
		body: password === undefined ? {} : { password },
		method: "DELETE",
		server,
	});
	if (server) await forgetServer(server);
	else await forgetAll();
	save();
	restart();
}

async function forgetAll() {
	const previous = spaces;
	account = null;
	remotes = [];
	spaces = [];
	active = null;
	shown = null;
	// Persist the signed-out state before IndexedDB deletion can reload another open replica.
	save();
	for (const s of previous) await forget(s);
}

async function forget(s: Space) {
	const names = storageNames(s);
	open.delete(s.id);
	await Promise.all(
		[names.replica, names.files].map(
			(db) =>
				new Promise<void>((resolve, reject) => {
					const request = indexedDB.deleteDatabase(db);
					request.onsuccess = () => resolve();
					request.onerror = () => reject(request.error);
				}),
		),
	);
	const root = await navigator.storage?.getDirectory?.().catch(() => undefined);
	await root?.removeEntry(names.blobs, { recursive: true }).catch(() => {
		// no stored files to remove
	});
}

/** With the examples or without; then opens it. */
export async function createSpace(name: string, examples: boolean, server?: string) {
	const w = await call<WorkspaceInfo>("/api/workspaces", { body: { name }, server });
	created.set(w.id, examples);
	if (shown) shown = [...shown, w.id];
	await refresh();
	navigate("/", { space: w.id });
}

/**
 * Put workspace `id` before (or after) `to` in the account's order of workspaces. Shown at once;
 * the server keeps it for every device. Offline or refused: back to the order before, and the error.
 * Only within one server: each account keeps its own order, and the servers stay in their order.
 */
export async function moveSpace(id: string, to: string, before: boolean) {
	const from = spaces.findIndex((s) => s.id === id);
	const at = spaces.findIndex((s) => s.id === to);
	if (from < 0 || at < 0 || id === to) return;
	const server = spaces[from]!.server;
	if (spaces[at]!.server !== server) return;
	const previous = spaces;
	spaces = moveInArray(spaces, from, at + (before ? 0 : 1));
	save();
	try {
		await call<Ok>("/api/account/workspaces", {
			body: { order: spaces.filter((s) => s.server === server).map((s) => s.id) },
			method: "PUT",
			server,
		});
	} catch (e) {
		spaces = previous;
		save();
		throw e;
	}
}

export async function renameSpace(s: Space, name: string) {
	await call<Ok>(`/api/workspaces/${s.id}`, { body: { name }, method: "PATCH", server: s.server });
	await refresh();
}

export const joinUrl = (code: string, server?: string) =>
	`${server ?? location.origin}/#/join/${code}`;

/** Owners only; a link is for one person. */
export async function inviteLink(s: Space, opts: InviteRequest = {}): Promise<string> {
	const { code } = await call<InviteCode>(`/api/workspaces/${s.id}/invites`, {
		body: opts,
		server: s.server,
	});
	return joinUrl(code, s.server);
}

/** Owners only; only links that still work. */
export const inviteLinks = (s: Space) =>
	call<InviteLink[]>(`/api/workspaces/${s.id}/invites`, { server: s.server });

export const revokeInvite = (s: Space, code: string) =>
	call<Ok>(`/api/workspaces/${s.id}/invites/${code}`, { method: "DELETE", server: s.server });

export function members(s: Space): Promise<Member[]> {
	return call(`/api/workspaces/${s.id}/members`, { server: s.server });
}

/** Owners only. */
export const setRole = (s: Space, user: string, role: Role) =>
	call<Ok>(`/api/workspaces/${s.id}/members/${user}`, {
		body: { role },
		method: "PATCH",
		server: s.server,
	});

/** Owners only; their devices stop syncing it. */
export const removeMember = (s: Space, user: string) =>
	call<Ok>(`/api/workspaces/${s.id}/members/${user}`, { method: "DELETE", server: s.server });

export async function leaveSpace(s: Space) {
	await call<Ok>(`/api/workspaces/${s.id}/members/${accountOf(s.server)!.user.id}`, {
		method: "DELETE",
		server: s.server,
	});
	await forget(s);
	dropFromList(s);
	save();
	restart();
}

/** Owners only; deletes it for every member. */
export async function deleteSpace(s: Space) {
	await call<Ok>(`/api/workspaces/${s.id}`, { method: "DELETE", server: s.server });
	dropFromList(s);
	save();
	await forget(s);
	restart();
}

/** If it was the open one, the first remaining workspace opens instead. */
function dropFromList(s: Space) {
	spaces = spaces.filter((other) => other.id !== s.id);
	if (active === s.id) active = spaces[0]?.id ?? null;
}

export async function joinInvite(code: string) {
	const w = await call<WorkspaceInfo>(`/api/invites/${code}`, { body: {} });
	await refresh();
	activate(w.id);
}

export const invite = (code: string) => call<InviteInfo>(`/api/invites/${code}`);
export const serverInfo = (server?: string) =>
	call<ServerInfo>("/api/info", { server, token: null });

export const mcpToken = (s: Space) =>
	call<McpConnect>(`/api/workspaces/${s.id}/mcp-token`, { body: {}, server: s.server });
export const mcpTokenInfo = (s: Space) =>
	call<McpTokenInfo>(`/api/workspaces/${s.id}/mcp-token`, { server: s.server });
export const revokeMcpToken = (s: Space) =>
	call<Ok>(`/api/workspaces/${s.id}/mcp-token`, { method: "DELETE", server: s.server });

/**
 * A workspace page without "#/w/<id>" (a link inside the app) gets the open workspace's id, so going
 * back later returns to it. Global pages (inbox, search, settings) stay without one.
 */
function followHash() {
	const { space: named, rest } = parseHash();
	if (named) {
		if (named !== active && spaces.some((s) => s.id === named)) activate(named);
		return;
	}
	const parts = (rest.split("?")[0] ?? "").split("/").filter(Boolean);
	if (active && !globalPage(parts))
		history.replaceState(history.state, "", spaceHref(active, rest));
}
addEventListener("hashchange", followHash);

await finishOAuth();

// only the active workspace opens now; the others open when first shown
if (activeSpace()) activate(active!);
else if (spaces[0]) activate(spaces[0].id);
followHash();
