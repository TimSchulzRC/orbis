// The accounts on this phone, one per server, as in the desktop app, and their workspaces. Each
// workspace is a replica (Repo from @obtion/sync) with its own SQLite database; all of them sync
// while the app runs. The tokens sit in the iOS keychain, the rest in a small key-value store, so
// the app opens offline.

import type { AccountInfo, Ok, ServerInfo, SignedIn, User, WorkspaceInfo } from "@obtion/core/api";
import { SETTINGS_ID } from "@obtion/core/model";
import { firstName } from "@obtion/core/origin";
import { runSetup } from "@obtion/core/setup";
import { Repo, type RepoHost, type SyncSocket } from "@obtion/sync";
import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { Alert, AppState } from "react-native";
import { ApiError, call, statusOf } from "./api";
import { lang, t } from "./i18n";
import { removeReplica, sqliteStorage } from "./storage";

export interface Account {
	/** The server's address, an origin ("https://notes.example.org"). */
	server: string;
	user: User;
	/** The server no longer accepts the token. */
	lost?: boolean;
}

/** A workspace and the server it lies on. */
export type Workspace = WorkspaceInfo & { server: string };

/** Signed in to at least one server; signed out of all of them there is none. */
export interface Session {
	/** In the order they were connected. */
	accounts: Account[];
	/** By server in the order of `accounts`, each server's in its account's order. */
	spaces: Workspace[];
	/** The workspace the pages show (the switcher at the top left); null: all of them. */
	shown: string | null;
}

const SESSION = "obtion.accounts";
const DEVICE = "obtion.device";
/** A keychain key allows letters, digits and "._-" only. */
const tokenKey = (server: string) => `obtion.token.${server.replace(/[^\w.-]/g, "_")}`;

/** The chosen workspace while the accounts still have it, else all. */
const shownOf = (shown: string | null, spaces: Workspace[]) =>
	shown && spaces.some((w) => w.id === shown) ? shown : null;

/** The session without the accounts `drop` picks and their workspaces; null once none is left. */
function without(s: Session, drop: (a: Account) => boolean): Session | null {
	const accounts = s.accounts.filter((a) => !drop(a));
	const spaces = s.spaces.filter((w) => accounts.some((a) => a.server === w.server));
	return accounts.length ? { accounts, spaces, shown: shownOf(s.shown, spaces) } : null;
}

function read(): Session | null {
	try {
		return JSON.parse(Storage.getItemSync(SESSION) ?? "null") as Session | null;
	} catch {
		return null;
	}
}

let session: Session | null = read();
const tokens = new Map<string, string>();
for (const a of session?.accounts ?? []) {
	const known = SecureStore.getItem(tokenKey(a.server));
	if (known) tokens.set(a.server, known);
}
// an account whose token is gone from the keychain counts as signed out of
if (session) session = without(session, (a) => !tokens.has(a.server));
let version = 0;
const listeners = new Set<() => void>();

