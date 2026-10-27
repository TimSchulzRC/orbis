// UI language. Everything the app ships is stored language-neutral (keys, ids) and only
// translated for display. Catalogs are ICU messages (plural, placeholders) per language;
// a missing key falls back to English, then to the key itself.
import { IntlMessageFormat } from "intl-messageformat";
import de from "../locales/de.json";
import en from "../locales/en.json";

export type Lang = "de" | "en";
export const LANGS: Lang[] = ["de", "en"];
export const CATALOGS: Record<Lang, Record<string, string>> = { de, en };

const cache = new Map<string, IntlMessageFormat>();

export function translate(lang: Lang, key: string, values?: Record<string, unknown>): string {
  const msg = CATALOGS[lang][key] ?? CATALOGS.en[key];
  if (msg === undefined) return key;
  if (!values && !msg.includes("{")) return msg;
  const ck = lang + "\u0000" + key;
  let f = cache.get(ck);
  if (!f) cache.set(ck, (f = new IntlMessageFormat(msg, lang)));
  try {
    return String(f.format(values as any));
  } catch {
    return msg;
  }
}

export type T = (key: string, values?: Record<string, unknown>) => string;
export const makeT = (lang: Lang): T => (key, values) => translate(lang, key, values);

/** Words a catalog accepts for a query keyword: comma separated, the first is printed. */
export function words(lang: Lang, key: string): string[] {
  return (CATALOGS[lang][key] ?? "").split(",").map((w) => w.trim()).filter(Boolean);
}

/** The UI language for a device language such as "de-AT" (the platform passes it in). */
export function detectLang(pref?: string | null): Lang {
  const l = (pref ?? "en").toLowerCase();
  return l.startsWith("de") ? "de" : "en";
}

const locale = (lang: Lang) => (lang === "de" ? "de-DE" : "en-GB");

export function fmtDate(lang: Lang, iso: string | undefined, opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" }) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale(lang), opts);
}

/** Short date: "28. Okt." / "28 Oct", with year only if not this year. */
export function fmtShortDate(lang: Lang, iso: string) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale(lang), { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
}

export function fmtDateTime(lang: Lang, ts: number) {
  return new Date(ts).toLocaleString(locale(lang), { dateStyle: "medium", timeStyle: "short" });
}

export function fmtNumber(lang: Lang, n: number) {
  return n.toLocaleString(locale(lang), { maximumFractionDigits: 6 });
}

export function fmtRelative(lang: Lang, ts: number, now = Date.now()) {
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  const s = (ts - now) / 1000;
  const a = Math.abs(s);
  if (a < 45) return translate(lang, "time.now");
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 86400 * 7) return rtf.format(Math.round(s / 86400), "day");
  return new Date(ts).toLocaleDateString(locale(lang), { day: "numeric", month: "short", year: a > 86400 * 300 ? "numeric" : undefined });
}

export function fmtBytes(lang: Lang, n: number) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toLocaleString(locale(lang), { maximumFractionDigits: i ? 1 : 0 })} ${u[i]}`;
}
