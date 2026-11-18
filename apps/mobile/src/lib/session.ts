// The signed-in account on one server and its workspaces. Each workspace is a replica (Repo from
// @obtion/sync) with its own SQLite database; all of them sync while the app runs. The token sits
// in the iOS keychain, the rest in a small key-value store, so the app opens offline.

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

export interface Session {
	server: string;
	user: User;
	spaces: WorkspaceInfo[];
	/** The workspace "Browse" shows and new notes go to. */
	active: string | null;
	/** The server no longer accepts the token. */
	lost?: boolean;
}

const SESSION = "obtion.session";
const TOKEN = "obtion.token";
const DEVICE = "obtion.device";

function read(): Session | null {
	try {
		return JSON.parse(Storage.getItemSync(SESSION) ?? "null") as Session | null;
	} catch {
		return null;
	}
}

let session: Session | null = read();
let token: string | null = session ? SecureStore.getItem(TOKEN) : null;
if (session && !token) session = null;
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
	/** The last write to the phone's database failed (full, closed). */
	writeFailed(): boolean;
}
interface Open {
	repo: Repo;
	host: Host;
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

function host(space: string, s: Session, onReload: () => void): Host {
	let disposed = false;
	const storage = sqliteStorage(space, closing.get(space));
	let failed = false;
	const write = storage.write;
	storage.write = (w) =>
		write(w).then(
			() => {
				failed = false;
			},
			(e: unknown) => {
				failed = true;
				throw e;
			},
		);
	let socket: WebSocket | null = null;
	let waiting: SyncSocket | null = null;
	const wakers: (() => void)[] = [];
	const sub = AppState.addEventListener("change", (state) => {
		if (state === "active") for (const fn of wakers) fn();
	});
	return {
		storage,
		device: deviceName(),
		person: { id: s.user.id, name: firstName(s.user) },
		connect() {
			if (disposed || !token || session?.lost) {
				waiting = parked();
				return waiting;
			}
			// the token as a subprotocol, as in the browser (the server reads it there or in the header)
			socket = new WebSocket(`${s.server.replace(/^http/, "ws")}/w/${space}/sync`, [
				"obtion",
				`auth.${token}`,
			]);
			return socket as unknown as SyncSocket;
		},
		async post(path, body) {
			try {
				const res = await call<unknown>(s.server, `/w/${space}${path}`, {
					body,
					token: token ?? undefined,
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
		writeFailed: () => failed,
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
	if (!session?.spaces.some((w) => w.id === space)) return undefined;
	const known = open.get(space);
	if (known) return known.repo;
	const h = host(space, session, () => {
		// the storage was emptied (another server): start afresh
		void forgetReplica(space).then(() => {
			version++;
			for (const l of listeners) l();
		});
	});
	const repo = new Repo(h);
	open.set(space, { repo, host: h });
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

/** Whether the last change in the workspace reached the phone's database. */
export const writeFailed = (space: string) => open.get(space)?.host.writeFailed() ?? false;

/** Signed in again: the replicas that waited connect with the new token. */
function resume() {
	for (const o of open.values()) {
		o.host.resume();
		// one still loading connects when it is loaded
		if (o.repo.status.loaded) o.repo.connect();
	}
}

/** Pending local changes in any workspace. */
export function pendingChanges(): number {
	return [...open.values()].reduce((n, o) => n + o.repo.status.pending, 0);
}

// ---- account --------------------------------------------------------------------------------

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

/** The workspace the account has: the active one if it still is, else the first. */
const activeOf = (active: string | null | undefined, spaces: WorkspaceInfo[]) =>
	active && spaces.some((w) => w.id === active) ? active : (spaces[0]?.id ?? null);

/**
 * Another account (or server) signed in before is forgotten first. The same one signing in again
 * keeps its copies, with what they did not send yet: they go on with the new token.
 */
async function keep(server: string, next: string) {
	const me = await call<AccountInfo>(server, "/api/account", { token: next });
	const same = !!session && session.server === server && session.user.id === me.user.id;
	if (session && !same) await forgetAll();
	else if (session && token && token !== next && !session.lost)
		await call<Ok>(server, "/api/account/signout", { body: {}, token }).catch(() => {
			// the old session ends on its own
		});
	const gone = same ? session!.spaces.filter((s) => !me.workspaces.some((w) => w.id === s.id)) : [];
	token = next;
	SecureStore.setItem(TOKEN, next);
	session = {
		server,
		user: me.user,
		spaces: me.workspaces,
		active: activeOf(session?.active, me.workspaces),
		lost: false,
	};
	save();
	for (const s of gone) await dropReplica(s.id);
	resume();
}

/**
 * The account's workspaces and name from the server; marks the session lost when it refuses the
 * token. An answer for a token or account that changed meanwhile is dropped.
 */
export async function refresh() {
	if (!session || !token) return;
	const asked = { token, server: session.server, user: session.user.id, lost: !!session.lost };
	const current = () =>
		!!session &&
		token === asked.token &&
		session.server === asked.server &&
		session.user.id === asked.user;
	let me: AccountInfo;
	try {
		me = await call<AccountInfo>(asked.server, "/api/account", { token: asked.token });
	} catch (e) {
		if (statusOf(e) !== 401 || !current()) return; // offline: keep what is known
		// the copies stay and keep what changes here; they connect again after signing in
		session = { ...session!, lost: true };
		save();
		for (const o of open.values()) o.host.suspend();
		return;
	}
	if (!current()) return;
	const gone = session!.spaces.filter((s) => !me.workspaces.some((w) => w.id === s.id));
	session = {
		...session!,
		user: me.user,
		spaces: me.workspaces,
		lost: false,
		active: activeOf(session!.active, me.workspaces),
	};
	save();
	for (const s of gone) await dropReplica(s.id);
	if (asked.lost) resume();
}

/** A new workspace on the server; this phone sets it up once it is in sync. */
export async function createWorkspace(name: string) {
	if (!session || !token) return;
	const w = await call<WorkspaceInfo>(session.server, "/api/workspaces", { body: { name }, token });
	await refresh();
	setActive(w.id);
}

export function setActive(space: string) {
	if (!session || session.active === space) return;
	session = { ...session, active: space };
	save();
}

export async function signOut() {
	if (session && token)
		await call<Ok>(session.server, "/api/account/signout", { body: {}, token }).catch(() => {
			// signing out offline still forgets everything here
		});
	await forgetAll();
	save();
}

async function forgetAll() {
	const spaces = new Set([...(session?.spaces.map((s) => s.id) ?? []), ...open.keys()]);
	session = null;
	token = null;
	await SecureStore.deleteItemAsync(TOKEN);
	await Promise.all([...spaces].map(dropReplica));
}
