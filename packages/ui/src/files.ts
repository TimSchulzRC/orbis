// File contents on this device.
//
// File documents (metadata) sync like everything else. Contents are addressed by SHA-256:
// - Previews and display versions of images are kept on every device, so embedded
//   images always show, also offline.
// - Originals: per device either "online" (loaded when opened, kept only briefly) or
//   "local" (all originals stored here, new ones fetched as soon as their document arrives).
// - Added offline: the document exists at once, the content waits in an upload outbox.
import { openDB, type IDBPDatabase } from "idb";
import { useEffect, useState, useSyncExternalStore } from "react";
import { type FileMeta, type Item, fileTypeOf, initItem, mimeOf, newId, setFileMeta } from "@obtion/core/model";
import { repo } from "./repo";

export type FileMode = "online" | "local";
const MODE_KEY = "obtion.fileMode";

interface Upload {
  hash: string;
  name: string;
  derived?: boolean;
}

// ---------- storage: OPFS when available, else IndexedDB ----------

interface BlobStore {
  has(hash: string): Promise<boolean>;
  get(hash: string): Promise<Blob | undefined>;
  put(hash: string, blob: Blob): Promise<void>;
  delete(hash: string): Promise<void>;
  list(): Promise<{ hash: string; size: number }[]>;
}

async function opfsStore(): Promise<BlobStore | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    const dir = await root.getDirectoryHandle("blobs", { create: true });
    const probe = await dir.getFileHandle(".probe", { create: true });
    if (typeof (probe as any).createWritable !== "function") return null;
    return {
      async has(h) {
        try {
          await dir.getFileHandle(h);
          return true;
        } catch {
          return false;
        }
      },
      async get(h) {
        try {
          return await (await dir.getFileHandle(h)).getFile();
        } catch {
          return undefined;
        }
      },
      async put(h, blob) {
        const fh = await dir.getFileHandle(h, { create: true });
        const w = await (fh as any).createWritable();
        await w.write(blob);
        await w.close();
      },
      async delete(h) {
        await dir.removeEntry(h).catch(() => {});
      },
      async list() {
        const out: { hash: string; size: number }[] = [];
        for await (const [name, handle] of (dir as any).entries()) {
          if (name.startsWith(".")) continue;
          out.push({ hash: name, size: (await (handle as FileSystemFileHandle).getFile()).size });
        }
        return out;
      },
    };
  } catch {
    return null;
  }
}

function idbStore(db: IDBPDatabase): BlobStore {
  return {
    has: async (h) => (await db.getKey("blobs", h)) !== undefined,
    get: (h) => db.get("blobs", h),
    put: async (h, b) => void (await db.put("blobs", b, h)),
    delete: (h) => db.delete("blobs", h),
    list: async () => {
      const out: { hash: string; size: number }[] = [];
      let c = await db.transaction("blobs").store.openCursor();
      while (c) {
        out.push({ hash: String(c.key), size: (c.value as Blob).size });
        c = await c.continue();
      }
      return out;
    },
  };
}

export async function sha256(blob: Blob): Promise<string> {
  const data = await blob.arrayBuffer();
  // crypto.subtle exists only over HTTPS (and on localhost); opened as http://<address> a
  // JavaScript implementation hashes instead, loaded only then
  const buf = crypto.subtle
    ? await crypto.subtle.digest("SHA-256", data)
    : (await import("@noble/hashes/sha2.js")).sha256(new Uint8Array(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- image versions made on the device ----------

async function scaled(file: Blob, width: number): Promise<{ blob: Blob; w: number; h: number } | undefined> {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, width / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.8));
    const out = { blob: blob!, w: bmp.width, h: bmp.height };
    bmp.close();
    return blob ? out : undefined;
  } catch {
    return undefined;
  }
}

/** First page of a PDF as a preview (rendered here, uploaded as derived version). */
async function pdfPreview(blob: Blob): Promise<{ blob: Blob; pages: number } | undefined> {
  try {
    const pdfjs = await import("pdfjs-dist");
    const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    // decoders for JBIG2/JPEG 2000 images in PDFs (copied to /pdfjs/wasm/ by the build)
    const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), wasmUrl: "/pdfjs/wasm/" });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const scale = 320 / vp.width;
    const v = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(v.width);
    canvas.height = Math.round(v.height);
    await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: v } as any).promise;
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.8));
    const pages = doc.numPages;
    await task.destroy();
    return out ? { blob: out, pages } : undefined;
  } catch (e) {
    console.warn("pdf preview failed", e);
    return undefined;
  }
}

