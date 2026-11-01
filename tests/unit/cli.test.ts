// The CLI's pure parts: titles → names on every system, the note format, the folder layout, the config path.
import { test, expect } from "bun:test";
import { conflictName, safeFileName, safeName, splitExt, uniqueName } from "@obtion/cli/names";
import { parseNote, renderNote } from "@obtion/cli/notes";
import { layout } from "@obtion/cli/sync";
import { configPath } from "@obtion/cli/config";
import { Ignore } from "@obtion/cli/local";
import type { Node } from "@obtion/cli/client";

test("titles become names that are legal on Windows, macOS and Linux", () => {
  expect(safeName("A/B: C?", ".md")).toBe("A_B_ C_.md");
  expect(safeName('a<b>c"d|e*f\\g', "")).toBe("a_b_c_d_e_f_g");
  expect(safeName("Zeile\nzwei\tdrei")).toBe("Zeile_zwei_drei");
  expect(safeName("CON", ".md")).toBe("_CON.md");
  expect(safeName("lpt1")).toBe("_lpt1");
  expect(safeName("nul.txt")).toBe("_nul.txt");
  expect(safeName("Ende. ", ".md")).toBe("Ende.md");
  expect(safeName("...", ".md")).toBe("Ohne Titel.md");
  expect(safeName("", ".md")).toBe("Ohne Titel.md");
  expect(safeName(".obtion")).toBe("_.obtion");
  expect(safeName("x".repeat(300), ".md")).toBe("x".repeat(120) + ".md");
  expect(safeName("Größe – Übersicht 😀", ".md")).toBe("Größe – Übersicht 😀.md");
  expect(safeFileName("Schema: v2.xsd")).toBe("Schema_ v2.xsd");
  expect(safeFileName(".project")).toBe(".project");
  expect(safeFileName("aux.c")).toBe("_aux.c");
});

test("names are unique per folder, compared without case and Unicode form", () => {
  const taken = new Set<string>();
  expect(uniqueName("Doppelt.md", taken, true)).toBe("Doppelt.md");
  expect(uniqueName("doppelt.md", taken, true)).toBe("doppelt (2).md");
  expect(uniqueName("Doppelt.md", taken, true)).toBe("Doppelt (3).md");
  expect(uniqueName("Doppelt", taken, false)).toBe("Doppelt");
  expect(uniqueName("v1.2", taken, false)).toBe("v1.2");
  expect(uniqueName("v1.2", taken, false)).toBe("v1.2 (2)");
  expect(uniqueName("Übersicht.md", taken, true)).toBe("Übersicht.md");
  expect(uniqueName("U\u0308bersicht.md", taken, true)).toBe("U\u0308bersicht (2).md");
  expect(splitExt("archiv.tar.gz")).toEqual(["archiv.tar", ".gz"]);
  expect(splitExt(".classpath")).toEqual([".classpath", ""]);
  expect(conflictName("Notizen.md")).toBe("Notizen.obtion-conflict.md");
});

test("a note keeps its body byte for byte behind our front matter", () => {
  for (const body of ["", "a\r\nb\r\n", "---\ntitle: eigen\n---\nText", "\ufeffBOM", "kein Zeilenende"]) {
    const text = renderNote({ id: "0abcdefghijklmnop", version: "0123456789ab", type: "Projekt", properties: { Status: "In Arbeit", "Start: Datum": "2026-10-30", Anzahl: 3 } }, body);
    const p = parseNote(text);
    expect(p).toEqual({ id: "0abcdefghijklmnop", version: "0123456789ab", body });
  }
  expect(renderNote({ id: "x", version: "v", properties: { Status: "In Arbeit" } }, "B")).toBe('---\nobtion_id: x\nobtion_version: v\nStatus: "In Arbeit"\n---\nB');
  // a file of one's own with its own front matter is all body
  expect(parseNote("---\ntitle: x\n---\nText")).toEqual({ body: "---\ntitle: x\n---\nText" });
  // an editor that turned everything into CRLF
  expect(parseNote("---\r\nobtion_id: x\r\nobtion_version: v\r\n---\r\nA\r\n")).toEqual({ id: "x", version: "v", body: "A\r\n" });
});

const node = (id: string, title: string, parents: string[], extra: Partial<Node> = {}): Node => ({
  id,
  kind: "info",
  title,
  type: null,
  version: "v",
  parents,
  home: parents[0] ?? null,
  created: Number(id.replace(/\D/g, "")) || 0,
  updated: 0,
  body: "",
  ...extra,
});

test("layout: each item once (at its home), folders for items with children, README.md for their text", () => {
  const items = [
    node("r", "Root", [], { body: "Startseite" }),
    node("a1", "Mapping", ["r"], { body: "Text" }),
    node("a2", "Notiz", ["r"]),
    node("a3", "Geteilt", ["r", "a1"], { home: "a1" }),
    node("a4", "README", ["a1"]),
    node("a5", "x.pdf", ["a1"], { kind: "file", file: { name: "x.pdf", hash: "h", size: 1, mime: "application/pdf" } }),
    node("a6", "Notiz", ["r"]),
    node("a7", "Weg", ["fremd", "a2"], { home: "fremd" }),
  ];
  const out = layout({ root: "r", items }).map((d) => `${d.kind} ${d.path}`);
  expect(out).toEqual([
    "folder ",
    "body README.md",
    "folder Mapping",
    "body Mapping/README.md",
    "note Mapping/Geteilt.md",
    "note Mapping/README (2).md",
    "file Mapping/x.pdf",
    "folder Notiz",
    "note Notiz/Weg.md",
    "note Notiz.md",
  ]);
});

test("the config lives in the user's own place on each system", () => {
  expect(configPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe("/x/obtion/config.json");
  expect(configPath({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toContain("obtion");
  expect(configPath({}, "darwin")).toContain("Library/Application Support/obtion/config.json");
  expect(configPath({ OBTION_CONFIG: "/y.json" }, "linux")).toBe("/y.json");
});

test("ignore patterns: folders, base names, paths", () => {
  const ig = new Ignore([".obtion/", "*.pyc", "~$*", "build/out/*", "__pycache__/"]);
  expect(ig.matches(".obtion", true)).toBe(true);
  expect(ig.matches("a/b.pyc", false)).toBe(true);
  expect(ig.matches("~$Angebot.docx", false)).toBe(true);
  expect(ig.matches("build/out/x.jar", false)).toBe(true);
  expect(ig.matches("src/__pycache__", true)).toBe(true);
  expect(ig.matches("src/__pycache__", false)).toBe(false);
  expect(ig.matches("tool.py", false)).toBe(false);
});
