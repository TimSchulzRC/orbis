// File contents on the hub: data/blobs/<sha256>. The same content is stored once.
// For images the hub makes a preview (320 px) and a display version (1600 px WebP),
// for audio/video it reads the duration, for PDFs the page count and the text (search).
// Devices that add images offline make previews themselves; the hub only fills gaps.
import { existsSync, mkdirSync, renameSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type FileMeta, type Item, setFileMeta } from "../shared/model";
import type { Store } from "./store";

export const MAX_BLOB = 512 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const FFMPEG = Bun.which("ffmpeg");
const FFPROBE = Bun.which("ffprobe");

export function sha256(data: Uint8Array | ArrayBuffer): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

export class Blobs {
  private busy = new Set<string>();
  private queue: string[] = [];
  private running = 0;
  onStored?: (hash: string) => void;

  constructor(
    public dir: string,
    private store: Store,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  static valid(hash: string) {
    return HASH.test(hash);
  }

  path(hash: string) {
    return join(this.dir, hash);
  }

  has(hash: string) {
    return HASH.test(hash) && existsSync(this.path(hash));
  }

  size(hash: string) {
    return statSync(this.path(hash)).size;
  }

  /** Store content after checking its hash. Returns false on mismatch. */
  async put(hash: string, data: Uint8Array): Promise<boolean> {
    if (!HASH.test(hash) || sha256(data) !== hash) return false;
    if (!this.has(hash)) {
      const tmp = this.path(hash) + ".part";
      await Bun.write(tmp, data);
      renameSync(tmp, this.path(hash));
    }
    this.onStored?.(hash);
    for (const r of this.store.live()) if (r.file?.hash === hash) this.schedule(r.id);
    return true;
  }

  async putFile(srcPath: string): Promise<string> {
    const data = new Uint8Array(await Bun.file(srcPath).arrayBuffer());
    const hash = sha256(data);
    await this.put(hash, data);
    return hash;
  }

  /** Every hash still referenced by a file (incl. history and derived versions). */
  referenced(): Set<string> {
    const out = new Set<string>();
    for (const r of this.store.records.values()) {
      const f = r.file;
      if (!f) continue;
      for (const h of [f.hash, f.display, f.thumb, ...(f.history ?? []).map((x) => x.hash)]) if (h) out.add(h);
    }
    return out;
  }

  /** Remove contents no file (not even one in the trash or in a history) points to. */
  collect(): number {
    const keep = this.referenced();
    let n = 0;
    for (const name of readdirSync(this.dir)) if (HASH.test(name) && !keep.has(name)) (unlinkSync(join(this.dir, name)), n++);
    return n;
  }

  // ---------- derived data ----------

  /** Check files whose derived data is missing (startup, after sync). */
  scan() {
    for (const r of this.store.live()) if (this.needsWork(r)) this.schedule(r.id);
    // PDF previews a device announced but never uploaded: drop them, a device renders them again
    for (const r of this.store.live()) {
      const f = r.file;
      if (f?.filetype === "pdf" && f.thumb && !this.has(f.thumb)) this.store.change(r.id, "system:files", (doc) => setFileMeta(doc, { thumb: null }), { quiet: true });
    }
  }

  needsWork(r: Item): boolean {
    const f = r.file;
    if (!f?.hash || !this.has(f.hash)) return false;
    if (f.filetype === "bild") return (!f.display || !f.thumb || !f.width) && !/svg/.test(f.mime) && !!FFMPEG;
    if (f.filetype === "audio" || f.filetype === "video") return f.duration === undefined && !!FFPROBE;
    if (f.filetype === "pdf") return f.pages === undefined;
    return false;
  }

  schedule(id: string) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    this.queue.push(id);
    this.pump();
  }

  private pump() {
    while (this.running < 2 && this.queue.length) {
      const id = this.queue.shift()!;
      this.running++;
      this.process(id)
        .catch((e) => console.warn("[blobs] processing failed", id, e?.message ?? e))
        .finally(() => {
          this.running--;
          this.busy.delete(id);
          this.pump();
        });
    }
  }

  private async process(id: string) {
    const r = this.store.records.get(id);
    const f = r?.file;
    if (!f || !this.needsWork(r!)) return;
    const src = this.path(f.hash);
    const patch: Partial<FileMeta> = {};
    if (f.filetype === "bild") {
      const dim = await probe(src);
      if (dim.width) Object.assign(patch, { width: dim.width, height: dim.height });
      if (!f.display) patch.display = await this.derive(src, 1600);
      if (!f.thumb) patch.thumb = await this.derive(src, 320);
    } else if (f.filetype === "audio" || f.filetype === "video") {
      const p = await probe(src);
      patch.duration = p.duration ?? 0;
      if (f.filetype === "video") {
        if (p.width) Object.assign(patch, { width: p.width, height: p.height });
        if (!f.thumb) patch.thumb = await this.derive(src, 320, true);
      }
    } else if (f.filetype === "pdf") {
      const info = await pdfInfo(src);
      patch.pages = info.pages;
      if (info.text) patch.text = info.text;
    }
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length) this.store.change(id, "system:files", (doc) => setFileMeta(doc, clean), { quiet: true });
  }

  /** Scaled WebP version, stored as its own blob. */
  private async derive(src: string, width: number, videoFrame = false): Promise<string | undefined> {
    if (!FFMPEG) return undefined;
    const out = join(this.dir, `tmp-${crypto.randomUUID()}.webp`);
    const args = [FFMPEG, "-v", "error", "-y", ...(videoFrame ? ["-ss", "1"] : []), "-i", src, "-vf", `scale='min(${width},iw)':-1`, "-frames:v", "1", "-c:v", "libwebp", "-quality", "80", out];
    const p = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0 || !existsSync(out)) {
      if (existsSync(out)) unlinkSync(out);
      return undefined;
    }
    const data = new Uint8Array(await Bun.file(out).arrayBuffer());
    unlinkSync(out);
    const hash = sha256(data);
    await this.put(hash, data);
    return hash;
  }
}

async function probe(path: string): Promise<{ width?: number; height?: number; duration?: number }> {
  if (!FFPROBE) return {};
  const p = Bun.spawn([FFPROBE, "-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", path], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  try {
    const j = JSON.parse(out);
    const s = (j.streams ?? []).find((x: any) => x.width) ?? {};
    const d = Number(j.format?.duration);
    return { width: s.width, height: s.height, duration: isNaN(d) ? undefined : Math.round(d) };
  } catch {
    return {};
  }
}

let pdfjs: any;
export async function pdfInfo(path: string): Promise<{ pages: number; text?: string }> {
  pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await Bun.file(path).arrayBuffer());
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = doc.numPages as number;
  let text = "";
  for (let i = 1; i <= Math.min(pages, 60) && text.length < 40_000; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((x: any) => x.str).join(" ").replace(/\s+/g, " ") + "\n";
  }
  await task.destroy();
  return { pages, text: text.trim().slice(0, 40_000) || undefined };
}
