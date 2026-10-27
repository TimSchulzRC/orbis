// Tolerant input for agents and queries: dates in German, English and US notation and
// words like "morgen"; status as group or option name in either language, with synonyms;
// option names in the other language. Unclear input is rejected with an explanation
// (InputError) instead of guessed.
import { type OptionDef, type PropDef, type StatusGroup, addDaysISO } from "./model";
import { defaultTypes } from "./setup";
import { LANGS } from "./i18n";

export class InputError extends Error {}

/** Lower case, umlauts as two letters, spaces/hyphens/underscores as one "_". */
export function foldWord(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[\s_-]+/g, "_");
}

// ---------- dates ----------

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
 * A date as typed → ISO (YYYY-MM-DD), or undefined if it is not a date.
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

export const DATE_HELP = "a date like 2026-10-30, 30.10.2026, 10/30/2026, today/heute, tomorrow/morgen, a weekday or +3d";

// ---------- status and options ----------

type Alias = { group: StatusGroup; names?: string[] };
/** Synonyms → status group, and option names to prefer within it (both languages). */
const STATUS_ALIASES: Record<string, Alias> = {};
const alias = (words: string, a: Alias) => words.split(",").forEach((w) => (STATUS_ALIASES[foldWord(w)] = a));
alias("open,offen,todo,to do,new,neu,not started,nicht begonnen,noch nicht begonnen", { group: "todo" });
alias("backlog,idee,idea,someday,irgendwann", { group: "todo", names: ["backlog"] });
alias("active,aktiv,in progress,in arbeit,in bearbeitung,doing,wip,started,begonnen,läuft,progress", { group: "active", names: ["in bearbeitung", "in progress"] });
alias("planning,planung,geplant,planned", { group: "active", names: ["planung", "planning"] });
const PAUSED: Alias = { group: "active", names: ["pausiert", "paused"] };
alias("paused,pausiert,on hold,hold,angehalten,pause", PAUSED);
alias("done,erledigt,fertig,abgeschlossen,completed,complete,finished,closed,geschlossen", { group: "done", names: ["erledigt", "done"] });
const CANCELED: Alias = { group: "done", names: ["abgebrochen", "verworfen", "canceled", "dropped"] };
alias("canceled,cancelled,abgebrochen,aborted,verworfen,dropped,discarded", CANCELED);
alias("archived,archiviert", { group: "done", names: ["archiviert", "archived"] });
const NOT_A_STATUS = new Set(["blocked", "blockiert", "waiting", "wartet", "waiting_for", "wartet_auf"].map(foldWord));

/** Names the shipped options have in every language (an English "High" finds "Hoch"). */
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

/** The option of a select or status property meant by `raw`; throws InputError if unclear. */
export function matchOption(p: PropDef, raw: string): OptionDef {
  const options = p.options ?? [];
  const hit = byName(options, raw);
  if (hit) return hit;
  const w = foldWord(raw);
  if (p.kind === "status") {
    if (NOT_A_STATUS.has(w))
      throw new InputError(`"${raw}" is not a status. Set "Blockiert durch" (the blocking entry) or "Wartet auf" (what it waits for, e.g. "Zertifikat vom Kunden"); optionally also a paused status.`);
    const a = STATUS_ALIASES[w];
    if (a) {
      for (const n of a.names ?? []) {
        const o = byName(options, n);
        if (o && (o.group ?? "todo") === a.group) return o;
      }
      const o = options.find((x) => (x.group ?? "todo") === a.group);
      if (o) return o;
    }
  }
  const list = options.map((o) => (p.kind === "status" ? `${o.name} (${o.group ?? "todo"})` : o.name)).join(", ");
  throw new InputError(`"${raw}" is not an option of "${p.name}". Options: ${list}${p.kind === "status" ? "; or a group: open, active, done" : ""}.`);
}

/** A paused option ("Pausiert", "On hold" …): active by group, but nothing to work on now. */
export function isPausedOption(o: OptionDef): boolean {
  return o.id === "st_paused" || STATUS_ALIASES[foldWord(o.name)] === PAUSED;
}

export type StatusShape = "open" | "active" | "paused" | "done" | "dropped";
/** How a status looks (shape, not only colour): ring, half circle, pause, check, cross. */
export function statusShape(o: OptionDef): StatusShape {
  const g = o.group ?? "todo";
  if (g === "todo") return "open";
  if (g === "active") return isPausedOption(o) ? "paused" : "active";
  return o.id === "st_canceled" || o.id === "st_dropped" || STATUS_ALIASES[foldWord(o.name)] === CANCELED ? "dropped" : "done";
}

/** Status group meant by a word (offen, in Arbeit, done …), if it names one. */
export function statusGroupOf(raw: string): StatusGroup | undefined {
  return STATUS_ALIASES[foldWord(raw)]?.group;
}

/** Does a status/select option match the word (name, other language, or synonym)? */
export function optionMatches(p: PropDef, o: OptionDef, raw: string): boolean {
  try {
    return matchOption(p, raw).id === o.id || (p.kind === "status" && !STATUS_ALIASES[foldWord(raw)]?.names && statusGroupOf(raw) === (o.group ?? "todo"));
  } catch {
    return false;
  }
}

// ---------- type names ----------

/** Singular and plural forms count as the same type name: Task/Tasks, Projekt/Projekte, Karte/Karten. */
export function sameTypeName(name: string, input: string): boolean {
  const a = foldWord(name);
  const b = foldWord(input);
  if (a === b) return true;
  for (const end of ["s", "e", "n", "en", "es"]) if (b === a + end || a === b + end) return true;
  return false;
}
