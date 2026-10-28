// Workspaces in a folder on this device (see @obtion/sync/folder): the browser reaches a folder
// only through the File System Access API, i.e. in Chromium browsers on a computer. Which folder
// belongs to which workspace is kept here (folder handles in IndexedDB); access has to be allowed
// again after a restart unless the browser remembers it, and asking needs a click.
import { openDB } from "idb";
import { useSyncExternalStore } from "react";
import type { Dir } from "@obtion/sync/folder";

/**
 * Phones and tablets, by what the browser says it is – not by the width of the window.
 * iPads say they are a Mac; they are the Mac with a touch screen.
 */
export function isMobileDevice(): boolean {
  const hint = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile;
  if (hint) return true;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Can this browser keep a workspace in a folder? "browser": not in this one (a hint), "mobile": not on this device (nothing shown). */
export function folderSupport(): "yes" | "browser" | "mobile" {
  if (isMobileDevice()) return "mobile";
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function" ? "yes" : "browser";
}

type Handle = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
};

/** Let the user choose a folder (needs a click). */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: "obtion", mode: "readwrite" });
  } catch {
    return null; // closed
  }
}

// ---------- which folder a workspace is in ----------

const db = () => openDB("obtion-folders", 1, { upgrade: (d) => void d.createObjectStore("handles") });

export async function rememberFolder(id: string, handle: FileSystemDirectoryHandle) {
  await (await db()).put("handles", handle, id);
}

export async function forgetFolder(id: string) {
  await (await db()).delete("handles", id);
  waiting.delete(id);
  emit();
}

// ---------- access ----------

/** Workspaces whose folder waits for access: name of the folder and how to ask. */
const waiting = new Map<string, { folder: string; allow: () => Promise<void> }>();
let version = 0;
const listeners = new Set<() => void>();
const emit = () => (version++, listeners.forEach((l) => l()));

export function useFolderAccess() {
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => version,
  );
  return [...waiting].map(([id, w]) => ({ id, ...w }));
}

/** The folder of workspace `id` if access is allowed now, without asking. */
export async function folderNow(id: string): Promise<FileSystemDirectoryHandle | undefined> {
  const handle = (await (await db()).get("handles", id)) as Handle | undefined;
  return handle && (await handle.queryPermission({ mode: "readwrite" })) === "granted" ? handle : undefined;
}

/** The folder of workspace `id`, once access is allowed (asked for with useFolderAccess). */
export async function folderOf(id: string): Promise<FileSystemDirectoryHandle> {
  const handle = (await (await db()).get("handles", id)) as Handle | undefined;
  if (!handle) throw new Error(`no folder for workspace ${id}`);
  if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return handle;
  return new Promise((resolve) => {
    waiting.set(id, {
      folder: handle.name,
      allow: async () => {
        if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") return;
        waiting.delete(id);
        emit();
        resolve(handle);
      },
    });
    emit();
  });
}

// ---------- the folder as the replica sees it ----------

async function sub(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string } | undefined> {
  const parts = path.split("/");
  const name = parts.pop()!;
  let dir = root;
  try {
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  } catch {
    return undefined;
  }
  return { dir, name };
}

export function handleDir(root: FileSystemDirectoryHandle): Dir {
  return {
    async list(path) {
      const at = await sub(root, `${path}/x`, false);
      if (!at) return [];
      const out: string[] = [];
      for await (const [name, h] of (at.dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) if (h.kind === "file") out.push(name);
      return out;
    },
    async read(path) {
      const at = await sub(root, path, false);
      try {
        return at ? new Uint8Array(await (await (await at.dir.getFileHandle(at.name)).getFile()).arrayBuffer()) : undefined;
      } catch {
        return undefined;
      }
    },
    async write(path, data) {
      const at = (await sub(root, path, true))!;
      // a writable writes beside the file and takes its place on close: never half a file
      const w = await (await at.dir.getFileHandle(at.name, { create: true })).createWritable();
      await w.write(data as Uint8Array<ArrayBuffer>);
      await w.close();
    },
    async remove(path) {
      const at = await sub(root, path, false);
      await at?.dir.removeEntry(at.name).catch(() => {});
    },
  };
}
