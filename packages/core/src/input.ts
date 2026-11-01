// Tolerant input for agents and queries, in German and English. Unclear input throws an
// InputError with an explanation instead of being guessed.
import { type OptionDef, type PropDef, type StatusGroup, addDaysISO } from "./model";
import { defaultTypes } from "./setup";
import { type Lang, LANGS } from "./i18n";
import { foldUmlauts } from "./text";

export class InputError extends Error {}

function foldWord(s: string): string {
  return foldUmlauts(s.trim()).replace(/[\s_-]+/g, "_");
}

const DAY_WORDS: Record<string, number> = {
  heute: 0, today: 0,
  morgen: 1, tomorrow: 1,
  uebermorgen: 2, day_after_tomorrow: 2,
  gestern: -1, yesterday: -1,
};
const WEEKDAYS: Record<string, number> = {
  sonntag: 0, sunday: 0, so: 0, sun: 0,
  montag: 1, monday: 1, mo: 1, mon: 1,
  dienstag: 2, tuesday: 2, di: 2, tue: 2,
  mittwoch: 3, wednesday: 3, mi: 3, wed: 3,
  donnerstag: 4, thursday: 4, do: 4, thu: 4,
  freitag: 5, friday: 5, fr: 5, fri: 5,
  samstag: 6, saturday: 6, sa: 6, sat: 6,
};

function iso(y: number, m: number, d: number): string | undefined {
  const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(s + "T12:00:00Z");
  return !isNaN(dt.getTime()) && dt.toISOString().startsWith(s) ? s : undefined;
}

/**
 * Accepts 2026-10-30, 2026-10-30T09:00, 30.10.2026, 30.10.26, 30.10. (this year), 10/30/2026 (US),
 * heute/today, morgen/tomorrow, übermorgen, gestern, a weekday (the next one), +3d/-2w/+1m/+1y,
 * "in 3 Tagen", "in 2 weeks".
 */
export function parseDate(input: string, today: string): string | undefined {
  const v = input.trim();
  const base = new Date(today + "T12:00:00");
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(v);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(v);
  if (m) return iso(m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : base.getFullYear(), +m[2]!, +m[1]!);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return iso(+m[3]!, +m[1]!, +m[2]!);
  m = /^([+-])(\d+)([dwmy])$/.exec(v);
  if (m) {
    const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
    return addDaysISO(m[3] === "d" ? n : m[3] === "w" ? n * 7 : m[3] === "m" ? n * 30 : n * 365, base);
  }
  m = /^in (\d+) (tag|tagen|day|days|woche|wochen|week|weeks)$/i.exec(v);
  if (m) return addDaysISO(Number(m[1]) * (/^w/i.test(m[2]!) ? 7 : 1), base);
  const w = foldWord(v);
  if (w in DAY_WORDS) return addDaysISO(DAY_WORDS[w]!, base);
  if (w in WEEKDAYS) {
    const diff = (WEEKDAYS[w]! - base.getDay() + 7) % 7 || 7;
    return addDaysISO(diff, base);
  }
  return undefined;
}

/** 30.10.2026 (de) or 10/30/2026 (en); parseDate reads both back. */
export function dateText(lang: Lang, iso?: string): string {
  const m = iso && /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  return lang === "de" ? `${m[3]}.${m[2]}.${m[1]}` : `${m[2]}/${m[3]}/${m[1]}`;
}

export const DATE_HELP = "a date like 2026-10-30, 30.10.2026, 10/30/2026, today/heute, tomorrow/morgen, a weekday or +3d";

/** Without grouping: 1234,5 (de) or 1234.5 (en). */
export function numberText(lang: Lang, n: number): string {
  const s = String(n);
  return lang === "de" ? s.replace(".", ",") : s;
}

/**
 * Takes grouping (1.234,5 / 1,234.5) and spaces. A lone other separator that is not grouping
 * counts as the decimal mark (1.5 in German, 1,5 in English).
 */
