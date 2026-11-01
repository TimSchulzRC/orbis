// Only a suggestion for the plural of a type name; the user can still edit it.

// matched at the end of the word so compounds work too ("Kochbuch" → "Kochbücher")
const DE_IRREGULAR: [string, string][] = [
  ["buch", "bücher"], ["haus", "häuser"], ["land", "länder"], ["wort", "wörter"], ["bild", "bilder"],
  ["kind", "kinder"], ["lied", "lieder"], ["feld", "felder"], ["geld", "gelder"], ["blatt", "blätter"],
  ["rad", "räder"], ["dorf", "dörfer"], ["glas", "gläser"], ["amt", "ämter"], ["mann", "männer"],
  ["stadt", "städte"], ["hand", "hände"], ["wand", "wände"], ["baum", "bäume"], ["raum", "räume"],
  ["traum", "träume"], ["platz", "plätze"], ["satz", "sätze"], ["fluss", "flüsse"], ["schluss", "schlüsse"],
  ["vortrag", "vorträge"], ["antrag", "anträge"], ["vertrag", "verträge"], ["beitrag", "beiträge"], ["auftrag", "aufträge"],
  ["firma", "firmen"], ["thema", "themen"], ["museum", "museen"], ["zentrum", "zentren"], ["album", "alben"],
  ["konto", "konten"], ["person", "personen"], ["notiz", "notizen"], ["frau", "frauen"], ["kurs", "kurse"],
  // English loanwords keep their English plural in German
  ["task", "tasks"], ["team", "teams"], ["link", "links"], ["event", "events"], ["meeting", "meetings"],
  ["ticket", "tickets"], ["tool", "tools"], ["blog", "blogs"], ["podcast", "podcasts"], ["job", "jobs"],
  ["song", "songs"], ["app", "apps"], ["issue", "issues"], ["post", "posts"], ["workshop", "workshops"],
];

export function pluralOf(name: string, lang: string): string {
  const n = name.trim();
  if (!n) return n;
  if (lang === "de") {
    const low = n.toLowerCase();
    for (const [one, many] of DE_IRREGULAR)
      if (low.endsWith(one)) {
        const head = n.slice(0, n.length - one.length);
        return head ? head + many : many[0]!.toUpperCase() + many.slice(1);
      }
    if (/(ung|heit|keit|schaft|ion|tät|ik|ur|ei|or)$/i.test(n)) return n + "en"; // Autor → Autoren
    if (/iel$/i.test(n)) return n + "e"; // Ziel, Spiel
    if (/in$/i.test(n)) return n + "nen"; // Autorin → Autorinnen
    if (/[aoiuy]$/i.test(n)) return n + "s"; // Video, Foto, Hobby
    if (/e$/i.test(n)) return n + "n";
    if (/(el|er|en|chen|lein)$/i.test(n)) return n;
    if (/(s|x|z)$/i.test(n)) return n + "e";
    return n + "e";
  }
  if (/(s|x|z|ch|sh)$/i.test(n)) return n + "es";
  if (/[^aeiou]y$/i.test(n)) return n.slice(0, -1) + "ies";
  return n + "s";
}
