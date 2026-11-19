// The replica's host in a browser (the web app, the desktop app's window): IndexedDB storage, a
// workspace on its server, other tabs over BroadcastChannel, UI dialogs.

import type { Person } from "@obtion/core/origin";
import type {
	OutItem,
	ReplicaStorage,
	RepoHost,
	StoredRow,
	SyncSocket,
	TabMsg,
} from "@obtion/sync";
import { type IDBPDatabase, openDB } from "idb";
import { tr } from "./i18n";
import { KEYS, readJSON, writeJSON } from "./ui/storage";

export interface SpaceLink {
	base: string;
	token: string;
	person: Person;
	storage: StorageNames;
}

export type StorageNames = ReturnType<typeof storageNames>;

export function storageNames(space: { id: string }) {
	const replica = `obtion-ws-${space.id}`;
	return { replica, files: `${replica}-files`, blobs: `blobs-${replica}` };
}

function idbStorage(name: string): ReplicaStorage {
	let db!: IDBPDatabase;
	return {
		async open() {
			db = await openDB(name, 1, {
				// Another tab wants to delete or upgrade the database (e.g. "re-download everything").
				blocking: () => {
					db.close();
					// Signing out (of every server, or of one: KEYS.leaving) reloads itself once all copies are removed.
					if (localStorage.getItem(KEYS.account) !== "null" && !localStorage.getItem(KEYS.leaving))
						location.reload();
				},
				upgrade(db) {
					db.createObjectStore("updates", { autoIncrement: true });
					db.createObjectStore("outbox", { keyPath: "k" });
					db.createObjectStore("meta");
				},
			});
		},
		async load() {
			const tx = db.transaction(["updates", "outbox", "meta"]);
			const [keys, values, outbox, lastSeq, lastId] = await Promise.all([
				tx.objectStore("updates").getAllKeys(),
				tx.objectStore("updates").getAll(),
				tx.objectStore("outbox").getAll(),
				tx.objectStore("meta").get("lastSeq"),
				tx.objectStore("meta").get("lastId"),
			]);
			const rows = values.map((v: StoredRow, i) => ({ ...v, key: keys[i] }));
			return {
				rows,
				outbox: outbox as OutItem[],
				lastSeq: lastSeq as number | undefined,
				lastId: lastId as string | undefined,
			};
		},
		async compact(docs) {
			const tx = db.transaction("updates", "readwrite");
			for (const { keys, row } of docs) {
				for (const k of keys) tx.store.delete(k as IDBValidKey);
				tx.store.add({ d: row.d, u: row.u, r: row.r });
			}
			await tx.done;
		},
		async write(w) {
			const tx = db.transaction(["updates", "outbox", "meta"], "readwrite");
			for (const r of w.rows ?? []) tx.objectStore("updates").add({ d: r.d, u: r.u });
			for (const o of w.outbox ?? []) tx.objectStore("outbox").put(o);
			for (const k of w.acked ?? []) tx.objectStore("outbox").delete(k);
			if (w.cursor) {
				tx.objectStore("meta").put(w.cursor.lastSeq, "lastSeq");
				if (w.cursor.lastId) tx.objectStore("meta").put(w.cursor.lastId, "lastId");
				else tx.objectStore("meta").delete("lastId");
			}
			if (w.serverId) tx.objectStore("meta").put(w.serverId, "serverId");
			await tx.done;
		},
		async outbox() {
			return (await db.getAll("outbox")) as OutItem[];
		},
		async drop(ids) {
			const gone = new Set(ids);
			const tx = db.transaction(["updates", "outbox"], "readwrite");
			for (let c = await tx.objectStore("updates").openCursor(); c; c = await c.continue())
				if (gone.has((c.value as { d: string }).d)) c.delete();
			for (let c = await tx.objectStore("outbox").openCursor(); c; c = await c.continue())
				if (gone.has((c.value as OutItem).d)) c.delete();
			await tx.done;
		},
		async serverId() {
			return (await db.get("meta", "serverId")) as string | undefined;
		},
		async destroy() {
			db.close();
			await new Promise((res) => {
				const request = indexedDB.deleteDatabase(name);
				request.onsuccess = request.onerror = request.onblocked = res;
			});
		},
	};
}

/** The token goes as a subprotocol because browsers send no headers on WebSockets. */
export function browserHost(link: SpaceLink): RepoHost {
	const bc =
		typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(link.storage.replica) : null;
	return {
		storage: idbStorage(link.storage.replica),
		device: deviceName(),
		person: link.person,
		connect() {
			return new WebSocket(`${link.base.replace(/^http/, "ws")}/sync`, [
				"obtion",
				`auth.${link.token}`,
			]) as unknown as SyncSocket;
		},
		async post(path, body) {
			const res = await fetch(link.base + path, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${link.token}` },
				body: JSON.stringify(body),
			}).catch(() => null);
			if (!res) return null;
			return { ok: res.ok, statusText: res.statusText, body: await res.json().catch(() => ({})) };
		},
		tabs: bc
			? {
					post: (msg: TabMsg) => bc.postMessage(msg),
					listen: (fn: (msg: TabMsg) => void) => (bc.onmessage = (ev) => fn(ev.data)),
				}
			: undefined,
		onWake(fn) {
			window.addEventListener("online", fn);
			document.addEventListener(
				"visibilitychange",
				() => document.visibilityState === "visible" && fn(),
			);
		},
		persist() {
			if (navigator.storage?.persist)
				navigator.storage.persist().catch(() => {
					// storage stays best-effort
				});
		},
		async askOtherServer() {
			const { chooseAction } = await import("./ui/feedback");
			return chooseAction({
				title: tr("sync.otherServer.title"),
				body: tr("sync.otherServer.body"),
				choices: [
					{ key: "upload", label: tr("sync.otherServer.upload") },
					{ key: "replace", label: tr("sync.otherServer.replace"), primary: true },
				],
			});
		},
		async confirmDiscard(count) {
			const { chooseAction } = await import("./ui/feedback");
			return (
				(await chooseAction({
					title: tr("sync.unsynced.title"),
					body: tr("sync.unsynced.body", { count }),
					choices: [{ key: "yes", label: tr("sync.unsynced.confirm"), danger: true }],
				})) === "yes"
			);
		},
		tooNew() {
			void import("./ui/feedback").then(({ notify }) => notify(tr("format.tooNew")));
		},
		reload: () => location.reload(),
	};
}

/** First match wins: an iPad's agent also says "Mac". */
const DEVICE_NAMES: [RegExp, string][] = [
	[/iPhone/, "iPhone"],
	[/iPad/, "iPad"],
	[/Android/, "Android"],
	[/Mac/, "Mac"],
	[/Windows/, "Windows"],
];

/** Names this device in the origin of its changes (for later queries, never shown). */
function deviceName(): string {
	const saved = readJSON(KEYS.device, "");
	if (saved) return saved;
	const ua = navigator.userAgent;
	const name = DEVICE_NAMES.find(([pattern]) => pattern.test(ua))?.[1] ?? "Browser";
	const full = `${name}-${Math.random().toString(36).slice(2, 6)}`;
	writeJSON(KEYS.device, full);
	return full;
}