// ---------- the device file store ----------

export interface FileStatus {
  mode: FileMode;
  originals: number; // files whose original is on this device
  total: number;
  bytes: number;
  uploading: number;
  downloading: number;
}

class DeviceFiles {
  mode: FileMode = (localStorage.getItem(MODE_KEY) as FileMode) || "online";
  status: FileStatus = { mode: this.mode, originals: 0, total: 0, bytes: 0, uploading: 0, downloading: 0 };
  private db!: IDBPDatabase;
  private store!: BlobStore;
  private ready: Promise<void>;
  private urls = new Map<string, string>();
  private loading = new Map<string, Promise<string | undefined>>();
  private local = new Set<string>();
  private missing = new Set<string>(); // not on the server (yet): shown as "Datei fehlt"

  /** Ask the server whether it has a content, without downloading it. */
  async check(hash: string): Promise<void> {
    if (this.local.has(hash) || this.missing.has(hash)) return;
    const res = await fetch(`/api/blobs/${hash}?check=1`, { headers: { "x-obtion-probe": "1" } }).catch(() => null);
    if (res?.headers.get("x-obtion-missing")) {
      this.missing.add(hash);
      this.emit();
    }
  }

  /** The server does not have this content (and this device neither). */
  isMissing(hash?: string): boolean {
    return !!hash && this.missing.has(hash) && !this.local.has(hash);
  }
  private queue: string[] = [];
  private active = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private uploading = false;

  constructor() {
    this.ready = this.open();
  }

