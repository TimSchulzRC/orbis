// obtion import: a folder or Git repository becomes items below one root – folders as overviews
// (their README.md as text), Markdown as informations with the exact text, everything else as files.
// Each item keeps its repo path as `source` ("repo:<name>/<path>"), so re-runs find it again and
// update only what changed; what was edited in Obtion since is never overwritten. The Git history
// goes along (a note with every commit, dated updates or notes per folder, a bundle, old LFS
// versions), and a report proves for every file that it arrived.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { type Client, type Node, ToolError, pool, writtenLines } from "./client";
import { CliError } from "./config";
import { type Rewrite, rewriteLinks, suffixes } from "./links";
import { Ignore, decodeUtf8, hashFile } from "./local";
import { sha256 } from "./notes";

// ---------- config ----------

export interface Rule {
  /** Glob over the repo path of a folder or file, e.g. "04_Customer_Projects/Germany_*". First match wins. */
  path: string;
  /** Regex over the base name; its groups are {1}, {2} … in `title`. */
  match?: string;
  /** Title template: {name} base name, {stem} without extension, {1} … groups of `match`. */
  title?: string;
  type?: string;
  /** Another place instead of the repo's folder: an item id or exact title (made below the root if missing), or "path:<repo folder>". */
  parent?: string;
  pin?: boolean;
  /** Property values by name, set when the item is created (never changed by re-runs). */
  properties?: Record<string, unknown>;
}

export interface ImportConfig {
  /** Name in source keys and titles; default the folder's name. */
  name?: string;
  /** Not imported, listed in the report. Patterns like .obtionignore. */
  ignore?: string[];
  /** A folder's README.md is the text of the folder's item (default true). */
  readme_as_body?: boolean;
  /** Relative links and mentions of tracked files → [[id|label]] (default true). */
  rewrite_links?: boolean;
  /** A repo path whose note carries the rules for agents (e.g. "CLAUDE.md"); titled `rules_title`. */
  rules_file?: string;
  rules_title?: string;
  history?: {
    /** Dated updates (commit date) on folder items whose type has updates (default true). */
    updates?: boolean;
    /** Folders (globs) without updates that get a note "Verlauf <title>" (default ["*", "*\/*"]). */
    notes?: string[];
    /** Which refs count, as git log takes them (default ["--branches", "--tags"]; ["--all"] adds tool refs like refs/t3/…). Also the refs of the bundle. */
    refs?: string[];
  };
  /** A git bundle of all refs as a file below the root (default true). */
  bundle?: boolean;
  /** Old versions of Git LFS files that aren't among the current files go into "Git-LFS-Archiv" (default true). */
  lfs?: boolean;
  /** Parallel uploads (default 4). */
  concurrency?: number;
  rules?: Rule[];
}

export const DEFAULT_IMPORT_IGNORE = [".git/", ".gitkeep", ".gitignore", ".gitattributes"];
const MAX_UPLOAD = 512 * 1024 * 1024;

export interface ImportOptions {
  config?: ImportConfig;
  dryRun?: boolean;
  /** Where the Markdown report goes (default ./obtion-import-<name>-<date>.md). */
  report?: string;
  /** Scratch space for the bundle (default the system's temp folder). */
  tmp?: string;
  history?: boolean;
  bundle?: boolean;
  quiet?: boolean;
}

// ---------- reading the source ----------

interface Tracked {
  path: string;
  /** Git mode: 100644/100755 files, 120000 symlinks, 160000 submodules. */
  mode: string;
}

function run(cwd: string, args: string[], allowFail = false): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (p.exitCode !== 0) {
    if (allowFail) return "";
    throw new CliError(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  }
  return p.stdout.toString();
}

function isGit(folder: string): boolean {
  const p = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: folder, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 && p.stdout.toString().trim() === "true";
}

/** Tracked files (Git) or every file (a plain folder), "/" paths relative to `folder`. */
function listFiles(folder: string, git: boolean): Tracked[] {
  if (git) {
    const prefix = run(folder, ["rev-parse", "--show-prefix"]).trim();
    return run(folder, ["ls-files", "-z", "-s", "--full-name", "."])
      .split("\0")
      .filter(Boolean)
      .map((l) => {
        const tab = l.indexOf("\t");
        return { mode: l.slice(0, 6), path: l.slice(tab + 1) };
      })
      .map((t) => ({ ...t, path: stripPrefix(t.path, prefix) }))
      .filter((t) => t.path !== "");
  }
  const out: Tracked[] = [];
  const visit = (rel: string) => {
    for (const d of readdirSync(rel ? join(folder, rel) : folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory() && d.name !== ".git") visit(r);
      else if (d.isSymbolicLink()) out.push({ path: r, mode: "120000" });
      else if (d.isFile()) out.push({ path: r, mode: "100644" });
      else if (d.name === ".git") out.push({ path: `${r}/`, mode: "040000" });
    }
  };
  visit("");
  return out;
}

const stripPrefix = (p: string, prefix: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : prefix ? "" : p);

export interface Commit {
  sha: string;
  parents: string[];
  date: string;
  author: string;
  email: string;
  message: string;
  changes: { status: string; path: string }[];
}

