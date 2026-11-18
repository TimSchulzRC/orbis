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
export const currentSession = () => session;

/** Names this device in the origin of its changes ("iPhone-x3f9"), never shown. */
function deviceName(): string {
	const known = Storage.getItemSync(DEVICE);
	if (known) return known;
	const name = `iPhone-${Math.random().toString(36).slice(2, 6)}`;
	Storage.setItemSync(DEVICE, name);
	return name;
}

// ---- replicas -------------------------------------------------------------------------------

interface Open {
	repo: Repo;
	/** Stops syncing and closes the database. */
	dispose: () => Promise<void>;
}
const open = new Map<string, Open>();

/** A socket that never opens: a disposed replica's reconnect attempts end there. */
const inert: SyncSocket = {
	readyState: 0,
	send() {
		// never sent
	},
	close() {
		// never opened
	},
	onopen: null,
	onmessage: null,
	onclose: null,
	onerror: null,
};

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

function host(space: string, onReload: () => void): RepoHost & { dispose(): Promise<void> } {
	let disposed = false;
	const storage = sqliteStorage(space);
	let socket: WebSocket | null = null;
	const wakers: (() => void)[] = [];
	const sub = AppState.addEventListener("change", (state) => {
		if (state === "active") for (const fn of wakers) fn();
	});
	const s = session!;
	return {
		storage,
		device: deviceName(),
		person: { id: s.user.id, name: firstName(s.user) },
		connect() {
			if (disposed || !token || session?.lost) return inert;
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
		async dispose() {
			disposed = true;
			sub.remove();
			socket?.close();
			await storage.close();
		},
	};
}

/** The workspace's replica, opened (and syncing) on first use. */
export function replica(space: string): Repo {
	const known = open.get(space);
	if (known) return known.repo;
	const h = host(space, () => {
		// the storage was emptied (another server): start afresh
		void forgetReplica(space).then(() => {
			version++;
			for (const l of listeners) l();
		});
	});
	const repo = new Repo(h);
	open.set(space, { repo, dispose: h.dispose });
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

function forgetReplica(space: string): Promise<void> {
	const o = open.get(space);
	open.delete(space);
	return o?.dispose() ?? Promise.resolve();
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

/** Another account (or server) signed in before is forgotten first; the same one keeps its copies. */
async function keep(server: string, next: string) {
	const me = await call<AccountInfo>(server, "/api/account", { token: next });
	const same = session && session.server === server && session.user.id === me.user.id;
	if (session && !same) await forgetAll();
	else if (session && token && token !== next && !session.lost)
		await call<Ok>(server, "/api/account/signout", { body: {}, token }).catch(() => {
			// the old session ends on its own
		});
	await Promise.all([...open.keys()].map(forgetReplica)); // their hosts hold the old person and socket
	token = next;
	SecureStore.setItem(TOKEN, next);
	const active =
		session?.active && me.workspaces.some((w) => w.id === session!.active)
			? session.active
			: (me.workspaces[0]?.id ?? null);
	session = { server, user: me.user, spaces: me.workspaces, active, lost: false };
	save();
}

/** The account's workspaces and name from the server; marks the session lost when it refuses the token. */
export async function refresh() {
	if (!session || !token) return;
	let gone: WorkspaceInfo[] = [];
	try {
		const me = await call<AccountInfo>(session.server, "/api/account", { token });
		gone = session.spaces.filter((s) => !me.workspaces.some((w) => w.id === s.id));
		session = {
			...session,
			user: me.user,
			spaces: me.workspaces,
			lost: false,
			active:
				session.active && me.workspaces.some((w) => w.id === session!.active)
					? session.active
					: (me.workspaces[0]?.id ?? null),
		};
	} catch (e) {
		if (statusOf(e) !== 401) return; // offline: keep what is known
		session = { ...session, lost: true };
		await Promise.all([...open.keys()].map(forgetReplica));
	}
	for (const s of gone) {
		await forgetReplica(s.id);
		await removeReplica(s.id);
	}
	save();
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
	const spaces = session?.spaces ?? [];
	session = null;
	token = null;
	await SecureStore.deleteItemAsync(TOKEN);
	await Promise.all([...open.keys()].map(forgetReplica));
	for (const s of spaces) await removeReplica(s.id);
}

export const errorStatus = statusOf;
