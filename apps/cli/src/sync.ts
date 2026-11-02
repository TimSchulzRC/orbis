// pull, status, push: a subtree of Obtion as a folder. Items with children are folders (their own
// text in README.md), informations are <title>.md, files are their originals. The state of the last
// pull (.obtion/state.json) tells local edits from changes in Obtion; nothing local is overwritten.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Client, type Node, type Tree, ToolError, pool, writtenLines } from "./client";
import { CliError } from "./config";
import { type Entry, type State, Ignore, abs, baseOf, decodeUtf8, findRoot, hashFile, loadState, parentOf, readText, saveState, stamp, walk, writeAtomic } from "./local";
import { STATE_DIR, conflictName, nameKey, safeFileName, safeName, uniqueName } from "./names";
import { parseNote, renderNote, sha256 } from "./notes";

/** Where an item goes in the folder. */
export interface Desired {
  path: string;
  key: string;
  kind: Entry["kind"];
  node: Node;
}

/** One key per item and role: its text (note or README.md), its original, its folder. */
export const keyOf = (kind: Entry["kind"], id: string) => `${kind === "note" || kind === "body" ? "t" : kind === "file" ? "f" : "d"}:${id}`;
const isText = (k: Entry["kind"]) => k === "note" || k === "body";
const README = "README.md";

/**
 * The folder layout of a subtree. Each item appears once: below its home if that is in the
 * subtree, else below its first parent there. Names are unique per folder (case-insensitively),
 * the older item keeps the plain name. `known`: keys of the last pull (an emptied README.md stays).
 */
export function layout(tree: Tree, known: Set<string> = new Set()): Desired[] {
  const byId = new Map(tree.items.map((n) => [n.id, n]));
  const root = byId.get(tree.root);
  if (!root) throw new CliError("The server sent no root item.");
  const kids = new Map<string, Node[]>();
  for (const n of tree.items) {
    if (n.id === root.id) continue;
    const ps = n.parents.filter((p) => byId.has(p)).sort();
    const p = n.home && ps.includes(n.home) ? n.home : ps[0];
    if (!p) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(n);
  }
  const out: Desired[] = [];
  const folder = (n: Node, path: string) => {
    const at = (name: string) => (path ? `${path}/${name}` : name);
    out.push({ path, key: keyOf("folder", n.id), kind: "folder", node: n });
    const taken = new Set<string>();
    if (n.kind === "info") {
      taken.add(nameKey(README));
      // an emptied text keeps its README.md if it was pulled: an edit there is then a normal conflict
      if (n.body || known.has(keyOf("body", n.id))) out.push({ path: at(README), key: keyOf("body", n.id), kind: "body", node: n });
    } else if (n.file) out.push({ path: at(uniqueName(safeFileName(n.file.name), taken, true)), key: keyOf("file", n.id), kind: "file", node: n });
    const children = (kids.get(n.id) ?? []).sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
    for (const c of children) {
      if (kids.get(c.id)?.length) folder(c, at(uniqueName(safeName(c.title || c.file?.name || ""), taken, false)));
      else if (c.kind === "file" && c.file) out.push({ path: at(uniqueName(safeFileName(c.file.name), taken, true)), key: keyOf("file", c.id), kind: "file", node: c });
      else if (c.kind === "info") out.push({ path: at(uniqueName(safeName(c.title, ".md"), taken, true)), key: keyOf("note", c.id), kind: "note", node: c });
    }
  };
  folder(root, "");
  return out;
}

/** The hash an entry would have for this remote item (body or content). */
const remoteHash = (d: Desired) => (d.kind === "file" ? d.node.file!.hash : d.kind === "folder" ? undefined : sha256(d.node.body ?? ""));

type Local = "same" | "changed" | "missing";

