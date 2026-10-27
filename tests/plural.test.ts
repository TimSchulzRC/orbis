import { test, expect } from "bun:test";
import { pluralOf } from "@obtion/core/plural";

test("plural suggestions for type names: German rules, irregular nouns, compounds, English", () => {
  const de = (n: string) => pluralOf(n, "de");
  expect(["Buch", "Kochbuch", "Person", "Autor", "Autorin", "Karte", "Artikel", "Projekt", "Task", "Notiz", "Rechnung", "Video", "Kurs", "Ziel", "Modul", "Semester", "Bild", "Vortrag", "Firma"].map(de)).toEqual([
    "Bücher", "Kochbücher", "Personen", "Autoren", "Autorinnen", "Karten", "Artikel", "Projekte", "Tasks", "Notizen", "Rechnungen", "Videos", "Kurse", "Ziele", "Module", "Semester", "Bilder", "Vorträge", "Firmen",
  ]);
  expect(["Book", "Person", "Box", "Story", "Card"].map((n) => pluralOf(n, "en"))).toEqual(["Books", "Persons", "Boxes", "Stories", "Cards"]);
});
