const TWO: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
const PLAIN: Record<string, string> = { ä: "a", ö: "o", ü: "u", ß: "ss" };

/** ä → ae, ß → ss, so "Jürgen" and "Juergen" match. */
export function foldUmlauts(s: string): string {
  return s.toLowerCase().replace(/[äöüß]/g, (c) => TWO[c]!);
}

export function plainVowels(s: string): string {
  return s.toLowerCase().replace(/[äöüß]/g, (c) => PLAIN[c]!);
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