/** Is the path still what the last pull or push left there? */
async function localOf(dir: string, path: string, e: Entry): Promise<Local> {
  const p = abs(dir, path);
  if (!existsSync(p)) return "missing";
  const st = statSync(p);
  if (e.kind === "folder") return st.isDirectory() ? "same" : "missing";
  if (!st.isFile()) return "missing";
  if (e.kind === "file") {
    if (st.size === e.size && st.mtimeMs === e.mtime) return "same";
    return (await hashFile(p)) === e.hash ? "same" : "changed";
  }
  const t = decodeUtf8(readFileSync(p));
  return t !== undefined && sha256(parseNote(t).body) === e.hash ? "same" : "changed";
}

const noteMeta = (n: Node) => ({ id: n.id, version: n.version, type: n.type, properties: n.properties });

/** Progress and results, one line each; `problems` decide the exit code. */
class Report {
  problems = 0;
  counts = new Map<string, number>();
  constructor(readonly quiet = false) {}
  line(tag: string, path: string, note?: string, problem = false) {
    if (problem) this.problems++;
    this.counts.set(tag, (this.counts.get(tag) ?? 0) + 1);
    if (!this.quiet || problem) console.log(`  ${tag.padEnd(9)} ${path || "."}${note ? `  (${note})` : ""}`);
  }
  summary(prefix: string) {
    const parts = [...this.counts].map(([k, v]) => `${v} ${k}`);
    console.log(`${prefix}${parts.length ? parts.join(", ") : "nothing to do"}.`);
  }
}

/** The folder and its state: from `dir`, or the one at or above the working directory. */
export function openFolder(dir?: string): { dir: string; state: State } {
  const root = findRoot(dir ?? ".");
  const state = root && loadState(root);
  if (!root || !state) throw new CliError(`No pulled folder ${dir ? `at ${dir}` : "here or above"}. Start with: obtion pull <id or title> <folder>`);
  return { dir: root, state };
}

function checkWorkspace(state: State, client: Client) {
  if (state.workspace !== client.cfg.workspace || state.server !== client.cfg.server)
    throw new CliError(
      `This folder belongs to workspace ${state.workspace} on ${state.server}, you are logged in to ${client.cfg.workspace} on ${client.cfg.server}. Log in to that one (or set OBTION_SERVER/OBTION_WORKSPACE).`,
    );
}

export interface PullOptions {
  dryRun?: boolean;
  /** Replace local edits with what Obtion has; the local version is kept as a conflict copy. */
  force?: boolean;
  quiet?: boolean;
}