/** Every commit of the refs, newest first, with the paths it changed (below the imported folder). */
export function gitLog(folder: string, refs: string[]): Commit[] {
  const prefix = run(folder, ["rev-parse", "--show-prefix"]).trim();
  const raw = run(folder, ["log", ...refs, "--date-order", "--format=%H%x1f%P%x1f%aI%x1f%an%x1f%ae%x1f%B%x1e"], true);
  const commits: Commit[] = [];
  for (const rec of raw.split("\x1e")) {
    const r = rec.replace(/^\n/, "");
    if (!r) continue;
    const [sha, parents, date, author, email, ...msg] = r.split("\x1f");
    const message = msg.join("\x1f").replace(/\n$/, "");
    const ps = (parents ?? "").split(" ").filter(Boolean);
    const diff = run(folder, ["diff-tree", "-r", "-z", "--name-status", "--no-renames", "--no-commit-id", ...(ps[0] ? [ps[0], sha!] : ["--root", sha!])]).split("\0");
    const changes: Commit["changes"] = [];
    for (let i = 0; i + 1 < diff.length; i += 2) {
      const path = stripPrefix(diff[i + 1]!, prefix);
      if (path) changes.push({ status: diff[i]!, path });
    }
    if (prefix && !changes.length) continue;
    commits.push({ sha: sha!, parents: ps, date: date!, author: author!, email: email!, message, changes });
  }
  return commits;
}

// ---------- the plan ----------

interface Planned {
  /** Repo path; folders without trailing "/", "" the root. */
  path: string;
  kind: "folder" | "note" | "file";
  source: string;
  title: string;
  /** Repo path of the folder above ("" the root). */
  parentPath: string;
  rule?: Rule;
  /** note, or folder with README.md: the original text and the README's path. */
  original?: string;
  textPath?: string;
  size?: number;
  hash?: string;
  /** Why a Markdown file goes in as a file. */
  asFile?: string;
  /** Where the content is read from, if not the path itself (a Git LFS object for a pointer). */
  from?: string;
}

/** unavailable: history only (an old LFS version) that isn't on this machine; not a tracked file. */
type Status = "imported" | "updated" | "unchanged" | "conflict" | "ignored" | "failed" | "unavailable";

interface Row {
  path: string;
  id?: string;
  status: Status;
  note?: string;
  original?: string;
  remote?: string;
  check?: string;
  size: number;
}

interface StateItem {
  id: string;
  /** SHA-256 of the content uploaded (files) or of the text written (notes, generated texts). */
  hash?: string;
}
interface ImportState {
  format: 1;
  name: string;
  items: Record<string, StateItem>;
  bundle?: { refs: string; hash: string };
}

const ext = (p: string) => {
  const b = posix.basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "(ohne)";
};
const fence = (s: string) => {
  let f = "```";
  while (s.includes(f)) f += "`";
  return f;
};
const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function titleFor(rule: Rule | undefined, name: string, stem: string): string {
  if (!rule?.title) return stem;
  const groups = rule.match ? (new RegExp(rule.match).exec(name) ?? []) : [];
  return rule.title.replace(/\{(name|stem|\d+)\}/g, (_, k: string) => (k === "name" ? name : k === "stem" ? stem : (groups[Number(k)] ?? ""))).trim() || stem;
}

function ruleFor(rules: Rule[], path: string): Rule | undefined {
  const name = posix.basename(path);
  return rules.find((r) => new Bun.Glob(r.path).match(path) && (!r.match || new RegExp(r.match).test(name)));
}

// ---------- the import ----------

