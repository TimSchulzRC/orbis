// Text helpers shared by search, queries and tolerant input.

const TWO: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
const PLAIN: Record<string, string> = { ä: "a", ö: "o", ü: "u", ß: "ss" };

/** Lower case, umlauts as two letters (ä → ae, ß → ss): how "Jürgen" and "Juergen" meet. */
export function foldUmlauts(s: string): string {
  return s.toLowerCase().replace(/[äöüß]/g, (c) => TWO[c]!);
}

/** Lower case, umlauts as plain vowels (ö → o, ß → ss). */
export function plainVowels(s: string): string {
  return s.toLowerCase().replace(/[äöüß]/g, (c) => PLAIN[c]!);
}

/** `s` as a literal inside a RegExp. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