/** Mirror `ref` into `dir` (first time), or bring a pulled folder up to date. Returns the exit code. */
export async function pull(client: Client, dir: string, ref: string | undefined, opts: PullOptions = {}): Promise<number> {
  let state = loadState(dir);
  if (state) checkWorkspace(state, client);
  const tree = await client.tree(ref ?? state?.root ?? "");
  if (state && tree.root !== state.root) throw new CliError(`${dir} mirrors "${state.title}" [${state.root}], not ${ref}. Pull into another folder.`);
  const rootNode = tree.items.find((n) => n.id === tree.root)!;
  state ??= { format: 1, server: client.cfg.server, workspace: client.cfg.workspace, root: tree.root, title: rootNode.title, entries: {} };
  const entries = state.entries;
  const desired = layout(tree, new Set(Object.values(state.entries).map((e) => keyOf(e.kind, e.id))));
  const wanted = new Map(desired.map((d) => [d.key, d]));
  const atPath = new Map<string, string>(Object.entries(entries).map(([p, e]) => [keyOf(e.kind, e.id), p]));
  const local = new Map<string, Local>();
  for (const [p, e] of Object.entries(entries)) local.set(p, await localOf(dir, p, e));
  const r = new Report(opts.quiet);
  const tmpDir = join(dir, STATE_DIR, "tmp");
  const dry = !!opts.dryRun;

  const backup = (path: string) => {
    const p = abs(dir, path);
    if (!dry && existsSync(p) && statSync(p).isFile()) copyFileSync(p, abs(dir, `${parentOf(path) ? parentOf(path) + "/" : ""}${conflictName(baseOf(path))}`));
  };

  // 1. what leaves its path: removed in Obtion (or moved out of the subtree), or moved within it
  const removals: string[] = []; // files to delete (unchanged here)
  const folderRemovals: string[] = [];
  const skip = new Set<string>(); // keys not written: the local edit stays at the old place
  const movedFrom = new Map<string, string>(); // key → old path, to reuse an unchanged original
  for (const [path, e] of Object.entries(entries)) {
    const d = wanted.get(keyOf(e.kind, e.id));
    if (d?.path === path) continue;
    const ls = local.get(path)!;
    if (e.kind === "folder") {
      folderRemovals.push(path);
      delete entries[path];
      continue;
    }
    if (ls === "changed" && !opts.force) {
      if (d) {
        r.line("kept", path, `moved in Obtion to ${d.path}; your edit stays here`, true);
        skip.add(d.key);
      } else if (!e.gone) {
        r.line("kept", path, "removed in Obtion (or moved out of this folder); your edit stays here", true);
        e.gone = true;
      }
      continue;
    }
    if (ls === "changed") backup(path);
    if (d) movedFrom.set(d.key, path);
    if (ls !== "missing") removals.push(path);
    if (!d) r.line("delete", path, "removed in Obtion");
    delete entries[path];
  }
  const leaving = new Set(removals);

  // 2. what Obtion has
  const writes: { d: Desired; from?: string; note?: string }[] = [];
  for (const d of desired) {
    if (skip.has(d.key)) continue;
    const p0 = atPath.get(d.key);
    const e = p0 === d.path ? entries[d.path] : undefined;
    if (e) {
      const ls = local.get(d.path)!;
      if (d.kind === "folder") {
        e.version = d.node.version;
        continue;
      }
      const changed = d.kind === "file" ? d.node.file!.hash !== e.hash : d.node.version !== e.version;
      const contentChanged = remoteHash(d) !== e.hash;
      if (ls === "same") {
        if (changed) writes.push({ d, note: "changed in Obtion" });
      } else if (ls === "changed") {
        if (contentChanged && opts.force) (backup(d.path), writes.push({ d, note: "your edit is in the conflict copy" }));
        else if (contentChanged)
          r.line(
            "conflict",
            d.path,
            e.theirs ? `waiting for your merge of ${conflictName(baseOf(d.path))}` : "changed here and in Obtion; yours is kept – push writes Obtion's version next to it",
            true,
          );
        else {
          if (isText(d.kind)) e.version = d.node.version; // only title or properties changed: your edit can still go up
          r.line("kept", d.path, "local edit, not pushed yet");
        }
      } else if (opts.force) writes.push({ d, note: "deleted here, restored" });
      else r.line("kept", d.path, "deleted here; push --delete moves it to the trash, pull --force restores it");
      continue;
    }
    // new here: first pull, new in Obtion, or moved
    const occupant = entries[d.path];
    if (occupant && !leaving.has(d.path)) {
      r.line("blocked", d.path, `${d.kind === "folder" ? "folder" : "file"} of another item is still here (local edit); not written`, true);
      continue;
    }
    const p = abs(dir, d.path);
    if (d.kind === "folder") {
      if (existsSync(p) && !statSync(p).isDirectory()) {
        r.line("blocked", d.path, "a file is in the way of this folder", true);
        continue;
      }
      if (!existsSync(p) && !dry) mkdirSync(p, { recursive: true });
      entries[d.path] = { id: d.node.id, kind: "folder", version: d.node.version };
      continue;
    }
    if (existsSync(p) && !leaving.has(d.path)) {
      // a file nobody pulled is already there: it is never overwritten; it counts as a local edit of this item
      if (!statSync(p).isFile()) {
        r.line("blocked", d.path, "a folder is in the way", true);
        continue;
      }
      const text = d.kind === "file" ? undefined : decodeUtf8(readFileSync(p));
      const same = d.kind === "file" ? (await hashFile(p)) === d.node.file!.hash : text !== undefined && sha256(parseNote(text).body) === remoteHash(d);
      entries[d.path] = { id: d.node.id, kind: d.kind, version: d.node.version, hash: remoteHash(d), ...(d.kind === "file" && same ? stamp(p) : {}) };
      if (same && isText(d.kind) && !dry) writeAtomic(p, renderNote(noteMeta(d.node), d.node.body ?? ""));
      r.line(same ? "adopted" : "kept", d.path, same ? "already here" : "a different file was already here; it counts as a local edit of this item");
      continue;
    }
    writes.push({ d, from: movedFrom.get(d.key), note: movedFrom.has(d.key) ? `moved from ${movedFrom.get(d.key)}` : undefined });
  }

  // 3. carry out: set moved originals aside, delete, write, remove empty folders
  const reuse = new Map<string, string>();
  if (!dry) {
    mkdirSync(tmpDir, { recursive: true });
    for (const w of writes)
      if (w.from && w.d.kind === "file" && leaving.has(w.from) && (await hashFile(abs(dir, w.from))) === w.d.node.file!.hash) {
        const t = join(tmpDir, `move-${w.d.node.id}`);
        renameSync(abs(dir, w.from), t);
        reuse.set(w.d.key, t);
        leaving.delete(w.from);
      }
    for (const path of removals) if (leaving.has(path)) rmSync(abs(dir, path), { force: true });
  }
  const write = async (w: { d: Desired; from?: string; note?: string }) => {
    const { d } = w;
    const p = abs(dir, d.path);
    r.line(w.note === "changed in Obtion" ? "update" : w.from ? "move" : "new", d.path, w.note);
    if (dry) return;
    if (d.kind === "file") {
      const t = reuse.get(d.key);
      if (t) (mkdirSync(abs(dir, parentOf(d.path)), { recursive: true }), renameSync(t, p));
      else await client.download(d.node.id, p, join(tmpDir, d.node.id), d.node.file!.hash);
      entries[d.path] = { id: d.node.id, kind: "file", version: d.node.version, hash: d.node.file!.hash, ...stamp(p) };
    } else {
      writeAtomic(p, renderNote(noteMeta(d.node), d.node.body ?? ""));
      entries[d.path] = { id: d.node.id, kind: d.kind, version: d.node.version, hash: remoteHash(d) };
    }
  };
  const failed: string[] = [];
  const guarded = async (w: { d: Desired; from?: string; note?: string }) => {
    try {
      await write(w);
    } catch (e) {
      failed.push(w.d.path);
      r.line("failed", w.d.path, (e as Error).message, true);
    }
  };
  for (const w of writes.filter((w) => w.d.kind !== "file")) await guarded(w);
  await pool(
    writes.filter((w) => w.d.kind === "file"),
    4,
    guarded,
  );
  for (const path of folderRemovals.sort((a, b) => b.length - a.length)) {
    const p = abs(dir, path);
    if (!path || !existsSync(p) || entries[path]?.kind === "folder") continue; // another item's folder took the name
    if (readdirSync(p).length === 0) {
      if (!dry) rmdirSync(p);
      r.line("delete", `${path}/`, "folder no longer here in Obtion");
    } else if (!Object.keys(entries).some((k) => k.startsWith(`${path}/`))) r.line("kept", `${path}/`, "folder not empty (files of your own)");
  }
  if (!dry) {
    rmSync(tmpDir, { recursive: true, force: true });
    state.title = rootNode.title;
    state.pulled = new Date().toISOString();
    saveState(dir, state);
  }
  r.summary(dry ? "Dry run, nothing written: " : `Pulled "${rootNode.title}" into ${dir}: `);
  return r.problems ? 1 : 0;
}

