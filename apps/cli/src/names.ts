// Titles → file and folder names that work on Linux, macOS and Windows, unique per folder.

/** Characters no Windows file name may contain (and / everywhere). */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** Names Windows reserves, also with any extension (CON.txt). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** Our own folder and conflict copies are never names of items. */
export const STATE_DIR = ".obtion";
export const CONFLICT_MARK = ".obtion-conflict";
const MAX = 120;

/** Same file on case-insensitive or normalizing file systems (Windows, macOS). */
export const nameKey = (name: string) => name.normalize("NFC").toLowerCase();

/** Split "a.tar.gz" into "a.tar" and ".gz"; a leading dot (".project") is no extension. */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i <= 0 || name.length - i > 16 || /\s/.test(name.slice(i))) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

function clean(s: string): string {
  return s.replace(ILLEGAL, "_").replace(/\s+/g, " ").trim();
}

/** A name for an item: `ext` stays as given (".md" for notes), the rest is made safe. */
export function safeName(title: string, ext = "", fallback = "Ohne Titel"): string {
  let base = clean(title);
  if ([...base].length > MAX) base = [...base].slice(0, MAX).join("").trim();
  base = base.replace(/[. ]+$/, ""); // Windows drops trailing dots and spaces
  if (!base || base === "." || base === "..") base = fallback;
  if (RESERVED.test(base + ext) || RESERVED.test(base)) base = `_${base}`;
  if (nameKey(base + ext) === STATE_DIR || (base + ext).includes(CONFLICT_MARK)) base = `_${base}`;
  return base + ext;
}

/** A file's own name (it carries its extension), made safe. */
export function safeFileName(name: string): string {
  const [base, ext] = splitExt(name.trim());
  return safeName(base, clean(ext));
}

/** `name` or "name (2)", "name (3)" … not yet in `taken` (compared by nameKey); adds the result. */
export function uniqueName(name: string, taken: Set<string>, hasExt: boolean): string {
  const [base, ext] = hasExt ? splitExt(name) : [name, ""];
  let out = name;
  for (let n = 2; taken.has(nameKey(out)); n++) out = `${base} (${n})${ext}`;
  taken.add(nameKey(out));
  return out;
}

/** The conflict copy next to a file: "Notes.md" → "Notes.obtion-conflict.md". */
export function conflictName(name: string): string {
  const [base, ext] = splitExt(name);
  return `${base}${CONFLICT_MARK}${ext}`;
}