function save() {
	if (session) Storage.setItemSync(SESSION, JSON.stringify(session));
	else Storage.removeItemSync(SESSION);
	version++;
	for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

export function useSession(): Session | null {
	useSyncExternalStore(subscribe, () => version);
	return session;
}

export const accountOf = (server: string) => session?.accounts.find((a) => a.server === server);

/** Names this device in the origin of its changes ("iPhone-x3f9"), never shown. */
function deviceName(): string {
	const known = Storage.getItemSync(DEVICE);
	if (known) return known;
	const name = `iPhone-${Math.random().toString(36).slice(2, 6)}`;
	Storage.setItemSync(DEVICE, name);
	return name;
}

// ---- replicas -------------------------------------------------------------------------------

interface Host extends RepoHost {
	/** Stops syncing for good and closes the database. */
	dispose(): Promise<void>;
	/** The server no longer takes the token: the live connection ends, the replica waits. */
	suspend(): void;
	/** Signed in again: a replica waiting for that connects now. */
	resume(): void;
	/** How many writes to the phone's database failed so far (full, closed). */
	failures(): number;
}
interface Open {
	repo: Repo;
	host: Host;
	server: string;
}
const open = new Map<string, Open>();
/** Replicas still closing: a new one of the same workspace opens its database after. */
const closing = new Map<string, Promise<void>>();

/**
 * A socket that stays "connecting": the replica waits on it while the server does not take the
 * token (until resume() closes it), or for good once the replica is disposed.
 */
function parked(): SyncSocket {
	const socket = {
		readyState: 0,
		send() {
			// never sent
		},
		close() {
			if (socket.readyState === 3) return;
			socket.readyState = 3;
			socket.onclose?.();
		},
		onopen: null,
		onmessage: null,
		onclose: null as (() => void) | null,
		onerror: null,
	};
	return socket;
}

function ask<K extends string>(
	title: string,
	body: string,
	choices: { key: K; label: string; style?: "destructive" | "cancel" }[],
): Promise<K | null> {
	return new Promise((resolve) =>
		Alert.alert(title, body, [
			{ text: t("cancel"), style: "cancel", onPress: () => resolve(null) },
			...choices.map((c) => ({ text: c.label, style: c.style, onPress: () => resolve(c.key) })),
		]),
	);
}

function host(w: Workspace, user: User, onReload: () => void): Host {
	const { id: space, server } = w;
	let disposed = false;
	const storage = sqliteStorage(space, closing.get(space));
	let failures = 0;
	const write = storage.write;
	storage.write = (w) =>
		write(w).catch((e: unknown) => {
			failures++;
			throw e;
		});
	let socket: WebSocket | null = null;
	let waiting: SyncSocket | null = null;
	const wakers: (() => void)[] = [];
	const sub = AppState.addEventListener("change", (state) => {
		if (state === "active") for (const fn of wakers) fn();
	});
	return {
		storage,
		device: deviceName(),
		person: { id: user.id, name: firstName(user) },
		connect() {
			const token = tokens.get(server);
			if (disposed || !token || accountOf(server)?.lost) {
				waiting = parked();
				return waiting;
			}
			// the token as a subprotocol, as in the browser (the server reads it there or in the header)
			socket = new WebSocket(`${server.replace(/^http/, "ws")}/w/${space}/sync`, [
				"obtion",
				`auth.${token}`,
			]);
			return socket as unknown as SyncSocket;
		},
		async post(path, body) {
			try {
				const res = await call<unknown>(server, `/w/${space}${path}`, {
					body,
					token: tokens.get(server),
				});
				return { ok: true, statusText: "OK", body: res };
			} catch (e) {
				if (e instanceof ApiError) return { ok: false, statusText: e.message, body: {} };
				return null;
			}
		},
		onWake(fn) {
			wakers.push(fn);
		},
		askOtherServer: () =>
			ask(t("sync.otherServer.title"), t("sync.otherServer.body"), [
				{ key: "upload" as const, label: t("sync.otherServer.upload") },
				{ key: "replace" as const, label: t("sync.otherServer.replace") },
			]),
		async confirmDiscard(count) {
			return (
				(await ask(t("sync.unsynced.title"), t("sync.unsynced.body", { count }), [
					{ key: "yes" as const, label: t("sync.unsynced.confirm"), style: "destructive" },
				])) === "yes"
			);
		},
		tooNew() {
			Alert.alert(t("format.tooNew"));
		},
		reload: onReload,
		suspend() {
			socket?.close();
		},
		resume() {
			const w = waiting;
			waiting = null;
			w?.close();
		},
		failures: () => failures,
		async dispose() {
			disposed = true;
			waiting = null;
			sub.remove();
			socket?.close();
			await storage.close();
		},
	};
}

/**
 * The replica of one of the account's workspaces, opened (and syncing) on first use. undefined for
 * a workspace the account no longer has (a page of it may still be on screen).
 */
export function replica(space: string): Repo | undefined {
	const w = session?.spaces.find((s) => s.id === space);
	const account = w && accountOf(w.server);
	if (!w || !account) return undefined;
	const known = open.get(space);
	if (known) return known.repo;
	const h = host(w, account.user, () => {
		// the storage was emptied (another server): start afresh
		void forgetReplica(space).then(() => {
			version++;
			for (const l of listeners) l();
		});
	});
	const repo = new Repo(h);
	open.set(space, { repo, host: h, server: w.server });
	setUpWhenEmpty(repo);
	repo.init().catch((e) => console.error("could not open the replica", e));
	return repo;
}

/**
 * A workspace without settings once it is in sync (made on the server or by an agent) is set up
 * like the web app does, so it has its types.
 */
function setUpWhenEmpty(repo: Repo) {
	const off = repo.subscribe(() => {
		if (repo.get(SETTINGS_ID)) return void off();
		if (!repo.status.loaded || !repo.status.synced) return;
		off();
		runSetup(repo.writer, lang, repo.origin);
	});
}

/** Closes a replica; a new one of the workspace waits for that (see `closing`). */
function forgetReplica(space: string): Promise<void> {
	const o = open.get(space);
	if (!o) return closing.get(space) ?? Promise.resolve();
	open.delete(space);
	const done: Promise<void> = o.host.dispose().finally(() => {
		if (closing.get(space) === done) closing.delete(space);
	});
	closing.set(space, done);
	return done;
}

/** A workspace gone on the server or from this phone: its replica and its database. */
function dropReplica(space: string): Promise<void> {
	const done: Promise<void> = forgetReplica(space)
		.then(() => removeReplica(space))
		.finally(() => {
			if (closing.get(space) === done) closing.delete(space);
		});
	// a replica opened again meanwhile waits until the file is gone
	closing.set(space, done);
	return done;
}

/**
 * Writes to the workspace's database that failed so far: compare the count before a change with the
 * count once it is saved, and a later success cannot hide a failure.
 */
export const writeFailures = (space: string) => open.get(space)?.host.failures() ?? 0;

/** Signed in to `server` again: its replicas that waited connect with the new token. */
function resume(server: string) {
	for (const o of open.values()) {
		if (o.server !== server) continue;
		o.host.resume();
		// one still loading connects when it is loaded
		if (o.repo.status.loaded) o.repo.connect();
	}
}

/** Pending local changes in the workspaces on `server`. */
export function pendingChanges(server: string): number {
	return [...open.values()]
		.filter((o) => o.server === server)
		.reduce((n, o) => n + o.repo.status.pending, 0);
}

// ---- accounts -------------------------------------------------------------------------------

export const serverInfo = (server: string) => call<ServerInfo>(server, "/api/info");

export async function signIn(server: string, email: string, password: string) {
	const res = await call<SignedIn>(server, "/api/auth/sign-in/email", {
		body: { email: email.trim(), password },
	});
	await keep(server, res.token);
}

export async function sendCode(server: string, email: string) {
	await call<Ok>(server, "/api/auth/email-otp/send-verification-otp", {
		body: { email: email.trim(), type: "sign-in" },
	});
}

export async function signInWithCode(server: string, email: string, otp: string) {
	const res = await call<SignedIn>(server, "/api/auth/sign-in/email-otp", {
		body: { email: email.trim(), otp: otp.trim() },
	});
	await keep(server, res.token);
}

/**
 * What `server` says about its account: the account and its workspaces take the place of what was
 * known of that server (a new server goes last). Returns the workspaces gone there.
 */
function update(server: string, me: AccountInfo): Workspace[] {
	const s = session ?? { accounts: [], spaces: [], shown: null };
	const before = s.spaces.filter((w) => w.server === server);
	// A workspace another server has too (a copy of its data folder) stays with the first: on this
	// phone both would share one database.
	const fresh = me.workspaces
		.filter((w) => !s.spaces.some((o) => o.id === w.id && o.server !== server))
		.map((w) => ({ ...w, server }));
	const account: Account = { server, user: me.user, lost: false };
	const accounts = s.accounts.some((a) => a.server === server)
		? s.accounts.map((a) => (a.server === server ? account : a))
		: [...s.accounts, account];
	const spaces = accounts.flatMap((a) =>
		a.server === server ? fresh : s.spaces.filter((w) => w.server === a.server),
	);
	session = { accounts, spaces, shown: shownOf(s.shown, spaces) };
	return before.filter((w) => !fresh.some((f) => f.id === w.id));
}

/**
 * Signed in to `server`: a new server joins the others. Another account signed in there before is
 * forgotten first; the same one signing in again keeps its copies, with what they did not send
 * yet: they go on with the new token.
 */
async function keep(server: string, next: string) {
	const me = await call<AccountInfo>(server, "/api/account", { token: next });
	const known = accountOf(server);
	const old = tokens.get(server);
	if (known && known.user.id !== me.user.id) await forgetServer(server);
	else if (known && old && old !== next && !known.lost)
		await call<Ok>(server, "/api/account/signout", { body: {}, token: old }).catch(() => {
			// the old session ends on its own
		});
	tokens.set(server, next);
	SecureStore.setItem(tokenKey(server), next);
	const gone = update(server, me);
	save();
	for (const w of gone) await dropReplica(w.id);
	resume(server);
}

/** Every account's workspaces and name from its server. */
export async function refresh() {
	await Promise.all((session?.accounts ?? []).map((a) => refreshServer(a.server)));
}

/**
 * The account's workspaces and name from `server`; marks the account lost when the server refuses
 * the token. An answer for a token or account that changed meanwhile is dropped.
 */
async function refreshServer(server: string) {
	const token = tokens.get(server);
	const account = accountOf(server);
	if (!token || !account) return;
	const asked = { token, user: account.user.id, lost: !!account.lost };
	const current = () =>
		tokens.get(server) === asked.token && accountOf(server)?.user.id === asked.user;
	let me: AccountInfo;
	try {
		me = await call<AccountInfo>(server, "/api/account", { token });
	} catch (e) {
		if (statusOf(e) !== 401 || !current()) return; // offline: keep what is known
		// the copies stay and keep what changes here; they connect again after signing in
		session = {
			...session!,
			accounts: session!.accounts.map((a) => (a.server === server ? { ...a, lost: true } : a)),
		};
		save();
		for (const o of open.values()) if (o.server === server) o.host.suspend();
		return;
	}
	if (!current()) return;
	const gone = update(server, me);
	save();
	for (const w of gone) await dropReplica(w.id);
	if (asked.lost) resume(server);
}

/** A new workspace on `server`; the pages show it, and this phone sets it up once it is in sync. */
export async function createWorkspace(server: string, name: string) {
	const token = tokens.get(server);
	if (!token) return;
	const w = await call<WorkspaceInfo>(server, "/api/workspaces", { body: { name }, token });
	await refreshServer(server);
	setShown(w.id);
}

/** The workspace the pages show; null for all. */
export function setShown(space: string | null) {
	if (!session || session.shown === space) return;
	session = { ...session, shown: shownOf(space, session.spaces) };
	save();
}

/** Signed out of `server`: its workspaces leave this phone. Out of the last one, the sign-in shows. */
export async function signOut(server: string) {
	const token = tokens.get(server);
	if (token)
		await call<Ok>(server, "/api/account/signout", { body: {}, token }).catch(() => {
			// signing out offline still forgets everything of that server here
		});
	await forgetServer(server);
	save();
}

/** The account of `server` and the copies of its workspaces; the caller saves. */
async function forgetServer(server: string) {
	const spaces = new Set([
		...(session?.spaces.filter((w) => w.server === server).map((w) => w.id) ?? []),
		...[...open].filter(([, o]) => o.server === server).map(([id]) => id),
	]);
	if (session) session = without(session, (a) => a.server === server);
	tokens.delete(server);
	await SecureStore.deleteItemAsync(tokenKey(server));
	await Promise.all([...spaces].map(dropReplica));
}