/** Local changes since the last pull or push. */
interface Scan {
  local: Map<string, Local>;
  added: string[];
  addedDirs: string[];
  /** new path → old path: a note (by its id) or an original (by its hash) that moved here. */
  moved: Map<string, string>;
}

async function scan(dir: string, state: State): Promise<Scan> {
  const local = new Map<string, Local>();
  for (const [p, e] of Object.entries(state.entries)) local.set(p, await localOf(dir, p, e));
  const { files, dirs } = walk(dir, Ignore.of(dir));
  const added = files.filter((f) => !state.entries[f]);
  const addedDirs = dirs.filter((d) => !state.entries[d]);
  const moved = new Map<string, string>();
  const missing = Object.entries(state.entries).filter(([p, e]) => e.kind !== "folder" && local.get(p) === "missing");
  for (const f of [...added]) {
    let from: string | undefined;
    if (f.toLowerCase().endsWith(".md")) {
      const t = decodeUtf8(readFileSync(abs(dir, f)));
      const id = t === undefined ? undefined : parseNote(t).id;
      from = id ? missing.find(([, e]) => e.id === id && isText(e.kind))?.[0] : undefined;
    } else {
      const cands = missing.filter(([, e]) => e.kind === "file" && e.size === statSync(abs(dir, f)).size);
      if (cands.length) {
        const h = await hashFile(abs(dir, f));
        from = cands.find(([, e]) => e.hash === h)?.[0];
      }
    }
    if (from && ![...moved.values()].includes(from)) {
      moved.set(f, from);
      added.splice(added.indexOf(f), 1);
    }
  }
  return { local, added, addedDirs, moved };
}