export async function importRepo(client: Client, folderArg: string, into: string, opts: ImportOptions = {}): Promise<number> {
  const started = Date.now();
  const folder = resolve(folderArg);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new CliError(`${folderArg} is not a folder.`);
  const cfg = opts.config ?? {};
  const name = cfg.name ?? basename(folder);
  const key = (p: string) => (p ? `repo:${name}/${p}` : `repo:${name}`);
  const git = isGit(folder);
  const dry = !!opts.dryRun;
  const say = (s: string) => opts.quiet || console.log(s);
  const ignore = new Ignore(cfg.ignore ?? DEFAULT_IMPORT_IGNORE);
  const readmeBody = cfg.readme_as_body ?? true;
  const today = new Date().toLocaleDateString("sv"); // YYYY-MM-DD, local

  // what is there
  const tracked = listFiles(folder, git);
  const rows = new Map<string, Row>();
  const skipped = (t: Tracked, why: string) => rows.set(t.path, { path: t.path, status: "ignored", note: why, size: 0 });
  const files: Tracked[] = [];
  for (const t of tracked) {
    const parts = t.path.split("/");
    const inIgnoredDir = parts.slice(0, -1).some((_, i) => ignore.matches(parts.slice(0, i + 1).join("/"), true));
    if (inIgnoredDir || ignore.matches(t.path, false)) skipped(t, "ignore list");
    else if (t.mode === "120000") skipped(t, "symbolic link (its target is imported where it is tracked)");
    else if (t.mode === "160000") skipped(t, "submodule (import its repository on its own)");
    else if (t.mode === "040000") skipped(t, "folder");
    else if (!existsSync(join(folder, t.path))) rows.set(t.path, { path: t.path, status: "failed", note: "tracked, but missing in the working tree", size: 0 });
    else files.push(t);
  }
  say(`${name}: ${tracked.length} ${git ? "tracked " : ""}files, ${files.length} to import, ${tracked.length - files.length} ignored or missing.`);

  // folders from every path that isn't ignored (also folders that only hold a .gitkeep)
  const folderPaths = new Set<string>([""]);
  for (const t of tracked) {
    const parts = t.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (ignore.matches(p, true)) break;
      folderPaths.add(p);
    }
  }
  const rules = cfg.rules ?? [];
  const plan = new Map<string, Planned>();
  for (const p of [...folderPaths].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1))) {
    if (!p) continue;
    const rule = ruleFor(rules, p);
    const n = posix.basename(p);
    plan.set(p, { path: p, kind: "folder", source: key(p), title: titleFor(rule, n, n), parentPath: posix.dirname(p) === "." ? "" : posix.dirname(p), rule });
  }
  say("Reading files and hashing them …");
  let hashed = 0;
  const lfsStore = git ? resolve(folder, run(folder, ["rev-parse", "--git-path", "lfs/objects"]).trim()) : undefined;
  await pool(files, 8, async (t) => {
    let abs = join(folder, t.path);
    let size = statSync(abs).size;
    let from: string | undefined;
    // a Git LFS pointer instead of the content: the content comes from the LFS store, if it is there
    const head = size < 1024 ? readFileSync(abs).toString() : "";
    if (head.startsWith("version https://git-lfs.github.com/spec/v1\n")) {
      const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(head)?.[1];
      const obj = oid && lfsStore ? join(lfsStore, oid.slice(0, 2), oid.slice(2, 4), oid) : undefined;
      if (!obj || !existsSync(obj) || (await hashFile(obj)) !== oid) {
        rows.set(t.path, {
          path: t.path,
          status: "failed",
          note: "only the Git LFS pointer is here, not the content: git lfs fetch in the repository, then import again",
          size,
          original: await hashFile(abs),
        });
        return;
      }
      abs = from = obj;
      size = statSync(obj).size;
    }
    const hash = await hashFile(abs);
    const n = posix.basename(t.path);
    const dir = posix.dirname(t.path) === "." ? "" : posix.dirname(t.path);
    const rule = ruleFor(rules, t.path);
    const md = /\.md$/i.test(n) && !from;
    const text = md && size <= 20 * 1024 * 1024 ? decodeUtf8(readFileSync(abs)) : undefined;
    const asFile = md && text === undefined ? (size > 20 * 1024 * 1024 ? "Markdown larger than 20 MB" : "Markdown not in UTF-8") : undefined;
    if (md && text !== undefined && readmeBody && n === "README.md" && dir) {
      const f = plan.get(dir)!;
      Object.assign(f, { original: text, textPath: t.path });
      rows.set(t.path, { path: t.path, status: "unchanged", size, original: hash });
    } else if (md && text !== undefined) {
      const stem = n.replace(/\.md$/i, "");
      const title = cfg.rules_file === t.path ? (cfg.rules_title ?? "Regeln für Agenten") : titleFor(rule, n, stem);
      plan.set(t.path, { path: t.path, kind: "note", source: key(t.path), title, parentPath: dir, rule, original: text, textPath: t.path, size, hash });
      rows.set(t.path, { path: t.path, status: "unchanged", size, original: hash });
    } else {
      plan.set(t.path, { path: t.path, kind: "file", source: key(t.path), title: n, parentPath: dir, rule, size, hash, asFile, from });
      const note = [asFile && `as a file: ${asFile}`, from && "content from the Git LFS store (the working tree has the pointer)"].filter(Boolean).join("; ");
      rows.set(t.path, { path: t.path, status: "unchanged", size, original: hash, ...(note ? { note } : {}) });
    }
    if (++hashed % 200 === 0) say(`  ${hashed}/${files.length}`);
  });
  // root README.md: the text of the root itself
  const rootReadme = files.find((t) => t.path === "README.md");
  const rootText = rootReadme && readmeBody && plan.get("README.md")?.kind === "note" ? plan.get("README.md") : undefined;
  if (rootText) plan.delete("README.md");

  // the root: an item with this exact id or title, else a new pinned one
  let rootNode: Node | undefined;
  let tree: Node[] = [];
  try {
    const t = await client.tree(into);
    const r = t.items.find((n) => n.id === t.root)!;
    if (r.id === into || r.title.trim().toLowerCase() === into.trim().toLowerCase()) {
      rootNode = r;
      tree = t.items;
    }
  } catch (e) {
    if (!(e instanceof CliError) || !/Nothing matches|No item is titled/.test(e.message)) throw e;
  }
  const bySource = new Map<string, Node>();
  for (const n of tree) if (n.source && !bySource.has(n.source)) bySource.set(n.source, n);
  const ids = new Map<string, string>(); // repo path (or generated key) → item id
  const nodes = new Map<string, Node>(tree.map((n) => [n.id, n]));
  const created = new Set<string>();
  const failedCreate = new Set<string>();

  // the import's own state on the server (any device can continue it)
  const STATE = `${key("")}#state`;
  let state: ImportState = { format: 1, name, items: {} };
  const stateNode = bySource.get(STATE);
  if (stateNode && !dry) {
    const t = join(opts.tmp ?? tmpdir(), `obtion-import-state-${process.pid}.json`);
    await client.download(stateNode.id, t, `${t}.part`);
    state = JSON.parse(readFileSync(t, "utf8"));
    rmSync(t, { force: true });
  }

  // types: exist, and which have updates
  const schema = JSON.parse(await client.tool("schema", {})) as { types: { name: string; capabilities: { updates?: string } }[] };
  const typeHasUpdates = (t: string | null | undefined) => !!t && !!schema.types.find((x) => x.name.toLowerCase() === t.toLowerCase())?.capabilities.updates;
  for (const r of rules)
    if (r.type && !schema.types.some((x) => x.name.toLowerCase() === r.type!.toLowerCase()))
      throw new CliError(`Rule "${r.path}": type "${r.type}" doesn't exist in this workspace. Types: ${schema.types.map((x) => x.name).join(", ")}.`);

  const counts = { created: 0, uploaded: 0, updated: 0 };
  const createItems = async (items: { p: Planned | { source: string; title: string }; input: Record<string, unknown> }[]) => {
    // all or nothing per call: a batch that fails goes again one by one, so one bad item only fails itself
    for (let i = 0; i < items.length;) {
      let size = 0;
      let j = i;
      while (j < items.length && j - i < 40 && (size += JSON.stringify(items[j]!.input).length) < 2_000_000) j++;
      j = Math.max(j, i + 1);
      const batch = items.slice(i, j);
      i = j;
      if (dry) {
        for (const b of batch) ids.set(b.p.source, `(new)${b.p.source}`);
        continue;
      }
      try {
        const made = writtenLines(await client.tool("create", { items: batch.map((b) => b.input) }));
        if (made.length !== batch.length) throw new CliError(`create answered ${made.length} of ${batch.length} items`);
        batch.forEach((b, k) => {
          ids.set(b.p.source, made[k]!.id);
          created.add(made[k]!.id);
          nodes.set(made[k]!.id, {
            id: made[k]!.id,
            version: made[k]!.version ?? "",
            body: (b.input.body as string) ?? "",
            kind: "info",
            title: b.p.title,
            type: null,
            parents: [],
            home: null,
            created: 0,
            updated: 0,
            source: b.p.source,
          });
        });
        counts.created += batch.length;
      } catch (e) {
        if (batch.length === 1) {
          failedCreate.add(batch[0]!.p.source);
          console.error(`  failed: ${batch[0]!.p.source}: ${(e as Error).message.split("\n")[0]}`);
        } else for (const b of batch) await createItems([b]);
      }
    }
  };

  // 1. root and places named by rules
  let rootId: string;
  if (rootNode) rootId = rootNode.id;
  else {
    say(`New root "${into}".`);
    await createItems([{ p: { source: key(""), title: into }, input: { title: into, pin: true, source: key(""), ...(rootText ? { body: rootText.original } : {}) } }]);
    rootId = ids.get(key("")) ?? "";
    if (!rootId) throw new CliError(`The root "${into}" could not be created.`);
  }
  ids.set(key(""), rootId);
  const pathId = (p: string) => ids.get(key(p)) ?? bySource.get(key(p))?.id;
  const parentRefs = new Map<string, string>();
  const parentOf = async (pl: Planned): Promise<string | undefined> => {
    const ref = pl.rule?.parent;
    if (!ref) return pathId(pl.parentPath);
    if (ref.startsWith("path:")) return pathId(ref.slice(5).replace(/\/+$/, ""));
    if (parentRefs.has(ref)) return parentRefs.get(ref);
    let id = tree.find((n) => n.id === ref || n.title.trim().toLowerCase() === ref.trim().toLowerCase())?.id;
    if (!id)
      try {
        const t = await client.tree(ref);
        const r = t.items.find((n) => n.id === t.root)!;
        if (r.id === ref || r.title.trim().toLowerCase() === ref.trim().toLowerCase()) id = r.id;
      } catch {
        // not there: made below the root
      }
    if (!id) {
      const src = `${key("")}#parent:${ref}`;
      id = bySource.get(src)?.id;
      if (!id) {
        await createItems([{ p: { source: src, title: ref }, input: { title: ref, parents: [rootId], source: src } }]);
        id = ids.get(src);
      }
    }
    if (id) parentRefs.set(ref, id);
    return id;
  };

  // 2. folders (parents first), then notes – with their original text, so an interrupted run can tell its own text from an edit
  const inputFor = async (pl: Planned) => {
    const parent = await parentOf(pl);
    if (!parent) return undefined;
    return {
      title: pl.title,
      parents: [parent],
      source: pl.source,
      ...(pl.rule?.type ? { type: pl.rule.type } : {}),
      ...(pl.rule?.pin ? { pin: true } : {}),
      ...(pl.rule?.properties ? { properties: pl.rule.properties } : {}),
      ...(pl.original ? { body: pl.original } : {}),
    };
  };
  const byDepth = (kind: Planned["kind"]) => [...plan.values()].filter((p) => p.kind === kind).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const folders = byDepth("folder");
  const depths = [...new Set(folders.map((f) => f.path.split("/").length))];
  say(`Folders: ${folders.length} …`);
  for (const d of depths) {
    const todo: { p: Planned; input: Record<string, unknown> }[] = [];
    for (const f of folders.filter((x) => x.path.split("/").length === d && !bySource.has(x.source))) {
      const input = await inputFor(f);
      if (input) todo.push({ p: f, input });
      else failedCreate.add(f.source);
    }
    await createItems(todo);
  }
  const notes = byDepth("note");
  say(`Notes: ${notes.length} …`);
  const noteTodo: { p: Planned; input: Record<string, unknown> }[] = [];
  for (const n of notes.filter((x) => !bySource.has(x.source))) {
    const input = await inputFor(n);
    if (input) noteTodo.push({ p: n, input });
    else failedCreate.add(n.source);
  }
  await createItems(noteTodo);
  for (const pl of plan.values()) {
    const id = pathId(pl.path);
    if (id) ids.set(pl.source, id);
  }

  // 3. files: new ones uploaded, changed ones replaced (only if nobody replaced them in Obtion)
  const fileList = byDepth("file");
  let done = 0;
  let bytes = 0;
  const total = fileList.reduce((s, f) => s + (f.size ?? 0), 0);
  let lastSay = Date.now();
  say(`Files: ${fileList.length} (${fmtBytes(total)}) …`);
  await pool(fileList, Math.max(1, cfg.concurrency ?? 4), async (f) => {
    const row = rows.get(f.path)!;
    const existing = bySource.get(f.source);
    const st = state.items[f.source];
    try {
      if ((f.size ?? 0) > MAX_UPLOAD) throw new CliError(`larger than the server's limit of ${fmtBytes(MAX_UPLOAD)}`);
      if (!existing) {
        const parent = await parentOf(f);
        if (!parent) throw new CliError("its folder could not be created");
        if (dry) ids.set(f.source, `(new)${f.source}`);
        else {
          const got = await client.upload(f.from ?? join(folder, f.path), posix.basename(f.path), parent, f.source);
          if (got.hash !== f.hash) throw new CliError(`the server stored SHA-256 ${got.hash}`);
          ids.set(f.source, got.id);
          state.items[f.source] = { id: got.id, hash: got.hash };
          counts.uploaded++;
        }
        row.status = "imported";
      } else {
        ids.set(f.source, existing.id);
        const now = existing.file?.hash;
        if (now === f.hash) {
          state.items[f.source] = { id: existing.id, hash: f.hash };
        } else if (st?.hash && now === st.hash) {
          // changed in the repo, untouched in Obtion
          if (!dry) {
            const got = await client.replace(existing.id, f.from ?? join(folder, f.path), st.hash);
            if (got === "stale") throw new ToolError("replaced in Obtion meanwhile");
            if (got.hash !== f.hash) throw new CliError(`the server stored SHA-256 ${got.hash}`);
            state.items[f.source] = { id: existing.id, hash: got.hash };
          }
          row.status = "updated";
        } else {
          row.status = "conflict";
          row.note = "replaced in Obtion since the last import; not overwritten";
        }
      }
    } catch (e) {
      row.status = e instanceof ToolError ? "conflict" : "failed";
      row.note = (e as Error).message.split("\n")[0];
    }
    bytes += f.size ?? 0;
    if (++done === fileList.length || Date.now() - lastSay > 5000) {
      say(`  ${done}/${fileList.length} files, ${fmtBytes(bytes)} of ${fmtBytes(total)}`);
      lastSay = Date.now();
    }
  });
  if (!dry) await saveState();

  // 4. texts: links rewritten, written only where Obtion still has what the last import wrote
  const byPath = new Map<string, string>();
  for (const pl of plan.values()) {
    const id = ids.get(pl.source);
    if (!id) continue;
    byPath.set(pl.path, id);
    if (pl.textPath && pl.kind === "folder") byPath.set(pl.textPath, id);
  }
  byPath.set("", rootId);
  if (rootText) byPath.set("README.md", rootId);
  const nameCount = new Map<string, string[]>();
  for (const p of byPath.keys())
    if (p && plan.get(p)?.kind !== "folder") {
      const n = posix.basename(p);
      nameCount.set(n, [...(nameCount.get(n) ?? []), p]);
    }
  const byName = new Map([...nameCount].filter(([, ps]) => ps.length === 1).map(([n, ps]) => [n, byPath.get(ps[0]!)!]));
  const bySuffix = suffixes([...byPath].filter(([p]) => p));
  const allRewrites: { path: string; r: Rewrite }[] = [];
  const unresolved: { path: string; target: string }[] = [];
  const desired = new Map<string, string>(); // source → text

  /** Writes a text this import owns; returns what happened. */
  const writeText = async (source: string, id: string, text: string, original: string | undefined): Promise<{ status: Status; note?: string }> => {
    const node = nodes.get(id) ?? bySource.get(source);
    const st = state.items[source];
    const now = node?.body ?? "";
    const hash = sha256(text);
    if (now === text) {
      state.items[source] = { id, hash };
      return { status: created.has(id) ? "imported" : "unchanged" };
    }
    const ours = created.has(id) || (st?.hash ? sha256(now) === st.hash : original !== undefined && now === original);
    if (!ours) return { status: "conflict", note: "edited in Obtion since the last import; not overwritten" };
    if (dry) return { status: created.has(id) ? "imported" : "updated" };
    try {
      const answer = await client.tool("update", { ref: id, body: text, base_version: node?.version });
      state.items[source] = { id, hash };
      const v = writtenLines(answer)[0]?.version;
      if (node && v) Object.assign(node, { version: v, body: text });
      counts.updated++;
      return { status: created.has(id) ? "imported" : "updated" };
    } catch (e) {
      if (e instanceof ToolError && e.stale) return { status: "conflict", note: "edited in Obtion during the import; not overwritten" };
      return { status: "failed", note: (e as Error).message.split("\n")[0] };
    }
  };

  const texts = [...plan.values()].filter((p) => p.original !== undefined);
  if (rootText) texts.push({ ...rootText, path: "", kind: "folder", source: key(""), textPath: "README.md" });
  say(`Texts: ${texts.length} …`);
  for (const pl of texts) {
    const id = ids.get(pl.source);
    const row = rows.get(pl.textPath!)!;
    if (!id) {
      row.status = "failed";
      row.note = failedCreate.has(pl.source) ? "could not be created" : "no item";
      continue;
    }
    let text = pl.original!;
    if (cfg.rewrite_links ?? true) {
      const r = rewriteLinks(text, pl.textPath!, id, { byPath, byName, bySuffix });
      text = r.text;
      for (const x of r.rewrites) allRewrites.push({ path: pl.textPath!, r: x });
      for (const u of r.unresolved) unresolved.push({ path: pl.textPath!, target: u });
    }
    desired.set(pl.source, text);
    if (dry && id.startsWith("(new)")) {
      row.status = "imported";
      continue;
    }
    const res = await writeText(pl.source, id, text, pl.original);
    row.status = res.status;
    row.note = res.note ?? row.note;
  }
  for (const pl of plan.values()) if (pl.kind === "folder" && !pl.original && ids.get(pl.source) && created.has(ids.get(pl.source)!)) state.items[pl.source] = { id: ids.get(pl.source)! };

  // 5. history
  const refArgs = cfg.history?.refs ?? ["--branches", "--tags"];
  const commits = git && opts.history !== false ? gitLog(folder, refArgs) : [];
  const generated: { source: string; title: string; status: Status; note?: string }[] = [];
  if (commits.length) {
    say(`Git history: ${commits.length} commits …`);
    const refPatterns = refArgs.includes("--all")
      ? []
      : [
          ...(refArgs.includes("--branches") ? ["refs/heads"] : []),
          ...(refArgs.includes("--tags") ? ["refs/tags"] : []),
          ...(refArgs.includes("--remotes") ? ["refs/remotes"] : []),
          ...refArgs.filter((r) => r.startsWith("refs/")),
        ];
    const headRef = run(folder, ["symbolic-ref", "-q", "HEAD"], true).trim() || run(folder, ["rev-parse", "HEAD"], true).trim();
    const refs = `HEAD\t${headRef}\n${run(folder, ["for-each-ref", "--format=%(refname)%09%(objectname)", ...refPatterns]).trim()}`;
    const block = (c: Commit, paths: { status: string; path: string }[]) => {
      const head = `### ${c.date.slice(0, 16).replace("T", " ")} · ${c.message.split("\n")[0]}`;
      const meta = `\`${c.sha}\` · ${c.author} <${c.email}>${c.parents.length > 1 ? ` · Merge von ${c.parents.map((p) => `\`${p.slice(0, 7)}\``).join(", ")}` : ""}`;
      const f = fence(c.message);
      const list = paths.map((x) => `- ${x.status} \`${x.path}\``).join("\n");
      return `${head}\n\n${meta}\n\n${f}text\n${c.message}\n${f}\n\n${list || "(keine Dateien)"}\n`;
    };
    const historyText = `Jeder Commit aus ${name} (${commits.length}, neueste zuerst): Datum, Autor, Nachricht unverändert, geänderte Pfade. Pfade sind die \`source\` der Elemente (repo:${name}/<Pfad>).\n\n## Refs\n\n${fence(refs)}\n${refs}\n${fence(refs)}\n\n## Commits\n\n${commits.map((c) => block(c, c.changes)).join("\n")}`;
    const ensureNote = async (source: string, title: string, parent: string, text: string) => {
      let id = bySource.get(source)?.id ?? ids.get(source);
      if (!id) {
        await createItems([{ p: { source, title }, input: { title, parents: [parent], source, body: text } }]);
        id = ids.get(source);
        if (!id) return generated.push({ source, title, status: "failed", note: "could not be created" });
        if (!dry) state.items[source] = { id, hash: sha256(text) };
        return generated.push({ source, title, status: "imported" });
      }
      if (id.startsWith("(new)")) return generated.push({ source, title, status: "imported" });
      const r = await writeText(source, id, text, undefined);
      generated.push({ source, title, ...r });
    };
    await ensureNote(`${key("")}#history`, "Git-Verlauf", rootId, historyText);

    const histGlobs = (cfg.history?.notes ?? ["*", "*/*"]).map((g) => new Bun.Glob(g));
    for (const f of folders) {
      const id = ids.get(f.source);
      if (!id || id.startsWith("(new)")) continue;
      const mine = commits.map((c) => ({ c, paths: c.changes.filter((x) => x.path.startsWith(`${f.path}/`)) })).filter((x) => x.paths.length);
      if (!mine.length) continue;
      const node = nodes.get(id) ?? bySource.get(f.source);
      const type = node?.type ?? f.rule?.type;
      if ((cfg.history?.updates ?? true) && typeHasUpdates(type)) {
        const have = new Set((bySource.get(f.source)?.updates ?? []).map((u) => /`([0-9a-f]{7,40})`/.exec(u.text)?.[1]?.slice(0, 7)).filter(Boolean));
        const todo = mine.filter((x) => !have.has(x.c.sha.slice(0, 7))).reverse(); // oldest first
        for (const { c, paths } of todo) {
          const list = paths
            .slice(0, 30)
            .map((x) => `${x.status} ${x.path.slice(f.path.length + 1)}`)
            .join("\n");
          const text = `${c.message.trim()}\n\n\`${c.sha.slice(0, 7)}\` · ${c.author} · ${paths.length} Datei(en)\n${list}${paths.length > 30 ? `\n… ${paths.length - 30} weitere` : ""}`;
          if (dry) continue;
          try {
            await client.tool("add_update", { ref: id, text, at: c.date });
          } catch (e) {
            generated.push({ source: `${f.source}#update:${c.sha.slice(0, 7)}`, title: `Update ${c.sha.slice(0, 7)} auf ${f.title}`, status: "failed", note: (e as Error).message.split("\n")[0] });
          }
        }
        generated.push({
          source: `${f.source}#updates`,
          title: `${mine.length} Updates auf ${f.title}`,
          status: todo.length ? "imported" : "unchanged",
          note: todo.length ? `${todo.length} neu` : undefined,
        });
      } else if (histGlobs.some((g) => g.match(f.path))) {
        const text = `Commits, die Dateien unter \`${f.path}/\` geändert haben (${mine.length}, neueste zuerst). Alle Commits: [[Git-Verlauf]].\n\n${mine.map((x) => block(x.c, x.paths)).join("\n")}`;
        await ensureNote(`${f.source}#history`, `Verlauf ${f.title}`, id, text);
      }
    }

    // old versions of LFS files: their content is not in the bundle
    if ((cfg.lfs ?? true) && Bun.spawnSync(["git", "lfs", "version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0) {
      const all = run(folder, ["lfs", "ls-files", "--all", "--long"], true); // every ref: an object of a tool ref costs nothing to keep
      const have = new Set([...plan.values()].map((p) => p.hash).filter(Boolean));
      const old = new Map<string, string>();
      for (const line of all.split("\n")) {
        const m = /^([0-9a-f]{64}) [*-] (.+)$/.exec(line);
        if (m && !have.has(m[1]!) && !old.has(m[1]!)) old.set(m[1]!, m[2]!);
      }
      if (old.size) {
        const lfsDir = run(folder, ["rev-parse", "--git-path", "lfs/objects"]).trim();
        const base = resolve(folder, lfsDir);
        const archive = `${key("")}#lfs`;
        let archiveId = bySource.get(archive)?.id;
        if (!archiveId) {
          await createItems([
            {
              p: { source: archive, title: "Git-LFS-Archiv" },
              input: {
                title: "Git-LFS-Archiv",
                parents: [rootId],
                source: archive,
                body: `Ältere Fassungen von Dateien, die ${name} mit Git LFS verwaltet. Der Name ist der letzte Pfad, unter dem die Fassung lag; source nennt ihre LFS-ID (SHA-256 = Hash hier).`,
              },
            },
          ]);
          archiveId = ids.get(archive);
        }
        let up = 0;
        let missing = 0;
        await pool([...old], cfg.concurrency ?? 4, async ([oid, path]) => {
          const src = `${archive}/${oid}`;
          if (bySource.has(src)) return;
          const obj = join(base, oid.slice(0, 2), oid.slice(2, 4), oid);
          if (!existsSync(obj)) {
            missing++;
            generated.push({
              source: src,
              title: `LFS ${oid.slice(0, 12)} (${path})`,
              status: "unavailable",
              note: "old LFS version not on this machine (git lfs fetch --all in the repository, then import again)",
            });
            return;
          }
          if (dry || !archiveId || archiveId.startsWith("(new)")) return void up++;
          try {
            const got = await client.upload(obj, posix.basename(path), archiveId, src);
            if (got.hash !== oid) throw new CliError(`the server stored SHA-256 ${got.hash}`);
            up++;
          } catch (e) {
            generated.push({ source: src, title: path, status: "failed", note: (e as Error).message.split("\n")[0] });
          }
        });
        generated.push({
          source: archive,
          title: "Git-LFS-Archiv",
          status: up ? "imported" : "unchanged",
          note: `${old.size} ältere LFS-Fassungen, ${up} hochgeladen${missing ? `, ${missing} fehlen lokal` : ""}`,
        });
      }
    }

    // a bundle of all refs: the repository can be cloned from it again
    if ((cfg.bundle ?? true) && opts.bundle !== false) {
      const src = `${key("")}#bundle`;
      const refsHash = sha256(refs);
      const node = bySource.get(src);
      if (node && state.bundle?.refs === refsHash && node.file?.hash === state.bundle.hash) generated.push({ source: src, title: `${name}.bundle`, status: "unchanged" });
      else if (dry) generated.push({ source: src, title: `${name}.bundle`, status: node ? "updated" : "imported" });
      else {
        const dir = join(opts.tmp ?? tmpdir(), `obtion-bundle-${process.pid}`);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${name}.bundle`);
        try {
          run(folder, ["bundle", "create", file, "HEAD", ...refArgs.filter((r) => r !== "HEAD")]);
          const size = statSync(file).size;
          if (size > MAX_UPLOAD) throw new CliError(`the bundle has ${fmtBytes(size)}, more than the server takes`);
          const hash = await hashFile(file);
          if (node && node.file?.hash === hash) state.bundle = { refs: refsHash, hash };
          else if (node && state.bundle?.hash && node.file?.hash !== state.bundle.hash) throw new ToolError("replaced in Obtion since the last import; not overwritten");
          else {
            const got = node ? await client.replace(node.id, file, node.file!.hash) : await client.upload(file, `${name}.bundle`, rootId, src);
            if (got === "stale") throw new ToolError("replaced in Obtion meanwhile");
            if (got.hash !== hash) throw new CliError(`the server stored SHA-256 ${got.hash}`);
            state.bundle = { refs: refsHash, hash };
          }
          generated.push({ source: src, title: `${name}.bundle`, status: node ? "updated" : "imported", note: fmtBytes(size) });
        } catch (e) {
          generated.push({ source: src, title: `${name}.bundle`, status: e instanceof ToolError ? "conflict" : "failed", note: (e as Error).message.split("\n")[0] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }

  // 6. proof: everything as it is on the server now
  if (!dry) await saveState();
  const after = dry ? tree : (await client.tree(rootId)).items;
  const now = new Map<string, Node>();
  for (const n of after) if (n.source && !now.has(n.source)) now.set(n.source, n);
  for (const pl of [...plan.values(), ...(rootText ? [{ ...rootText, source: key("") }] : [])]) {
    const row = rows.get(pl.kind === "folder" ? (pl.textPath ?? "") : pl.path);
    if (!row || dry) continue;
    const n = now.get(pl.source);
    if (!n) {
      if (row.status !== "failed") row.status = "failed";
      row.note ??= "not on the server";
      continue;
    }
    row.id = n.id;
    if (pl.kind === "file") {
      row.remote = n.file?.hash;
      row.check = n.file?.hash === pl.hash ? "SHA-256 gleich" : "SHA-256 verschieden";
      if (n.file?.hash !== pl.hash && row.status !== "conflict") row.status = "failed";
    } else {
      const body = n.body ?? "";
      const want = desired.get(pl.source) ?? pl.original!;
      row.remote = sha256(body);
      const same = Buffer.from(body, "utf8").equals(Buffer.from(want, "utf8"));
      const exact = Buffer.from(body, "utf8").equals(Buffer.from(pl.original!, "utf8"));
      row.check = same ? (exact ? "Text Byte für Byte gleich" : "Text gleich (Links umgeschrieben)") : "Text verschieden";
      if (!same && row.status !== "conflict") row.status = "failed";
    }
  }
  // what the repo no longer has: kept in Obtion
  const tracked2 = new Set([...plan.values()].map((p) => p.source));
  const gone = after.filter((n) => n.source?.startsWith(`${key("")}/`) && !tracked2.has(n.source) && !n.source.includes("#"));

  // 7. the report
  const list = [...rows.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const by = (s: Status) => list.filter((r) => r.status === s).length;
  const problems = by("failed") + by("conflict") + generated.filter((g) => g.status === "failed" || g.status === "conflict").length;
  const extRows = new Map<string, { n: number; bytes: number; s: Record<string, number> }>();
  for (const r of list) {
    const e = extRows.get(ext(r.path)) ?? { n: 0, bytes: 0, s: {} };
    e.n++;
    e.bytes += r.size;
    e.s[r.status] = (e.s[r.status] ?? 0) + 1;
    extRows.set(ext(r.path), e);
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const head = git ? run(folder, ["rev-parse", "HEAD"], true).trim() : "";
  const dirty = git ? run(folder, ["status", "--porcelain", "--untracked-files=no"], true).split("\n").filter(Boolean).length : 0;
  const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const report = [
    `# Importbericht ${name} ${today}`,
    "",
    problems ? `**Unvollständig: ${problems} Problem(e)**, siehe Status failed und conflict.` : "**Vollständig:** jede Datei ist da, jeder Hash und jeder Text stimmt.",
    ...(generated.some((g) => g.status === "unavailable")
      ? ["", `Nicht auf diesem Rechner: ${generated.filter((g) => g.status === "unavailable").length} ältere LFS-Fassung(en) aus dem Verlauf (siehe unten); keine davon ist eine aktuelle Datei.`]
      : []),
    "",
    `- Quelle: \`${folder}\`${git ? ` (Git, HEAD \`${head}\`, ${commits.length} Commits${dirty ? `, ${dirty} geänderte Datei(en) im Arbeitsverzeichnis: deren Stand ist importiert` : ""})` : " (Ordner)"}`,
    `- Ziel: [[${rootId}|${(rootNode?.title ?? into).replace(/[|\][]/g, " ")}]], Schlüssel \`${key("")}/<Pfad>\` (\`source\` jedes Elements, \`get\` zeigt ihn, \`search\` findet ihn)`,
    `- ${list.length} Dateien, ${fmtBytes(list.reduce((s, r) => s + r.size, 0))}; neu ${by("imported")}, aktualisiert ${by("updated")}, unverändert ${by("unchanged")}, Konflikt ${by("conflict")}, ignoriert ${by("ignored")}, fehlgeschlagen ${by("failed")}`,
    `- Dauer ${secs} s; ${counts.created} Elemente angelegt, ${counts.uploaded} Dateien hochgeladen, ${counts.updated} Texte geschrieben`,
    "",
    "## Nach Endung",
    "",
    "| Endung | Dateien | Größe | Status |",
    "| --- | ---: | ---: | --- |",
    ...[...extRows]
      .sort((a, b) => b[1].n - a[1].n)
      .map(
        ([e, v]) =>
          `| ${e} | ${v.n} | ${fmtBytes(v.bytes)} | ${Object.entries(v.s)
            .map(([k, n]) => `${k} ${n}`)
            .join(", ")} |`,
      ),
    "",
    "## Verlauf, Bündel, Archiv",
    "",
    ...(generated.length ? generated.map((g) => `- ${g.title}: ${g.status}${g.note ? ` (${g.note})` : ""}`) : ["- (keine)"]),
    "",
    `## Umgeschriebene Links (${allRewrites.length})`,
    "",
    "Original → im Text jetzt; damit lässt sich jeder Text zurückverwandeln.",
    "",
    ...allRewrites.map((x) => `- \`${x.path}\`: \`${cell(x.r.from)}\` → \`${cell(x.r.to)}\``),
    "",
    `## Nicht aufgelöste Links (${unresolved.length})`,
    "",
    ...unresolved.map((u) => `- \`${u.path}\`: \`${cell(u.target)}\``),
    "",
    `## Nicht mehr im Repo, in Obtion behalten (${gone.length})`,
    "",
    ...gone.map((n) => `- \`${n.source}\` → \`${n.id}\``),
    "",
    "## Dateien",
    "",
    "| Pfad | Element | Status | SHA-256 Original | SHA-256 in Obtion | Prüfung | Hinweis |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...list.map((r) => `| ${cell(r.path)} | ${r.id ?? ""} | ${r.status} | ${r.original ?? ""} | ${r.remote ?? ""} | ${r.check ?? ""} | ${cell(r.note)} |`),
    "",
  ].join("\n");
  const reportPath = resolve(opts.report ?? `obtion-import-${name}-${today}.md`);
  if (!dry) {
    writeFileSync(reportPath, report);
    const src = `${key("")}#report:${today}`;
    const node = bySource.get(src);
    try {
      if (node) await client.tool("update", { ref: node.id, body: report, base_version: node.version });
      else await client.tool("create", { items: [{ title: `Importbericht ${name} ${today}`, parents: [rootId], source: src, body: report }] });
    } catch (e) {
      console.error(`The report note could not be written: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  for (const r of list.filter((x) => x.status === "failed" || x.status === "conflict")) console.log(`  ${r.status.padEnd(9)} ${r.path}  (${r.note ?? r.check ?? ""})`);
  for (const g of generated.filter((x) => x.status === "failed" || x.status === "conflict" || x.status === "unavailable")) console.log(`  ${g.status.padEnd(9)} ${g.title}  (${g.note ?? ""})`);
  console.log(
    `${dry ? "Dry run, nothing written: " : ""}${list.length} files: ${by("imported")} new, ${by("updated")} updated, ${by("unchanged")} unchanged, ${by("conflict")} conflict, ${by("ignored")} ignored, ${by("failed")} failed; ${allRewrites.length} links rewritten, ${unresolved.length} unresolved; ${secs} s.${dry ? "" : ` Report: ${reportPath}`}`,
  );
  return problems ? 1 : 0;

  async function saveState() {
    const src = STATE;
    const node = bySource.get(src);
    const file = join(opts.tmp ?? tmpdir(), `obtion-import-${name}-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(state));
    try {
      if (node) {
        const got = await client.replace(node.id, file, node.file!.hash);
        if (got === "stale") throw new CliError("the import state was replaced meanwhile – is another import running?");
        node.file = { ...node.file!, hash: got.hash };
      } else {
        const got = await client.upload(file, `obtion-import-${name}.json`, rootId, src);
        bySource.set(src, {
          id: got.id,
          kind: "file",
          title: "",
          type: null,
          version: "",
          parents: [rootId],
          home: rootId,
          created: 0,
          updated: 0,
          source: src,
          file: { name: "", hash: got.hash, size: got.size, mime: "" },
        });
      }
    } finally {
      rmSync(file, { force: true });
    }
  }
}

/** The mapping config from a JSON file. */
export function readConfig(path: string): ImportConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ImportConfig;
  } catch (e) {
    throw new CliError(`${path}: ${(e as Error).message}`);
  }
}