export function parseNumber(lang: Lang, input: string): number | undefined {
  const [dec, group] = lang === "de" ? [",", "."] : [".", ","];
  let [int = "", frac, ...more] = input.replace(/[\s']/g, "").split(dec);
  if (more.length) return undefined;
  if (new RegExp(`^[+-]?\\d{1,3}(\\${group}\\d{3})+$`).test(int)) int = int.split(group).join("");
  else if (frac === undefined) int = int.replace(group, ".");
  const s = frac === undefined ? int : `${int}.${frac}`;
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : undefined;
}

type Alias = { group: StatusGroup; names?: string[]; state?: OptionDef["state"] };
/** Synonym → status group, plus option names to prefer within it; paused and dropped also match by state. */
const STATUS_ALIASES: Record<string, Alias> = {};
const alias = (words: string, a: Alias) => words.split(",").forEach((w) => (STATUS_ALIASES[foldWord(w)] = a));
alias("open,offen,todo,to do,new,neu,not started,nicht begonnen,noch nicht begonnen", { group: "todo" });
alias("backlog,idee,idea,someday,irgendwann", { group: "todo", names: ["backlog"] });
alias("active,aktiv,in progress,in arbeit,in bearbeitung,doing,wip,started,begonnen,läuft,progress", { group: "active", names: ["in bearbeitung", "in progress"] });
alias("planning,planung,geplant,planned", { group: "active", names: ["planung", "planning"] });
alias("paused,pausiert,on hold,hold,angehalten,pause", { group: "active", names: ["pausiert", "paused"], state: "paused" });
alias("done,erledigt,fertig,abgeschlossen,completed,complete,finished,closed,geschlossen", { group: "done", names: ["erledigt", "done"] });
alias("canceled,cancelled,abgebrochen,aborted,verworfen,dropped,discarded", { group: "done", names: ["abgebrochen", "verworfen", "canceled", "dropped"], state: "dropped" });
alias("archived,archiviert", { group: "done", names: ["archiviert", "archived"] });
const NOT_A_STATUS = new Set(["blocked", "blockiert", "waiting", "wartet", "waiting_for", "wartet_auf"].map(foldWord));

/** Shipped option names in every language, so an English "High" finds "Hoch". */
let shippedNames: Map<string, string[]> | null = null;
function namesOf(optionId: string): string[] {
  if (!shippedNames) {
    shippedNames = new Map();
    for (const lang of LANGS)
      for (const spec of Object.values(defaultTypes(lang)))
        for (const p of spec.properties) for (const o of p.options ?? []) shippedNames.set(o.id, [...(shippedNames.get(o.id) ?? []), foldWord(o.name)]);
  }
  return shippedNames.get(optionId) ?? [];
}

function byName(options: OptionDef[], word: string): OptionDef | undefined {
  const w = foldWord(word);
  return options.find((o) => foldWord(o.name) === w) ?? options.find((o) => o.id === word.trim() || namesOf(o.id).includes(w));
}

/** Only a status has grouped options; group words match those too. */
const grouped = (p: PropDef) => !!p.options?.some((o) => o.group);

/** Throws InputError if unclear. */
export function matchOption(p: PropDef, raw: string): OptionDef {
  const options = p.options ?? [];
  const hit = byName(options, raw);
  if (hit) return hit;
  const w = foldWord(raw);
  if (grouped(p)) {
    if (NOT_A_STATUS.has(w))
      throw new InputError(`"${raw}" is not a status. Set a property that holds it up (blocks), e.g. "Blockiert durch" (the blocking entry) or "Wartet auf" (what it waits for); optionally also a paused status.`);
    const a = STATUS_ALIASES[w];
    if (a) {
      // "on hold" means the option marked paused, even if another one is called "Paused"
      const marked = a.state && options.find((x) => (x.group ?? "todo") === a.group && x.state === a.state);
      if (marked) return marked;
      for (const n of a.names ?? []) {
        const o = byName(options, n);
        if (o && (o.group ?? "todo") === a.group) return o;
      }
      const o = options.find((x) => (x.group ?? "todo") === a.group && x.state === a.state) ?? options.find((x) => (x.group ?? "todo") === a.group);
      if (o) return o;
    }
  }
  const list = options.map((o) => (grouped(p) ? `${o.name} (${o.group ?? "todo"}${o.state ? `, ${o.state}` : ""})` : o.name)).join(", ");
  throw new InputError(`"${raw}" is not an option of "${p.name}". Options: ${list}${grouped(p) ? "; or a group: open, active, done" : ""}.`);
}

/** Active by group, but nothing to work on now. */
export function isPausedOption(o: OptionDef): boolean {
  return o.state === "paused";
}

export type StatusShape = "open" | "active" | "paused" | "done" | "dropped";
/** Shape, not only colour: ring, half circle, pause, check, cross. */
export function statusShape(o: OptionDef): StatusShape {
  const g = o.group ?? "todo";
  if (g === "todo") return "open";
  if (g === "active") return isPausedOption(o) ? "paused" : "active";
  return o.state === "dropped" ? "dropped" : "done";
}

/** "on hold" → paused, "verworfen" → dropped. */
export function statusStateOf(raw: string): OptionDef["state"] {
  return STATUS_ALIASES[foldWord(raw)]?.state;
}

export function statusGroupOf(raw: string): StatusGroup | undefined {
  return STATUS_ALIASES[foldWord(raw)]?.group;
}

/** Matches by name, the other language's name or a synonym. */
export function optionMatches(p: PropDef, o: OptionDef, raw: string): boolean {
  try {
    return matchOption(p, raw).id === o.id || (grouped(p) && !STATUS_ALIASES[foldWord(raw)]?.names && statusGroupOf(raw) === (o.group ?? "todo"));
  } catch {
    return false;
  }
}

/** Singular and plural count as the same: Task/Tasks, Projekt/Projekte, Karte/Karten. */
export function sameTypeName(name: string, input: string): boolean {
  const a = foldWord(name);
  const b = foldWord(input);
  if (a === b) return true;
  for (const end of ["s", "e", "n", "en", "es"]) if (b === a + end || a === b + end) return true;
  return false;
}
