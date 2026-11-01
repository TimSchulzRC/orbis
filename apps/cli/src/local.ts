// The local side: the state of the last pull, reading and hashing files, walking the folder.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { CliError } from "./config";
import { CONFLICT_MARK, STATE_DIR } from "./names";

/**
 * What a path was at the last pull or push. kind: folder (an item with children), note (an
 * information as <title>.md), body (the body of a folder's item as README.md), file (an original).
 * hash: SHA-256 of the body (note, body) or of the content (file); size and mtime let a status
 * skip hashing files that weren't touched. gone: removed in Obtion while edited here.
 */
export interface Entry {
  id: string;
  kind: "folder" | "note" | "body" | "file";
  version?: string;
  hash?: string;
  size?: number;
  mtime?: number;
  gone?: boolean;
  /** A conflict copy was written with Obtion's version (text) or hash (file) then; deleting the copy says it is merged. */
  theirs?: string;
}

export interface State {
  format: 1;
  server: string;
  workspace: string;
  root: string;
  title: string;
  pulled?: string;
  /** By path relative to the folder, with "/" on every system. */
  entries: Record<string, Entry>;
}

export const statePath = (dir: string) => join(dir, STATE_DIR, "state.json");

export function loadState(dir: string): State | undefined {
  const p = statePath(dir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as State;
  } catch {
    throw new CliError(`${p} is damaged. Move the folder aside and pull again.`);
  }
}

export function saveState(dir: string, s: State) {
  const p = statePath(dir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 1));
  renameSync(tmp, p);
}

/** The folder with .obtion/state.json at or above `from`. */
export function findRoot(from: string): string | undefined {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(statePath(d))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/** A relative "/" path on this system. */
export const abs = (dir: string, rel: string) => (rel ? join(dir, ...rel.split("/")) : dir);
export const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
export const baseOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** UTF-8 text with every byte (a BOM too); undefined if it isn't UTF-8. */
export function decodeUtf8(data: Uint8Array): string | undefined {
  try {
    return utf8.decode(data);
  } catch {
    return undefined;
  }
}

export function readText(path: string): string {
  const t = decodeUtf8(readFileSync(path));
  if (t === undefined) throw new CliError(`${path} is not UTF-8 text.`);
  return t;
}

export async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

/** Written next to the target first, then renamed: an interrupted write leaves the old file. */
export function writeAtomic(path: string, data: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.obtion-tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function stamp(path: string): { size: number; mtime: number } {
  const st = statSync(path);
  return { size: st.size, mtime: st.mtimeMs };
}

/** Never sent: our folder, conflict copies, half-written files and what the system or tools leave behind. */
export const DEFAULT_IGNORE = [".obtion/", ".git/", `*${CONFLICT_MARK}*`, "*.obtion-tmp", ".DS_Store", "Thumbs.db", "desktop.ini", "~$*", "__pycache__/", "*.pyc", ".obtionignore"];

/** Glob patterns, gitignore-like: "dir/" matches a folder, a pattern without "/" any base name. */
export class Ignore {
  private globs: { glob: Bun.Glob; dir: boolean; path: boolean }[];
  constructor(patterns: string[]) {
    this.globs = patterns
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith("#"))
      .map((p) => {
        const dir = p.endsWith("/");
        const q = p.replace(/^\/|\/$/g, "");
        return { glob: new Bun.Glob(q), dir, path: q.includes("/") };
      });
  }
  static of(dir: string, extra: string[] = []) {
    const own = join(dir, ".obtionignore");
    return new Ignore([...DEFAULT_IGNORE, ...extra, ...(existsSync(own) ? readFileSync(own, "utf8").split(/\r?\n/) : [])]);
  }
  /** `rel` with "/" separators. */
  matches(rel: string, isDir: boolean): boolean {
    const base = baseOf(rel);
    return this.globs.some((g) => (!g.dir || isDir) && (g.path ? g.glob.match(rel) : g.glob.match(base)));
  }
}

/** Every file and folder below `dir` that isn't ignored, as "/" paths; ignored ones in `skipped`. */
export function walk(dir: string, ignore: Ignore, skipped: string[] = []): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  const visit = (rel: string) => {
    for (const d of readdirSync(abs(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const isDir = d.isDirectory();
      if (ignore.matches(r, isDir)) {
        skipped.push(isDir ? `${r}/` : r);
        continue;
      }
      if (isDir) {
        dirs.push(r);
        visit(r);
      } else if (d.isFile()) files.push(r);
      else skipped.push(r); // links and devices are not followed
    }
  };
  visit("");
  return { files, dirs };
}

export const toPosix = (p: string) => p.split(sep).join("/");
