// A workspace in a folder on the device, shared by every app that opens it (the web app in a
// Chromium browser, later the desktop app) and by whatever syncs the folder (Nextcloud, iCloud).
//
//   obtion.json        { folder: 1, id, name, server? }  – what the folder holds
//   updates/*.obu      Yjs updates, each file a batch: [doc id length][doc id][update length][update]…
//   files/<sha-256>    file contents (written by the platform's file store)
//
// Nothing is ever changed in place, so several writers need no lock: each writes new files under
// names of its own, and Yjs merges whatever it reads in any order. Compacting writes one file with
// everything read and only then removes the files it read; two writers compacting at once leave two
// overlapping files, which is harmless and merged at the next compaction.
//
// What belongs to one app instance only – the outbox to a server, the position there – is not in
// the folder: `sync` (the platform's own storage) keeps it.
import * as Y from "yjs";
import type { ReplicaStorage, StoredRow } from "./repo";

/** The folder format; a newer one is refused (see FolderInfo). */
export const FOLDER_FORMAT = 1;

export interface FolderInfo {
  folder: number;
  id: string;
  name: string;
  /** The workspace on a server this folder syncs with (address and workspace id). */
  server?: { url: string; workspace: string };
}

/** The folder as the platform gives it: paths with "/" below it. */
export interface Dir {
  /** Names of the files in a subfolder; none if it does not exist. */
  list(sub: string): Promise<string[]>;
  read(path: string): Promise<Uint8Array | undefined>;
  /** Write a whole file; a reader sees the old or the new content, never a part. */
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

const UPDATES = "updates";
const EXT = ".obu";
/** Files read at opening beyond which they are merged into one. */
const COMPACT_AT = 40;

export async function readInfo(dir: Dir): Promise<FolderInfo | undefined> {
  const raw = await dir.read("obtion.json");
  if (!raw) return undefined;
  try {
    const info = JSON.parse(utf8(raw)) as FolderInfo;
    return typeof info.id === "string" ? info : undefined;
  } catch {
    return undefined;
  }
}

export async function writeInfo(dir: Dir, info: Omit<FolderInfo, "folder">) {
  await dir.write("obtion.json", new TextEncoder().encode(JSON.stringify({ folder: FOLDER_FORMAT, ...info }, null, 2) + "\n"));
}

export function encodeRows(rows: { d: string; u: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts = rows.map((r) => ({ d: enc.encode(r.d), u: r.u }));
  const out = new Uint8Array(parts.reduce((n, p) => n + 8 + p.d.length + p.u.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.d.length);
    out.set(p.d, at + 4);
    at += 4 + p.d.length;
    view.setUint32(at, p.u.length);
    out.set(p.u, at + 4);
    at += 4 + p.u.length;
  }
  return out;
}

/** UTF-8 to text (TextDecoder is not everywhere the shared packages run). */
function utf8(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i++]!;
    const n = c < 0x80 ? 0 : c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3;
    let cp = n === 0 ? c : c & (0x3f >> n);
    for (let k = 0; k < n; k++) cp = (cp << 6) | (b[i++]! & 0x3f);
    s += String.fromCodePoint(cp);
  }
  return s;
}

export function decodeRows(data: Uint8Array): { d: string; u: Uint8Array }[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rows: { d: string; u: Uint8Array }[] = [];
  let at = 0;
  while (at + 4 <= data.length) {
    const dl = view.getUint32(at);
    const d = utf8(data.subarray(at + 4, at + 4 + dl));
    at += 4 + dl;
    const ul = view.getUint32(at);
    rows.push({ d, u: data.slice(at + 4, at + 4 + ul) });
    at += 4 + ul;
  }
  return rows;
}

const rand = () => Math.random().toString(36).slice(2, 8);

/**
 * The replica's storage in a folder. `dir` may wait (until the user allows access); `sync` keeps
 * the outbox and position for a server – its own rows are not used.
 */
export function folderStorage(dir: Promise<Dir>, sync: ReplicaStorage): ReplicaStorage & { follow(fn: (rows: StoredRow[]) => void, every?: number): () => void } {
  let d!: Dir;
  /** Files this storage has read or written: what other writers add is what is not in here. */
  const seen = new Set<string>();
  const writer = rand();
  let n = 0;

  async function readFiles(names: string[]): Promise<StoredRow[]> {
    const rows: StoredRow[] = [];
    for (const name of names) {
      seen.add(name);
      const data = await d.read(`${UPDATES}/${name}`);
      if (data) for (const r of decodeRows(data)) rows.push({ key: name, d: r.d, u: r.u });
    }
    return rows;
  }

  const listUpdates = async () => (await d.list(UPDATES)).filter((f) => f.endsWith(EXT)).sort();

  async function compact(names: string[], rows: StoredRow[]) {
    const byDoc = new Map<string, Uint8Array[]>();
    for (const r of rows) byDoc.set(r.d, [...(byDoc.get(r.d) ?? []), r.u]);
    const merged = [...byDoc].map(([doc, us]) => ({ d: doc, u: us.length === 1 ? us[0]! : Y.mergeUpdates(us) }));
    const name = `${Date.now().toString(36)}-${writer}-all${EXT}`;
    seen.add(name);
    await d.write(`${UPDATES}/${name}`, encodeRows(merged));
    for (const f of names) await d.remove(`${UPDATES}/${f}`);
  }

  return {
    async open() {
      d = await dir;
      await sync.open();
    },
    async load() {
      const names = await listUpdates();
      const rows = await readFiles(names);
      const { outbox, lastSeq, lastId } = await sync.load();
      if (names.length > COMPACT_AT) compact(names, rows).catch((e) => console.warn("folder compaction failed", e));
      return { rows, outbox, lastSeq, lastId };
    },
    // compaction happens at opening, over the whole folder (see above)
    async compact() {},
    async write(w) {
      if (w.rows?.length) {
        const name = `${Date.now().toString(36)}-${writer}-${(n++).toString(36)}${EXT}`;
        seen.add(name);
        await d.write(`${UPDATES}/${name}`, encodeRows(w.rows));
      }
      if (w.outbox?.length || w.acked?.length || w.cursor || w.serverId) await sync.write({ ...w, rows: undefined });
    },
    outbox: () => sync.outbox(),
    serverId: () => sync.serverId(),
    // the folder stays: only what this instance knows of the server goes (it downloads anew)
    destroy: () => sync.destroy(),
    /** Calls fn with what other writers added to the folder, every `every` ms. */
    follow(fn: (rows: StoredRow[]) => void, every: number = 3000) {
      let busy = false;
      const look = async () => {
        if (busy || !d) return;
        busy = true;
        try {
          const names = await listUpdates();
          const now = new Set(names);
          for (const s of seen) if (!now.has(s)) seen.delete(s);
          const fresh = names.filter((f) => !seen.has(f));
          if (fresh.length) fn(await readFiles(fresh));
        } catch (e) {
          console.warn("folder check failed", e);
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => void look(), every);
      return () => clearInterval(timer);
    },
  };
}