/** What changed here and in Obtion since the last pull. */
export async function status(client: Client | undefined, dir: string, state: State): Promise<number> {
  const s = await scan(dir, state);
  const movedFrom = new Set(s.moved.values());
  const lines: string[] = [];
  for (const [p, e] of Object.entries(state.entries)) {
    const ls = s.local.get(p);
    if (e.kind === "folder") {
      if (ls === "missing" && p) lines.push(`  deleted   ${p}/`);
      continue;
    }
    if (ls === "changed") lines.push(`  modified  ${p}${e.gone ? "  (removed in Obtion)" : ""}`);
    if (ls === "missing" && !movedFrom.has(p)) lines.push(`  deleted   ${p}`);
  }
  for (const [to, from] of s.moved) lines.push(`  moved     ${from} → ${to}  (not pushed: move it in Obtion)`);
  for (const d of s.addedDirs) lines.push(`  new       ${d}/`);
  for (const f of s.added) lines.push(`  new       ${f}`);
  console.log(lines.length ? `Local changes since the last pull:\n${lines.join("\n")}` : "No local changes.");
  if (!client) return 0;
  checkWorkspace(state, client);
  const tree = await client.tree(state.root);
  const desired = layout(tree, new Set(Object.values(state.entries).map((e) => keyOf(e.kind, e.id))));
  const wanted = new Map(desired.map((d) => [d.key, d]));
  const remote: string[] = [];
  const known = new Set<string>();
  for (const [p, e] of Object.entries(state.entries)) {
    const key = keyOf(e.kind, e.id);
    known.add(key);
    const d = wanted.get(key);
    if (!d) {
      if (e.kind !== "folder" || !tree.items.some((n) => n.id === e.id)) remote.push(`  removed   ${p}${e.kind === "folder" ? "/" : ""}`);
      continue;
    }
    if (d.path !== p) remote.push(`  moved     ${p} → ${d.path}`);
    if (e.kind !== "folder" && remoteHash(d) !== e.hash) remote.push(`  changed   ${d.path}`);
  }
  for (const d of desired) if (!known.has(d.key) && d.path) remote.push(`  new       ${d.path}${d.kind === "folder" ? "/" : ""}`);
  console.log(remote.length ? `Changes in Obtion since the last pull:\n${remote.join("\n")}` : "No changes in Obtion.");
  return 0;
}

export interface PushOptions {
  dryRun?: boolean;
  /** Send local deletions: the items go to the trash. */
  delete?: boolean;
}

