// A note on disk: a small front matter block of our own (id, version, type, a few properties to
// read) followed by the body exactly as Obtion has it – CRLF, a body's own front matter, all bytes.
import { createHash } from "node:crypto";

/** Our block starts the file and names the id first; a body's own "---" block stays body. */
const OURS = /^---\r?\nobtion_id: [^\r\n]*\r?\n(?:[^\r\n]*\r?\n)*?---(?:\r?\n|$)/;

const scalar = (v: unknown) => (typeof v === "string" && /^[\w.-]+$/.test(v) && !/^(true|false|null|yes|no|~|[\d.eE+-]+)$/i.test(v) ? v : JSON.stringify(v));
const key = (k: string) => (/^[A-Za-zÄÖÜäöüß][\wÄÖÜäöüß -]*$/.test(k) && !k.endsWith(" ") ? k : JSON.stringify(k));

export interface NoteMeta {
  id: string;
  version: string;
  type?: string | null;
  properties?: Record<string, unknown>;
}

export function renderNote(meta: NoteMeta, body: string): string {
  const lines = [`obtion_id: ${meta.id}`, `obtion_version: ${meta.version}`];
  if (meta.type) lines.push(`type: ${scalar(meta.type)}`);
  for (const [k, v] of Object.entries(meta.properties ?? {})) {
    if (k === "obtion_id" || k === "obtion_version" || k === "type" || v === undefined || v === null) continue;
    lines.push(`${key(k)}: ${scalar(v)}`);
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/** The body and our id (if the file has our block). Edits inside the block are not pushed. */
export function parseNote(text: string): { id?: string; version?: string; body: string } {
  const m = OURS.exec(text);
  if (!m) return { body: text };
  const id = /^obtion_id: ([^\r\n]*)/m.exec(m[0])?.[1]?.trim();
  const version = /^obtion_version: ([^\r\n]*)/m.exec(m[0])?.[1]?.trim();
  return { id, version, body: text.slice(m[0].length) };
}

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
