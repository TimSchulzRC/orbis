// Links in imported Markdown: relative links and mentions of tracked files become [[id|label]].
// Nothing else in the text changes; code blocks, URLs and existing [[links]] stay as they are.
import { posix } from "node:path";

export interface Rewrite {
  from: string;
  to: string;
}

export interface LinkResult {
  text: string;
  rewrites: Rewrite[];
  /** Relative link targets (and backticked paths) that match no tracked file or folder. */
  unresolved: string[];
}

/** Finds the item of a repo path ("a/b.md", "a/" for folders); `self`: the note being rewritten. */
export interface Targets {
  /** Path (file or folder, without trailing "/") → item id. */
  byPath: Map<string, string>;
  /** Base name → item id, only for names that occur once. */
  byName: Map<string, string>;
  /** The last two or more segments of a path ("bic/a.pdf") → item id, only where they occur once. */
  bySuffix?: Map<string, string>;
}

/** Every tail of two or more segments that ends exactly one path. */
export function suffixes(paths: Iterable<[string, string]>): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const [p, id] of paths) {
    const parts = p.split("/");
    for (let i = 1; parts.length - i >= 2; i++) {
      const k = parts.slice(i).join("/");
      seen.set(k, seen.has(k) && seen.get(k) !== id ? null : id);
    }
  }
  return new Map([...seen].filter((e): e is [string, string] => e[1] !== null));
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** One thing per match: [[wiki]], `code`, [md](link), <html>/<autolink>, a URL, a path-like word. */
const INLINE =
  /(!?\[\[[^\]\n]*\]\])|(`+)([^`\n]+?)\2(?!`)|(!?)\[((?:\\.|[^\]\\\n])*)\]\(\s*(<[^>\n]*>|[^)\s]+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)|(<[^>\n]*>)|([a-zA-Z][\w+.-]*:\/\/[^\s)>\]]+|[\w.+-]+@[\w-]+\.[\w.-]+)|(?<![\p{L}\p{N}_\-./\\])((?:\.{0,2}\/)?(?:[\p{L}\p{N}_\-.]+\/)*[\p{L}\p{N}_\-.]+\.[\p{L}\p{N}]{1,10}|(?:[\p{L}\p{N}_\-.]+\/)+)(?![\p{L}\p{N}_\-/])/gu;
/** Characters a [[link]] label can't hold. */
const BAD_LABEL = /[\]|\n[]/;

function decode(target: string): string {
  const t = target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

/**
 * `from`: the note's own repo path (README.md of a folder: the README's path). `selfId`: its item –
 * links to itself stay as they are.
 */
export function rewriteLinks(body: string, from: string, selfId: string | undefined, t: Targets): LinkResult {
  const dir = posix.dirname(from) === "." ? "" : posix.dirname(from);
  const rewrites: Rewrite[] = [];
  const unresolved: string[] = [];

  /** A path relative to the note, or from the repo's root, or a unique base name. */
  const find = (raw: string, names: boolean): string | undefined => {
    const p = raw.replace(/\/+$/, "");
    if (!p || p.startsWith("/")) return undefined;
    const rel = posix.normalize(posix.join(dir, p));
    if (!rel.startsWith("../")) {
      const id = t.byPath.get(rel === "." ? "" : rel);
      if (id) return id;
    }
    const root = posix.normalize(p);
    if (!root.startsWith("../") && t.byPath.has(root)) return t.byPath.get(root);
    if (names && !p.includes("/")) return t.byName.get(p);
    if (names) return t.bySuffix?.get(root);
    return undefined;
  };
  const link = (embed: string, id: string, anchor: string, label: string) => `${embed}[[${id}${anchor}${label ? `|${label}` : ""}]]`;

  const lines = body.split(/(?<=\n)/);
  let fence: string | undefined;
  const out = lines.map((line) => {
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = undefined;
      return line;
    }
    if (f) {
      fence = f;
      return line;
    }
    if (/^\s{0,3}\[[^\]]+\]:\s/.test(line)) return line; // a reference definition
    // a table row (with or without a leading |): the | of [[id|label]] would split its cell; indented code
    if (line.includes("|") || /^( {4}|\t)/.test(line)) return line;
    return line.replace(INLINE, (m, wiki, ticks, code, bang, label, target, _title, html, url, word) => {
      if (wiki || html || url) return m;
      if (ticks) {
        const c = (code as string).trim();
        if (!/[./]/.test(c) || /\s/.test(c)) return m;
        const id = find(c, true);
        if (!id) {
          // a path into the repo that matches nothing (not a URL, not ~/… or /…)
          if (c.includes("/") && /\.[\p{L}\p{N}]{1,10}$/u.test(c) && !/^([a-zA-Z][\w+.-]*:|~|\/)/.test(c)) unresolved.push(c);
          return m;
        }
        if (id === selfId || BAD_LABEL.test(c)) return m;
        const to = link("", id, "", c);
        rewrites.push({ from: m, to });
        return to;
      }
      if (target !== undefined) {
        const tgt = decode(target as string);
        if (/^[a-zA-Z][\w+.-]*:/.test(tgt) || tgt.startsWith("#") || tgt.startsWith("/")) return m;
        const hash = tgt.indexOf("#");
        const path = hash >= 0 ? tgt.slice(0, hash) : tgt;
        const anchor = hash >= 0 ? tgt.slice(hash) : "";
        const id = find(path, false);
        if (!id) {
          unresolved.push(tgt);
          return m;
        }
        const lbl = (label as string).replace(/\\(.)/g, "$1");
        if (id === selfId || BAD_LABEL.test(lbl) || /[|\]\n]/.test(anchor)) return m;
        const to = link(bang as string, id, anchor, lbl);
        rewrites.push({ from: m, to });
        return to;
      }
      if (word) {
        const id = find(word as string, true);
        if (!id || id === selfId || BAD_LABEL.test(word as string)) return m;
        const to = link("", id, "", word as string);
        rewrites.push({ from: m, to });
        return to;
      }
      return m;
    });
  });
  return { text: out.join(""), rewrites, unresolved };
}
