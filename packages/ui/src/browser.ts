// The replica's platform in a browser (web app, later the desktop app's window): IndexedDB as
// storage, a workspace on the server that served the page, other tabs over
// BroadcastChannel, dialogs of the UI.
import { openDB, type IDBPDatabase } from "idb";
import type { OutItem, RepoHost, ReplicaStorage, SyncSocket, TabMsg } from "@obtion/sync";
import { tr } from "./i18n";
import { KEYS, readJSON, writeJSON } from "./ui/storage";

/** Where a workspace is: its address on the server (…/w/<id>), the account's token, the name of its storage here. */
export interface SpaceLink {
  base: string;
  token: string;
  /** IndexedDB and BroadcastChannel name; "obtion" for the data from before accounts (devices keep their copy) */
  name: string;
}

/** The replica in IndexedDB: stores "updates" (per document), "outbox", "meta" (cursor, server id). */
function idbStorage(name: string): ReplicaStorage {
  let db!: IDBPDatabase;
  return {
    async open() {
      db = await openDB(name, 1, {
        // Another tab wants to delete/upgrade the database (e.g. "re-download everything"): step aside.
        blocking: () => {
          db.close();
          // Signing out already clears the account and will reload after all copies are removed.
          if (localStorage.getItem(KEYS.account) !== "null") location.reload();
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
      const rows = values.map((v: { d: string; u: Uint8Array }, i) => ({ key: keys[i], d: v.d, u: v.u }));
      return { rows, outbox: outbox as OutItem[], lastSeq: lastSeq as number | undefined, lastId: lastId as string | undefined };
    },
    async compact(docs) {
      const tx = db.transaction("updates", "readwrite");
      for (const { keys, row } of docs) {
        for (const k of keys) tx.store.delete(k as IDBValidKey);
        tx.store.add({ d: row.d, u: row.u });
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
      // key "hubId" from when the server was called hub; kept so devices still recognise it
      if (w.serverId) tx.objectStore("meta").put(w.serverId, "hubId");
      await tx.done;
    },
    async outbox() {
      return (await db.getAll("outbox")) as OutItem[];
    },
    async serverId() {
      return (await db.get("meta", "hubId")) as string | undefined;
    },
    async destroy() {
      db.close();
      await new Promise((res) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = res;
      });
    },
  };
}

/** The browser as the replica's platform for one workspace. The token goes as subprotocol: browsers send no headers on WebSockets. */
export function browserHost(link: SpaceLink): RepoHost {
  const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(link.name) : null;
  return {
    storage: idbStorage(link.name),
    device: deviceName(),
    connect() {
      return new WebSocket(`${link.base.replace(/^http/, "ws")}/sync`, ["obtion", `auth.${link.token}`]) as unknown as SyncSocket;
    },
    async post(path, body) {
      const res = await fetch(link.base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${link.token}` }, body: JSON.stringify(body) }).catch(() => null);
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
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && fn());
    },
    persist() {
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    },
    async askOtherServer() {
      const { chooseAction } = await import("./ui/feedback");
      const answer = await chooseAction({
        title: tr("sync.otherServer.title"),
        body: tr("sync.otherServer.body"),
        choices: [
          { key: "upload", label: tr("sync.otherServer.upload") },
          { key: "replace", label: tr("sync.otherServer.replace"), primary: true },
        ],
      });
      return answer;
    },
    async confirmDiscard(count) {
      const { chooseAction } = await import("./ui/feedback");
      return (await chooseAction({ title: tr("sync.unsynced.title"), body: tr("sync.unsynced.body", { count }), choices: [{ key: "yes", label: tr("sync.unsynced.confirm"), danger: true }] })) === "yes";
    },
    tooNew() {
      void import("./ui/feedback").then(({ notify }) => notify(tr("format.tooNew")));
    },
    reload: () => location.reload(),
  };
}

function deviceName(): string {
  const saved = readJSON(KEYS.device, "");
  if (saved) return saved;
  const ua = navigator.userAgent;
  const name = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser";
  const full = `${name}-${Math.random().toString(36).slice(2, 6)}`;
  setDeviceName(full);
  return full;
}

/** How this device is named in the history of changes. */
export const setDeviceName = (name: string) => writeJSON(KEYS.device, name);
