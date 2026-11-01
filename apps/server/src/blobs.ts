// Content-addressed file store. Devices that add images offline make previews themselves; the
// server only fills gaps.
import { existsSync, mkdirSync, renameSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type FileMeta, type Item, setFileMeta } from "@obtion/core/model";
import type { Store } from "./store";

const HASH = /^[0-9a-f]{64}$/;
const FFMPEG = Bun.which("ffmpeg");
const FFPROBE = Bun.which("ffprobe");
const MAX_PARALLEL = 2;
const DISPLAY_WIDTH = 1600;
const THUMB_WIDTH = 320;
const PDF_TEXT_MAX_PAGES = 60;
const PDF_TEXT_MAX_CHARS = 40_000;

export function sha256(data: Uint8Array | ArrayBuffer | string): string {
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

  /** Returns false on a hash mismatch. */
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

  /** Includes history and derived versions. */
  referenced(): Set<string> {
    const out = new Set<string>();
    for (const r of this.store.records.values()) {
      const f = r.file;
      if (!f) continue;
      for (const h of [f.hash, f.display, f.thumb, ...(f.history ?? []).map((x) => x.hash)]) if (h) out.add(h);
    }
    return out;
  }

  /** Run by hand only (cli.ts gc): copies in backups/ may still point to these. */
  collect(dryRun = false): string[] {
    const keep = this.referenced();
    const unused = readdirSync(this.dir).filter((name) => HASH.test(name) && !keep.has(name));
    if (!dryRun) for (const hash of unused) unlinkSync(this.path(hash));
    return unused;
  }

  scan() {
    for (const r of this.store.live()) if (this.needsWork(r)) this.schedule(r.id);
    // PDF previews a device announced but never uploaded: drop them so a device renders them again
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

  stop() {
    this.queue.length = 0;
  }

  schedule(id: string) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    this.queue.push(id);
    this.pump();
  }

  private pump() {
    while (this.running < MAX_PARALLEL && this.queue.length) {
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
      if (!f.display) patch.display = await this.derive(src, DISPLAY_WIDTH);
      if (!f.thumb) patch.thumb = await this.derive(src, THUMB_WIDTH);
    } else if (f.filetype === "audio" || f.filetype === "video") {
      const p = await probe(src);
      patch.duration = p.duration ?? 0;
      if (f.filetype === "video") {
        if (p.width) Object.assign(patch, { width: p.width, height: p.height });
        if (!f.thumb) patch.thumb = await this.derive(src, THUMB_WIDTH, true);
      }
    } else if (f.filetype === "pdf") {
      const info = await pdfInfo(src);
      patch.pages = info.pages;
      if (info.text) patch.text = info.text;
    }
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length) this.store.change(id, "system:files", (doc) => setFileMeta(doc, clean), { quiet: true });
  }

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
    const j: { streams?: { width?: number; height?: number }[]; format?: { duration?: string } } = JSON.parse(out);
    const s = (j.streams ?? []).find((x) => x.width) ?? {};
    const d = Number(j.format?.duration);
    return { width: s.width, height: s.height, duration: isNaN(d) ? undefined : Math.round(d) };
  } catch {
    return {};
  }
}

let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | undefined;
async function pdfInfo(path: string): Promise<{ pages: number; text?: string }> {
  pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await Bun.file(path).arrayBuffer());
  const task = pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = doc.numPages;
  let text = "";
  for (let i = 1; i <= Math.min(pages, PDF_TEXT_MAX_PAGES) && text.length < PDF_TEXT_MAX_CHARS; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((x) => ("str" in x ? x.str : "")).join(" ").replace(/\s+/g, " ") + "\n";
  }
  await task.destroy();
  return { pages, text: text.trim().slice(0, PDF_TEXT_MAX_CHARS) || undefined };
}