/** Send local changes: edited notes (with base_version), new notes and folders, new and changed files. */
export async function push(client: Client, dir: string, state: State, opts: PushOptions = {}): Promise<number> {
  checkWorkspace(state, client);
  const dry = !!opts.dryRun;
  const entries = state.entries;
  const s = await scan(dir, state);
  const tree = await client.tree(state.root);
  const nodes = new Map(tree.items.map((n) => [n.id, n]));
  const r = new Report();
  let ops = 0;
  const saved = () => {
    if (!dry && ++ops % 50 === 0) saveState(dir, state);
  };

  // the state is written whatever happens: what went up must never go up a second time
  try {
    const copyOf = (path: string) => `${parentOf(path) ? parentOf(path) + "/" : ""}${conflictName(baseOf(path))}`;
    /** Obtion's current text or original next to the local file, for the user to merge; remembers which version it was. */
    const conflict = async (path: string, e: Entry, what: string) => {
      const copy = copyOf(path);
      if (!dry) {
        const now = (await client.items([e.id]))[0];
        if (now?.kind === "file") await client.download(e.id, abs(dir, copy), join(dir, STATE_DIR, "tmp", e.id), now.file!.hash);
        else if (now) writeAtomic(abs(dir, copy), renderNote(noteMeta(now), now.body ?? ""));
        e.theirs = now?.kind === "file" ? now.file!.hash : now?.version;
      }
      r.line("conflict", path, `${what} since your pull; yours is kept, Obtion's is in ${copy}. Merge it into ${baseOf(path)}, delete the copy, push again`, true);
    };
    /** A conflict copy still there: not merged yet. */
    const unresolved = (path: string, e: Entry) => {
      if (!e.theirs || !existsSync(abs(dir, copyOf(path)))) return false;
      r.line("conflict", path, `not resolved: merge ${copyOf(path)} into it and delete the copy`, true);
      return true;
    };

    /** Replace a body with base_version; a stale one keeps the local file and writes the conflict copy. */
    /** `write`: put the file back with the new version (not when the README.md was deleted). */
    const sendBody = async (path: string, e: Entry, body: string, verb = "update", write = true) => {
      const node = nodes.get(e.id);
      if (!node || e.gone) return r.line("skipped", path, "removed in Obtion; nothing sent", true);
      if (unresolved(path, e)) return;
      // merged after a conflict: based on the version in the copy; only title or properties changed in
      // Obtion: the body you edited is still the one there
      const base = e.theirs ?? (node.version !== e.version && sha256(node.body ?? "") === e.hash ? node.version : e.version);
      if (dry) return r.line(verb, path);
      try {
        const answer = await client.tool("update", { ref: e.id, body, base_version: base });
        const v = writtenLines(answer)[0]?.version;
        e.version = v ?? e.version;
        e.hash = sha256(body);
        delete e.theirs;
        if (write) writeAtomic(abs(dir, path), renderNote({ ...noteMeta(node), version: e.version! }, body));
        r.line(verb, path);
        saved();
      } catch (err) {
        if (!(err instanceof ToolError) || !err.stale) throw err;
        await conflict(path, e, "changed in Obtion");
      }
    };

    // 1. edited notes and files; moves are not sent, but an edited moved note is
    for (const [to, from] of s.moved) {
      const e = entries[from]!;
      r.line("moved", `${from} → ${to}`, "not moved in Obtion – pull puts it back, or move it in Obtion");
      if (dry) continue;
      delete entries[from];
      entries[to] = e;
      s.local.set(to, await localOf(dir, to, e));
    }
    const failed = (path: string, e: unknown) => r.line("failed", path, (e as Error).message, true);
    for (const [path, e] of Object.entries(entries)) {
      if (s.local.get(path) !== "changed") continue;
      try {
        if (isText(e.kind)) await sendBody(path, e, parseNote(readText(abs(dir, path))).body);
        else if (e.kind === "file") {
          const node = nodes.get(e.id);
          if (!node || e.gone) r.line("skipped", path, "removed in Obtion; nothing sent", true);
          else if (unresolved(path, e)) continue;
          else if (node.file?.hash !== (e.theirs ?? e.hash)) await conflict(path, e, "replaced in Obtion");
          else {
            if (dry) {
              r.line("update", path);
              continue;
            }
            const p = abs(dir, path);
            const local = await hashFile(p);
            const got = await client.replace(e.id, p, e.theirs ?? e.hash!);
            if (got === "stale") {
              await conflict(path, e, "replaced in Obtion");
              continue;
            }
            if (got.hash !== local) throw new CliError(`the server stored SHA-256 ${got.hash}, the file has ${local}`);
            Object.assign(e, { hash: got.hash, ...stamp(p) });
            delete e.theirs;
            r.line("update", path);
            saved();
          }
        }
      } catch (err) {
        failed(path, err);
      }
    }

    // 2. new folders (parents first), new notes, a new README.md as the text of its folder's item
    const folderId = new Map<string, string>(
      Object.entries(entries)
        .filter(([, e]) => e.kind === "folder")
        .map(([p, e]) => [p, e.id]),
    );
    const parentId = (path: string) => folderId.get(parentOf(path));
    const isInfoFolder = (path: string) => {
      const id = folderId.get(path);
      return !!id && (nodes.get(id)?.kind ?? "info") === "info";
    };
    for (const d of s.addedDirs.sort((a, b) => a.split("/").length - b.split("/").length)) {
      const files = s.added.filter((f) => f.startsWith(`${d}/`));
      if (!files.length) continue; // empty folders stay local
      const pid = parentId(d);
      if (!pid) {
        r.line("skipped", `${d}/`, "its parent folder was not created", true);
        continue;
      }
      // a folder named like a note next to it ("X/" next to "X.md") goes below that note
      const sibling = Object.entries(entries).find(([p, e]) => e.kind === "note" && parentOf(p) === parentOf(d) && nameKey(p) === nameKey(`${d}.md`));
      if (sibling) {
        folderId.set(d, sibling[1].id);
        if (!dry) entries[d] = { id: sibling[1].id, kind: "folder", version: sibling[1].version };
        r.line("folder", `${d}/`, `below ${sibling[0]}`);
        const readme = files.find((f) => f === `${d}/${README}`);
        if (readme) {
          r.line("skipped", readme, `${sibling[0]} is that item's text; merge it there`, true);
          s.added.splice(s.added.indexOf(readme), 1);
        }
        continue;
      }
      const readme = files.find((f) => f === `${d}/${README}`);
      if (readme) s.added.splice(s.added.indexOf(readme), 1);
      try {
        const body = readme ? parseNote(readText(abs(dir, readme))).body : undefined;
        r.line("new", `${d}/`, readme ? "with README.md as its text" : undefined);
        if (dry) {
          folderId.set(d, "(new)");
          continue;
        }
        const answer = await client.tool("create", { items: [{ title: baseOf(d), parents: [pid], ...(body ? { body } : {}) }] });
        const made = writtenLines(answer)[0];
        if (!made) throw new CliError(`unexpected answer: ${answer.slice(0, 200)}`);
        folderId.set(d, made.id);
        entries[d] = { id: made.id, kind: "folder", version: made.version };
        if (readme) {
          entries[readme] = { id: made.id, kind: "body", version: made.version, hash: sha256(body!) };
          writeAtomic(abs(dir, readme), renderNote({ id: made.id, version: made.version! }, body!));
        }
        saved();
      } catch (err) {
        failed(`${d}/`, err);
      }
    }
    const uploads: string[] = [];
    for (const f of s.added) {
      const pid = parentId(f);
      if (!pid) {
        r.line("skipped", f, "its folder was not created", true);
        continue;
      }
      if (!f.toLowerCase().endsWith(".md")) {
        uploads.push(f);
        continue;
      }
      try {
        const text = readText(abs(dir, f));
        const body = parseNote(text).body;
        const textAt = baseOf(f) === README ? Object.entries(entries).find(([, e]) => isText(e.kind) && e.id === pid) : undefined;
        if (textAt) {
          r.line("skipped", f, `${textAt[0]} is that item's text; merge it there`, true);
          continue;
        }
        if (baseOf(f) === README && isInfoFolder(parentOf(f))) {
          // the folder's item had no text yet: README.md becomes it
          // (its text was empty at the pull; if it isn't now, that is a conflict)
          const be: Entry = { id: pid, kind: "body", version: entries[parentOf(f)]!.version, hash: sha256("") };
          await sendBody(f, be, body, "new");
          if (!dry && (be.hash === sha256(body) || be.theirs)) entries[f] = be; // a conflict keeps the baseline and Obtion's version
          continue;
        }
        const title = baseOf(f).replace(/\.md$/i, "");
        r.line("new", f);
        if (dry || pid === "(new)") continue;
        const answer = await client.tool("create", { items: [{ title, parents: [pid], ...(body ? { body } : {}) }] });
        const made = writtenLines(answer)[0];
        if (!made) throw new CliError(`unexpected answer: ${answer.slice(0, 200)}`);
        entries[f] = { id: made.id, kind: "note", version: made.version, hash: sha256(body) };
        writeAtomic(abs(dir, f), renderNote({ id: made.id, version: made.version! }, body));
        saved();
      } catch (err) {
        failed(f, err);
      }
    }
    await pool(uploads, 4, async (f) => {
      r.line("new", f);
      const pid = parentId(f)!;
      if (dry || pid === "(new)") return;
      try {
        const p = abs(dir, f);
        const local = await hashFile(p);
        const got = await client.upload(p, baseOf(f), pid);
        if (got.hash !== local) throw new CliError(`the server stored SHA-256 ${got.hash}, the file has ${local}`);
        entries[f] = { id: got.id, kind: "file", hash: got.hash, ...stamp(p) };
        saved();
      } catch (err) {
        failed(f, err);
      }
    });

    // 3. deletions: only with --delete, only what is unchanged in Obtion, deepest first
    const gone = Object.entries(entries)
      .filter(([p, e]) => s.local.get(p) === "missing" && p !== "")
      .sort((a, b) => b[0].split("/").length - a[0].split("/").length);
    for (const [path, e] of gone) {
      const node = nodes.get(e.id);
      const label = e.kind === "folder" ? `${path}/` : path;
      if (!opts.delete) {
        r.line("deleted", label, "not sent; push --delete moves it to the trash");
        continue;
      }
      if (!node) {
        r.line("delete", label, "already gone in Obtion");
        if (!dry) delete entries[path];
        continue;
      }
      // the same item still has a path here (the folder X/ of the note X.md): only this path is dropped
      const kept = Object.entries(entries).find(([p, x]) => p !== path && x.id === e.id && isText(x.kind) && s.local.get(p) !== "missing");
      if (kept) {
        r.line("deleted", label, `only here; the item stays, it is still ${kept[0]}`);
        if (!dry) delete entries[path];
        continue;
      }
      const folderGone = e.kind === "body" && s.local.get(parentOf(path)) === "missing";
      try {
        if (e.kind === "body" && !folderGone) {
          // README.md deleted, folder kept: the item's text is emptied
          await sendBody(path, e, "", "empty", false);
          if (!dry && sha256("") === e.hash) delete entries[path];
          continue;
        }
        if (e.kind === "body") continue; // the folder's entry deletes the item
        const changed = e.kind === "file" ? node.file?.hash !== e.hash : node.version !== e.version;
        if (changed) {
          r.line("skipped", label, "changed in Obtion since your pull; not deleted", true);
          continue;
        }
        r.line("trash", label);
        if (dry) continue;
        await client.tool("delete", { ref: e.id });
        delete entries[path];
        if (e.kind === "folder" && entries[`${path}/${README}`]?.id === e.id) delete entries[`${path}/${README}`];
        saved();
      } catch (err) {
        failed(label, err);
      }
    }
  } finally {
    if (!dry) saveState(dir, state);
  }
  r.summary(dry ? "Dry run, nothing sent: " : "Pushed: ");
  return r.problems ? 1 : 0;
}
