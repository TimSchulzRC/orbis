// Stored data is language-neutral (keys, ids) and only translated for display. Catalogs hold ICU
// messages; a missing key falls back to English, then to the key itself.
import { IntlMessageFormat, type PrimitiveType } from "intl-messageformat";
import de from "../locales/de.json";
import en from "../locales/en.json";

export type Lang = "de" | "en";
export const LANGS: Lang[] = ["de", "en"];
export const ENDONYMS: Record<Lang, string> = { de: "Deutsch", en: "English" };
export const CATALOGS: Record<Lang, Record<string, string>> = { de, en };

const cache = new Map<string, IntlMessageFormat>();

export type Values = Record<string, PrimitiveType>;

export function translate(lang: Lang, key: string, values?: Values): string {
  const msg = CATALOGS[lang][key] ?? CATALOGS.en[key];
  if (msg === undefined) return key;
  if (!values && !msg.includes("{")) return msg;
  const cacheKey = lang + "\u0000" + key;
  let formatter = cache.get(cacheKey);
  if (!formatter) cache.set(cacheKey, (formatter = new IntlMessageFormat(msg, lang)));
  try {
    return String(formatter.format(values));
  } catch (e) {
    console.warn(`[i18n] ${lang} ${key}:`, e);
    return msg;
  }
}

export type T = (key: string, values?: Values) => string;
export const makeT = (lang: Lang): T => (key, values) => translate(lang, key, values);

/** Query keyword synonyms, comma separated in the catalog; the first is the one printed. */
export function words(lang: Lang, key: string): string[] {
  return (CATALOGS[lang][key] ?? "").split(",").map((w) => w.trim()).filter(Boolean);
}

/**
 * The language an HTTP client prefers (Accept-Language, by weight) among ours; `fallback` when it
 * names none of them.
 */
export function acceptLang(header: string | null | undefined, fallback: Lang = "de"): Lang {
  let best: { lang: Lang; q: number } | undefined;
  for (const part of (header ?? "").split(",")) {
    const [tag = "", ...params] = part.trim().toLowerCase().split(";");
    const lang = LANGS.find((l) => tag === l || tag.startsWith(l + "-"));
    const q = Number(params.map((x) => x.trim()).find((x) => x.startsWith("q="))?.slice(2) ?? 1);
    if (lang && q > 0 && (!best || q > best.q)) best = { lang, q };
  }
  return best?.lang ?? fallback;
}

/** `pref` is a device language such as "de-AT". */
export function detectLang(pref?: string | null): Lang {
  const l = (pref ?? "en").toLowerCase();
  return l.startsWith("de") ? "de" : "en";
}

const locale = (lang: Lang) => (lang === "de" ? "de-DE" : "en-US");

/** A stored date value; one with a time (2026-10-30T14:30) shows it too. */
export function fmtDate(lang: Lang, iso: string | undefined, opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" }) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  if (isNaN(d.getTime())) return iso;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(iso)) return d.toLocaleString(locale(lang), { ...opts, hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(locale(lang), opts);
}

/** "28. Okt." / "28 Oct", with the year only if not this year. */
export function fmtShortDate(lang: Lang, iso: string) {
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale(lang), { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
}

export function fmtDateTime(lang: Lang, ts: number) {
  return new Date(ts).toLocaleString(locale(lang), { dateStyle: "medium", timeStyle: "short" });
}

/** "14:05" / "2:05 PM". */
export function fmtTime(lang: Lang, ts: number) {
  return new Date(ts).toLocaleTimeString(locale(lang), { hour: "2-digit", minute: "2-digit" });
}

export function fmtNumber(lang: Lang, n: number) {
  return n.toLocaleString(locale(lang), { maximumFractionDigits: 6 });
}

/** `share` is 0–1; prints whole percent ("42 %", "42%"). */
export function fmtPercent(lang: Lang, share: number) {
  return new Intl.NumberFormat(locale(lang), { style: "percent", maximumFractionDigits: 0 }).format(share);
}

const MINUTE_S = 60;
const HOUR_S = 3600;
const DAY_S = 86400;
/** Below this many seconds a moment reads as "now". */
const NOW_S = 45;
/** Older than this many days: the date gets its year. */
const SHOW_YEAR_DAYS = 300;

export function fmtRelative(lang: Lang, ts: number, now = Date.now()) {
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  const secs = (ts - now) / 1000;
  const dist = Math.abs(secs);
  if (dist < NOW_S) return translate(lang, "time.now");
  if (dist < HOUR_S) return rtf.format(Math.round(secs / MINUTE_S), "minute");
  if (dist < DAY_S) return rtf.format(Math.round(secs / HOUR_S), "hour");
  if (dist < DAY_S * 7) return rtf.format(Math.round(secs / DAY_S), "day");
  return new Date(ts).toLocaleDateString(locale(lang), { day: "numeric", month: "short", year: dist > DAY_S * SHOW_YEAR_DAYS ? "numeric" : undefined });
}

/** Seconds as "m:ss". */
export function fmtDuration(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function fmtBytes(lang: Lang, n: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${n.toLocaleString(locale(lang), { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}
