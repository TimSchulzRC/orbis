// Read-only Markdown mirror in data/vault, for backup, grep, git and file-based agents.
// Changes made there get overwritten.
import { existsSync, linkSync, copyFileSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Item, META_TYPE, optionNames } from "@obtion/core/model";
import { workspaceRules } from "@obtion/core/rules";
import type { Index } from "@obtion/core/graph";
import { blocksAsText } from "@obtion/core/query";
import { isInInbox } from "@obtion/core/placement";
import { type Lang, translate } from "@obtion/core/i18n";
import type { Store } from "./store";
import type { Blobs } from "./blobs";
import { excalidrawFile, readScene } from "@obtion/core/drawing";

/** Records change in bursts (typing, imports): the first change starts the timer, and one write covers everything until it fires. */
const SYNC_DELAY_MS = 1500;
const README = "# Obtion mirror\n\nGenerated from the Obtion database: every information as Markdown below its home. Read freely; changes made here are overwritten. To change data, use the app or the MCP tools.\n";

export class Mirror {
  private files = new Map<string, string>(); // relative path -> content signature
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private store: Store,
    private root: string,
    private blobs?: Blobs,
  ) {}

  start() {
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
    this.sync();
    this.store.on({ record: () => this.schedule() });
    if (this.blobs) {
      const prev = this.blobs.onStored;
      this.blobs.onStored = (h) => (prev?.(h), this.schedule());
    }
  }

  private stopped = false;

  private schedule() {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.safeSync();
    }, SYNC_DELAY_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private safeSync() {
    try {
      this.sync();
    } catch (e) {
      console.error("[mirror]", e);
    }
  }

  sync() {
    const ix = this.store.index();
    const lang = this.store.lang();
    const want = new Map<string, { content?: string; blob?: string }>();
    const used = new Set<string>();
    const unique = (path: string, id: string) => {
      let p = path;
      if (used.has(p.toLowerCase())) p = p.replace(/(\.[^./]+)$/, ` (${id.slice(-6)})$1`);
      used.add(p.toLowerCase());
      return p;
    };
    const folderOf = (i: Item): string => {
      const path = ix.homePath(i.id).map((id) => safe(ix.get(id)!.title));
      if (path.length) return path.join("/");
      if (i.pinned) return "."; // pinned items without a parent sit at the top of the mirror
      if (i.type === META_TYPE) return lang === "de" ? "_Typen" : "_Types";
      if (isInInbox(i, ix)) return translate(lang, "nav.inbox");
      const tn = ix.typeName(i.type);
      if (tn) return safe(tn);
      return lang === "de" ? "Ohne Ort" : "No place";
    };
    const pathOf = (i: Item, name: string) => unique(`${folderOf(i)}/${name}`.replace(/^\.\//, ""), i.id);
    for (const i of ix.live) {
      if (i.kind === "datei" && i.file) {
        want.set(pathOf(i, safe(i.file.name)), { blob: i.file.hash });
        continue;
      }
      // a drawing as a file Excalidraw opens (its images are blobs and stay out)
      if (i.kind === "zeichnung") {
        want.set(pathOf(i, `${translate(lang, "kind.drawing")}.excalidraw`), { content: excalidrawFile(readScene(this.store.getDoc(i.id))) });
        continue;
      }
      // children go into a folder named after this item (folder-note style)
      want.set(pathOf(i, `${safe(i.title)}.md`), { content: this.render(i, ix, lang) });
    }
    const ws = workspaceRules(ix);
    const rulesHead = translate(lang, "rules.title");
    want.set("README.md", {
      content:
        README +
        `\n## ${rulesHead}\n\nBinding for agents. A page's "${rulesHead}" section applies to it and everything below it.${ws ? ` These apply to the whole workspace:\n\n${ws.text.trimEnd()}\n` : "\n"}`,
    });

    for (const [rel, w] of want) {
      const sig = w.content ?? "blob:" + w.blob;
      if (this.files.get(rel) === sig) continue;
      const abs = join(this.root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      if (w.content !== undefined) writeFileSync(abs, w.content);
      else if (!this.linkBlob(w.blob!, abs)) continue; // content not on the server yet
      this.files.set(rel, sig);
    }
    for (const rel of [...this.files.keys()]) {
      if (want.has(rel)) continue;
      const abs = join(this.root, rel);
      if (existsSync(abs)) unlinkSync(abs);
      this.files.delete(rel);
      pruneEmpty(dirname(abs), this.root);
    }
  }

  /** False if the content is not on the server. */
  private linkBlob(hash: string, abs: string): boolean {
    if (!this.blobs?.has(hash)) return false;
    if (existsSync(abs)) unlinkSync(abs);
    try {
      linkSync(this.blobs.path(hash), abs);
    } catch {
      copyFileSync(this.blobs.path(hash), abs);
    }
    return true;
  }

  render(i: Item, ix: Index, lang: Lang): string {
    const schema = ix.schemaOf(i);
    const fm: Record<string, unknown> = { id: i.id };
    if (i.type === META_TYPE && i.schema) fm.kind = "type";
    else fm.type = ix.typeName(i.type);
    if (isInInbox(i, ix)) fm.inbox = true;
    if (i.pinned) fm.pinned = true;
    const parents = ix.parentsOf(i.id);
    if (parents.length) fm.part_of = parents.map((p) => `[[${ix.get(p)!.title}]]`);
    for (const p of schema?.properties ?? []) {
      const v = i.props[p.id];
      if (p.kind === "relation") {
        const ids = ix.relValues(i, p.id, p.symmetric);
        if (ids.length) fm[p.name] = ids.map((x) => `[[${ix.get(x)?.title}]]`);
      } else if (p.kind === "computed") {
        const pr = ix.progress(i.id, p.computed?.of);
        if (p.computed?.fn === "count") fm[p.name] = ix.countDescendants(i.id, p.computed.of);
        else if (pr.total) fm[p.name] = `${pr.done}/${pr.total}`;
      } else if (v !== undefined) fm[p.name] = p.options ? optionNames(p, v) : v;
    }
    for (const [k, v] of Object.entries(i.extra)) fm[k] = v.v;
    if (i.tags.length) fm.tags = i.tags;
    if (i.aliases.length) fm.aliases = i.aliases;
    if (i.refs.length) fm.refs = i.refs.map((r) => `[[${ix.get(r)?.title ?? r}]]`);
    fm.created = new Date(i.created).toISOString();
    fm.updated = new Date(i.updated).toISOString();
    let out = frontmatter(fm);
    if (i.schema && i.type === META_TYPE) {
      out += `${i.schema.description}\n\n## Properties\n\n` + i.schema.properties.map((p) => `- ${p.name} (${p.kind})${p.options ? ": " + p.options.map((o) => o.name).join(", ") : ""}`).join("\n") + "\n";
      return out;
    }
    out += blocksAsText(i.body, lang, ix).trimEnd() + "\n";
    if (i.rules.trim()) out += `\n## ${translate(lang, "rules.title")}\n\n${i.rules.trimEnd()}\n`;
    const kids = ix.childrenOf(i.id).map((c) => ix.get(c)!);
    if (kids.length) out += `\n## ${translate(lang, "below.title")}\n\n` + kids.map((k) => `- [[${k.title}]]${ix.typeName(k.type) ? ` (${ix.typeName(k.type)})` : ""}`).join("\n") + "\n";
    if (i.updates.length) out += "\n## Updates\n\n" + i.updates.map((e) => `- ${new Date(e.at).toISOString().slice(0, 16).replace("T", " ")} (${e.by}): ${e.text}`).join("\n") + "\n";
    return out;
  }
}

function frontmatter(fields: Record<string, unknown>): string {
  let out = "---\n";
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const key = /^[\w-]+$/.test(k) ? k : JSON.stringify(k);
    if (Array.isArray(v)) out += `${key}:\n${v.map((x) => `  - ${yaml(String(x))}`).join("\n")}\n`;
    else out += `${key}: ${yaml(String(v))}\n`;
  }
  return out + "---\n\n";
}

function safe(title: string) {
  return (title || "Untitled").replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";
}

function yaml(s: string) {
  return /^[\w ./@()&+,–-]*$/.test(s) && !/^\s|\s$/.test(s) && s !== "" ? s : JSON.stringify(s);
}

function pruneEmpty(dir: string, root: string) {
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (readdirSync(dir).length) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}