  private async open() {
    this.db = await openDB("obtion-files", 1, {
      upgrade(db) {
        db.createObjectStore("blobs");
        db.createObjectStore("uploads", { keyPath: "hash" });
      },
    });
    this.store = (await opfsStore()) ?? idbStore(this.db);
    for (const b of await this.store.list()) this.local.add(b.hash);
    repo.subscribe(() => this.scheduleSync());
    repo.onBlob((hash) => {
      // arrived on the server: "wird hochgeladen" gives way to the file
      if (this.missing.delete(hash)) this.emit();
      this.scheduleSync(50);
    });
    this.scheduleSync(500);
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  setMode(m: FileMode) {
    this.mode = m;
    localStorage.setItem(MODE_KEY, m);
    this.scheduleSync(10);
    this.emit();
  }

  /** Object URL for a content hash: from this device, else from the server. */
  async url(hash: string, opts: { keep?: boolean } = {}): Promise<string | undefined> {
    const cached = this.urls.get(hash);
    if (cached) return cached;
    let p = this.loading.get(hash);
    if (!p) {
      p = (async () => {
        await this.ready;
        let blob = this.local.has(hash) ? await this.store.get(hash) : undefined;
        if (!blob) {
          blob = await this.fetchVerified(hash);
          if (blob && (opts.keep || this.mode === "local")) await this.save(hash, blob);
        }
        if (!blob) return undefined;
        // stored contents carry no type; images are recognised without one, SVGs are not
        if (!blob.type && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(await blob.slice(0, 256).text())) blob = new Blob([blob], { type: "image/svg+xml" });
        const u = URL.createObjectURL(blob);
        this.urls.set(hash, u);
        return u;
      })().finally(() => this.loading.delete(hash));
      this.loading.set(hash, p);
    }
    return p;
  }

  /** Direct server URL (for downloads and the PDF viewer while online). */
  serverUrl(hash: string, name?: string, download = false) {
    const q = new URLSearchParams();
    if (name) q.set("name", name);
    if (download) q.set("download", "1");
    return `/api/blobs/${hash}${q.size ? "?" + q : ""}`;
  }

  /** Object URL of the original on this device, with its type (the PDF viewer needs it); undefined if not here. */
  async localUrl(hash: string, mime: string): Promise<string | undefined> {
    await this.ready;
    if (!this.local.has(hash)) return undefined;
    const blob = await this.store.get(hash);
    return blob ? URL.createObjectURL(new Blob([blob], { type: mime || blob.type })) : undefined;
  }

  /**
   * What to say when the server lacks a file's content: a young file is most likely still being
   * uploaded by the device that added it ("wird hochgeladen"), an older one is missing.
   */
  missingKey(created: number): "file.uploading" | "file.missing" {
    return Date.now() - created < 3600_000 ? "file.uploading" : "file.missing";
  }

  hasLocal(hash: string) {
    return this.local.has(hash);
  }

  private async fetchVerified(hash: string): Promise<Blob | undefined> {
    try {
      const res = await fetch(`/api/blobs/${hash}`, { headers: { "x-obtion-probe": "1" } });
      if (res.status === 404 || res.headers.get("x-obtion-missing")) {
        this.missing.add(hash);
        this.emit();
        return undefined;
      }
      if (!res.ok) return undefined;
      const blob = await res.blob();
      if ((await sha256(blob)) !== hash) return undefined;
      return blob;
    } catch {
      return undefined;
    }
  }

  private async save(hash: string, blob: Blob) {
    await this.store.put(hash, blob);
    this.local.add(hash);
  }

  // ---------- adding files ----------

  /** Add a file: stored here at once, uploaded when the server is reachable. Returns the file item id. */
  async add(file: File | Blob, name: string, opts: { parent?: string } = {}): Promise<{ id: string; name: string }> {
    await this.ready;
    const hash = await sha256(file);
    const ix = repo.index();
    const same = ix.live.find((r) => r.file?.hash === hash);
    if (same) return { id: same.id, name: same.file!.name };
    // Pasted images are all called "image.png": keep names unique so [[links]] stay unambiguous.
    let unique = name;
    for (let n = 2; ix.live.some((r) => r.file?.name.toLowerCase() === unique.toLowerCase()); n++) unique = name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
    const meta = await this.prepare(file, unique, hash);
    const id = newId();
    repo.change(id, (doc) => {
      initItem(doc, { kind: "datei", title: unique, parents: opts.parent ? [opts.parent] : [], createdBy: `web:${repo.device}` });
      setFileMeta(doc, meta);
    });
    this.scheduleSync(10);
    return { id, name: unique };
  }

  /** Store content (and image versions) here and queue the upload; returns the file facts. */
  async prepare(file: File | Blob, name: string, hash?: string): Promise<FileMeta> {
    await this.ready;
    hash ??= await sha256(file);
    const mime = file.type || mimeOf(name);
    const meta: FileMeta = { hash, name, mime, filetype: fileTypeOf(name, mime), size: file.size };
    await this.save(hash, file);
    await this.enqueueUpload({ hash, name });
    if (meta.filetype === "bild" && !/svg/.test(mime)) {
      const display = await scaled(file, 1600);
      const thumb = await scaled(file, 320);
      if (display) {
        meta.width = display.w;
        meta.height = display.h;
        meta.display = await this.addDerived(display.blob);
      }
      if (thumb) meta.thumb = await this.addDerived(thumb.blob);
    }
    this.scheduleSync(10);
    return meta;
  }

  private async addDerived(blob: Blob): Promise<string> {
    const h = await sha256(blob);
    await this.save(h, blob);
    await this.enqueueUpload({ hash: h, name: "preview.webp", derived: true });
    return h;
  }

  private async enqueueUpload(u: Upload) {
    await this.db.put("uploads", u);
  }

  // ---------- sync loop ----------

  scheduleSync(ms = 1500) {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.sync().catch((e) => console.warn("file sync failed", e));
    }, ms);
  }

  private async sync() {
    await this.ready;
    const files = repo.live().filter((r) => r.kind === "datei" && r.file?.hash);
    if (repo.status.online) await this.uploadAll();
    const want: string[] = [];
    for (const f of files) {
      const m = f.file!;
      for (const h of [m.thumb, m.display]) if (h && !this.local.has(h)) want.push(h);
      if (this.mode === "local" && !this.local.has(m.hash)) want.push(m.hash);
    }
    if (repo.status.online) for (const h of want) if (!this.queue.includes(h) && !this.missing.has(h)) this.queue.push(h);
    this.pump();
    if (repo.status.online) this.makePdfPreviews(files).catch(() => {});
    this.updateStatus(files);
  }

  private updateStatus(files: Item[]) {
    let originals = 0;
    let bytes = 0;
    for (const f of files) if (this.local.has(f.file!.hash)) (originals++, (bytes += f.file!.size));
    this.status = { mode: this.mode, originals, total: files.length, bytes, uploading: this.status.uploading, downloading: this.queue.length + this.active };
    this.emit();
  }

  /** Up to three downloads at a time, each checked against its hash. */
  private pump() {
    while (this.active < 3 && this.queue.length) {
      const h = this.queue.shift()!;
      this.active++;
      this.fetchVerified(h)
        .then(async (blob) => {
          if (blob) await this.save(h, blob);
        })
        .finally(() => {
          this.active--;
          if (!this.queue.length && !this.active) this.updateStatus(repo.live().filter((r) => r.kind === "datei" && r.file?.hash));
          this.pump();
        });
    }
  }

  private async uploadAll() {
    if (this.uploading) return;
    this.uploading = true;
    try {
      const items = (await this.db.getAll("uploads")) as Upload[];
      this.status.uploading = items.length;
      for (const u of items) {
        const blob = await this.store.get(u.hash);
        if (!blob) {
          await this.db.delete("uploads", u.hash);
          continue;
        }
        const q = new URLSearchParams({ name: u.name });
        if (u.derived) q.set("derived", "1");
        const res = await fetch(`/api/blobs/${u.hash}?${q}`, { method: "PUT", body: blob }).catch(() => null);
        if (!res) break; // offline again
        if (res.ok || res.status === 415 || res.status === 422 || res.status === 413) {
          await this.db.delete("uploads", u.hash);
          this.status.uploading--;
          // "Online only": the original does not need to stay here once the server has it –
          // unless it is what an image shows (an SVG has no display version of its own)
          if (res.ok && !u.derived && this.mode === "online" && !shownItself().has(u.hash)) await this.drop(u.hash);
        }
      }
    } finally {
      this.uploading = false;
    }
  }

  private pdfDone = new Set<string>();
  /** PDFs without a preview: render page one here and share it as the preview. */
  private async makePdfPreviews(files: Item[]) {
    for (const f of files) {
      const m = f.file!;
      if (m.filetype !== "pdf" || m.thumb || this.pdfDone.has(f.id)) continue;
      this.pdfDone.add(f.id);
      const url = await this.url(m.hash);
      if (!url) continue;
      const prev = await pdfPreview(await (await fetch(url)).blob());
      if (!prev) continue;
      // Shared only once the server has it: a device that goes away before uploading must not
      // leave other devices pointing at a preview that never arrives.
      const thumb = await sha256(prev.blob);
      await this.save(thumb, prev.blob);
      const res = await fetch(`/api/blobs/${thumb}?name=preview.webp&derived=1`, { method: "PUT", body: prev.blob }).catch(() => null);
      if (!res?.ok) {
        this.pdfDone.delete(f.id); // try again next time
        continue;
      }
      repo.change(f.id, (doc) => setFileMeta(doc, { thumb, pages: m.pages ?? prev.pages }));
    }
  }

  /** Remove local originals (switching to online only). Previews and what images show stay. */
  async dropOriginals() {
    const keep = shownItself();
    for (const r of repo.live()) if (r.file) for (const h of [r.file.thumb, r.file.display]) if (h) keep.add(h);
    const pending = new Set(((await this.db.getAll("uploads")) as Upload[]).map((u) => u.hash));
    for (const h of [...this.local]) {
      if (keep.has(h) || pending.has(h)) continue;
      await this.drop(h);
    }
    this.scheduleSync(10);
  }

  /** Delete a content here; an object URL made from it no longer works, so it is forgotten. */
  private async drop(hash: string) {
    await this.store.delete(hash);
    this.local.delete(hash);
    this.urls.delete(hash);
  }
}

/** Originals that are shown as they are: images without a display version (SVGs). */
function shownItself(): Set<string> {
  return new Set(repo.live().flatMap((r) => (r.file?.filetype === "bild" && !r.file.display ? [r.file.hash] : [])));
}

export const files = new DeviceFiles();

export function useFileStatus() {
  useSyncExternalStore(files.subscribe, files.getVersion);
  return files.status;
}

/** Object URL for a content hash (preview, display version or original). */
export function useBlobUrl(hash?: string, keep = false): string | undefined {
  const [url, setUrl] = useState<string | undefined>();
  useSyncExternalStore(files.subscribe, files.getVersion);
  useEffect(() => {
    let alive = true;
    setUrl(undefined);
    if (hash) files.url(hash, { keep }).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [hash, files.hasLocal(hash ?? "")]);
  return url;
}
