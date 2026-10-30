// Examples for a first setup ("Mit Beispielen starten"): a small made-up world that shows how
// Obtion works – places and pinning, projects with tasks and progress, cards with links, own types,
// a query page, the inbox with something to sort in, an image and a PDF. Everything is in the
// language of the setup and marked with meta.source = "example", so "Beispiele entfernen" in the
// settings finds exactly these again. Fixed ids (ex-*): running it twice adds nothing.
// Used by the setup page (client), `cli.ts setup --examples` and `bun run seed:demo` alike.
import type * as Y from "yjs";
import { type FileMeta, type ItemInit, META_TYPE, appendUpdate, addDaysISO, fileTypeOf, initItem, initType, metaMap, setFileMeta, setMeta, todayISO } from "./model";
import type { Index } from "./graph";
import { SYS, type Writer } from "./setup";
import { BLOCKED_BY } from "./traits";
import { keysFor } from "./sortkey";
import { blockSource, queryFence, type QueryDef } from "./query";
import { type Lang, translate, words } from "./i18n";

export const EXAMPLE = "example";
export const EXAMPLE_ORIGIN = "system:examples";

export const EX_TYPES = { book: "ex-type-book", person: "ex-type-person", article: "ex-type-article" } as const;

/** A file of the examples: made here, stored by the caller (server: blobs, device: its file store). */
export interface ExampleFile {
  key: "diagram" | "sheet";
  name: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
  pages?: number;
  text?: string;
}

/** Store the files, then write the examples. `put` returns the file facts (hash, size, …). */
export async function addExamples(w: Writer, lang: Lang, put: (f: ExampleFile) => Promise<FileMeta>, now = Date.now()) {
  const metas: Partial<Record<ExampleFile["key"], FileMeta>> = {};
  for (const f of exampleFiles(lang)) metas[f.key] = await put(f);
  return writeExamples(w, lang, metas, now);
}

/** The facts every caller fills the same way. */
export function fileFacts(f: ExampleFile, hash: string): FileMeta {
  return { hash, name: f.name, mime: f.mime, filetype: fileTypeOf(f.name, f.mime), size: f.bytes.length, ...(f.pages ? { pages: f.pages } : {}), ...(f.text ? { text: f.text } : {}) };
}

export function exampleFiles(lang: Lang): ExampleFile[] {
  const L = (de: string, en: string) => (lang === "de" ? de : en);
  const sheet = [
    L("Übungsblatt 1 – Normalformen", "Exercise sheet 1 – Normal forms"),
    "",
    L("1. Bringe die Tabelle Belegung in die 1. Normalform.", "1. Bring the table Enrolment into first normal form."),
    L("2. Welche funktionalen Abhängigkeiten gibt es?", "2. Which functional dependencies are there?"),
    L("3. Zerlege das Schema verlustfrei in die 3. Normalform.", "3. Decompose the schema losslessly into third normal form."),
    L("4. Begründe, warum ein Index auf Matrikelnr. hilft.", "4. Explain why an index on the student number helps."),
    "",
    L("Abgabe: bis zur nächsten Übung.", "Due: by the next tutorial."),
  ];
  return [
    { key: "diagram", name: L("er-modell.svg", "er-model.svg"), mime: "image/svg+xml", bytes: new TextEncoder().encode(erDiagram(lang)) },
    { key: "sheet", name: L("Übungsblatt 1.pdf", "Exercise sheet 1.pdf"), mime: "application/pdf", bytes: tinyPdf(sheet), pages: 1, text: sheet.filter(Boolean).join("\n") },
  ];
}

/** Write the examples (the files' facts come from `exampleFiles` + the caller's store). */
export function writeExamples(w: Writer, lang: Lang, files: Partial<Record<ExampleFile["key"], FileMeta>>, now = Date.now()): string[] {
  const L = (de: string, en: string) => (lang === "de" ? de : en);
  const t = (k: string) => translate(lang, `setup.${k}`);
  const typeKey = words(lang, "q.key.type")[0];
  const block = (q: QueryDef) => queryFence(blockSource(q)) + "\n";
  const here = { this: true as const };
  const day = (n: number) => (n === 0 ? todayISO() : addDaysISO(n));
  const H = 3600_000;
  // created over the last three weeks, in the order below: the history reads like real use
  let clock = now - 21 * 24 * H;
  const hoursAgo = (h: number) => now - h * H; // the inbox: from the last day
  const written: string[] = [];

  function put(id: string, init: ItemInit, extra?: (doc: Y.Doc) => void) {
    if (w.get(id)) return id;
    clock += 12 * H;
    const created = init.created ?? Math.min(clock, now - 30 * H);
    w.change(id, (doc) => {
      // updated stays created until the user changes it: that is how "Beispiele entfernen" tells edited ones
      initItem(doc, { source: EXAMPLE, createdBy: EXAMPLE_ORIGIN, ...init, created });
      extra?.(doc);
    });
    written.push(id);
    return id;
  }
  const doneAt = (daysAgo: number) => (doc: Y.Doc) => metaMap(doc).set("done", now - daysAgo * 24 * H);

  // ---------- own types: Person, Buch, Artikel ----------
  const type = (id: string, spec: Parameters<typeof initType>[1], plural: string) => {
    if (w.get(id)) return;
    w.change(id, (doc) => initType(doc, { ...spec, plural }, { source: EXAMPLE, createdBy: EXAMPLE_ORIGIN, created: now - 22 * 24 * H }));
    written.push(id);
  };
  const person = "Person";
  const book = L("Buch", "Book");
  const article = L("Artikel", "Article");
  type(EX_TYPES.person, { name: person, icon: "user", color: "teal", description: L("Menschen, zum Beispiel Autorinnen und Autoren.", "People, for example authors."), capabilities: {}, properties: [] }, L("Personen", "People"));
  type(
    EX_TYPES.book,
    {
      name: book,
      icon: "book",
      color: "brown",
      description: L("Bücher, die ich lese oder lesen will.", "Books I read or want to read."),
      capabilities: { status: "p_ex_read" },
      properties: [
        { id: "p_ex_author", name: L("Autor", "Author"), kind: "relation", multiple: true, target: `${typeKey}:${person}`, inverseName: L("Bücher", "Books") },
        {
          id: "p_ex_read",
          name: L("Lesestatus", "Reading"),
          kind: "status",
          options: [
            { id: "rd_want", name: L("Will ich lesen", "Want to read"), group: "todo", color: "gray" },
            { id: "rd_now", name: L("Lese ich", "Reading"), group: "active", color: "amber" },
            { id: "rd_done", name: L("Gelesen", "Read"), group: "done", color: "green" },
          ],
        },
      ],
    },
    L("Bücher", "Books"),
  );
  type(
    EX_TYPES.article,
    {
      name: article,
      icon: "file-text",
      color: "pink",
      description: L("Blogartikel, auch in mehreren Sprachen.", "Blog posts, also in several languages."),
      capabilities: {},
      properties: [
        { id: "p_ex_lang", name: t("prop.language"), kind: "select", options: [{ id: "lang_de", name: "DE", color: "gray" }, { id: "lang_en", name: "EN", color: "gray" }] },
        { id: "p_ex_stage", name: L("Stand", "Stage"), kind: "select", options: [{ id: "stage_draft", name: L("Entwurf", "Draft"), color: "amber" }, { id: "stage_pub", name: L("Veröffentlicht", "Published"), color: "green" }] },
        { id: "p_ex_tr", name: L("Übersetzung", "Translation"), kind: "relation", target: `${typeKey}:${article}`, symmetric: true },
      ],
    },
    L("Artikel", "Articles"),
  );

  // ---------- pinned: the welcome note first, then the three areas and the query page ----------
  const [k0, k1, k2, k3, k4] = keysFor(5);
  const relaunchTitle = L("Website-Relaunch", "Website relaunch");
  const weekTitle = L("Diese Woche fällig", "Due this week");
  const customerTitle = "Studio Nordlicht";
  put("ex-welcome", {
    title: L("So funktioniert Obtion", "How Obtion works"),
    pinned: k0,
    body: L(
      `Alles hier ist ausgedacht und zeigt, wie Obtion funktioniert. Wenn du fertig bist: Einstellungen › Beispiele entfernen.

### Erfassen
Drück c oder +, schreib los. Was noch keinen Ort hat, landet im Eingang.

### Einsortieren
Im Eingang liegt eine Idee, die [[${relaunchTitle}]] erwähnt. „Einsortieren“ schlägt das Projekt als Ort vor.

### Orte
Ein Eintrag kann an mehreren Orten hängen: [[${relaunchTitle}]] steht unter [[Arbeit]] und beim Kunden [[${customerTitle}]].

### Anheften
Diese Notiz und die Bereiche darunter sind angeheftet: Sie stehen oben in der Seitenleiste.

### Typen und Ansichten
Projekt, Task und Karte sind Typen, eigene gehen auch – etwa [[${book}]]. Jeder Typ hat eine Seite mit Ansichten wie Tabelle und Board.

### Abfragen
[[${weekTitle}]] sammelt mit einem Abfrage-Block, was bald ansteht.

### MCP
Verbinde einen MCP-Client über die Workspace-Einstellungen, um deine Einträge per Agent zu lesen und zu ändern.
`,
      `Everything here is made up and shows how Obtion works. When you are done: Settings › Remove examples.

### Capture
Press c or + and start typing. What has no place yet lands in the inbox.

### Sort in
The inbox holds an idea that mentions [[${relaunchTitle}]]. "Sort in" suggests the project as its place.

### Places
An entry can live in several places: [[${relaunchTitle}]] is under [[Work]] and with the client [[${customerTitle}]].

### Pinning
This note and the areas below it are pinned: they stay at the top of the sidebar.

### Types and views
Project, task and card are types, and you can add your own – like [[${book}]]. Every type has a page with views such as table and board.

### Queries
[[${weekTitle}]] gathers what is due soon with a query block.

### MCP
Connect an MCP client in the workspace settings to read and change your entries through an agent.
`,
    ),
  });

  // ---------- Arbeit ----------
  const work = put("ex-work", {
    title: L("Arbeit", "Work"),
    pinned: k1,
    body:
      L("Alles rund um den Job. Projekte, Kunden, Besprechungen.\n\n", "Everything about the job. Projects, clients, meetings.\n\n") +
      block({ title: L("Aktive Projekte", "Active projects"), where: { and: [{ type: SYS.project }, { under: here }, { status: "active" }] }, columns: ["progress", "next"] }),
  });
  const clients = put("ex-clients", { title: L("Kunden", "Clients"), parents: [work], body: L("Eine Übersicht pro Kunde. Projekte hängen zusätzlich hier.\n", "One overview per client. Projects also live here.\n") });
  const nordlicht = put("ex-nordlicht", {
    title: customerTitle,
    parents: [clients],
    body: L(
      "Kleine Designagentur, ausgedacht. Ansprechpartnerin: Mara Lind.\n\n" ,
      "A small design studio, made up. Contact: Mara Lind.\n\n",
    ) + block({ title: L("Offene Tasks", "Open tasks"), where: { and: [{ type: SYS.task }, { under: here }, { status: "open" }] }, sort: [{ key: "due" }] }),
  });
  // two places: the home is "Arbeit", the client is the second one
  const relaunch = put(
    "ex-relaunch",
    {
      type: SYS.project,
      title: relaunchTitle,
      parents: [work, nordlicht],
      props: { p_status: "st_active", p_priority: "pr_high", p_period: `${day(-20)}/${day(30)}`, p_summary: L("Neue Website für Studio Nordlicht: frischer Auftritt, schneller, mobil zuerst.", "A new website for Studio Nordlicht: fresh look, faster, mobile first.") },
      body: L("Ziel: Livegang in vier Wochen. Design und Umsetzung sind eigene Unterprojekte.\n", "Goal: live in four weeks. Design and build are sub-projects of their own.\n"),
    },
    (doc) => {
      appendUpdate(doc, { at: now - 9 * 24 * H, text: L("Kickoff war gut, Moodboard steht. Als Nächstes die Mockups.", "Good kickoff, the moodboard is done. Mockups next."), by: "you" });
      appendUpdate(doc, { at: now - 2 * 24 * H, text: L("CMS-Entscheidung hängt noch, dadurch verschieben sich die Seiten.", "The CMS decision is still open, which delays the pages."), by: "agent:claude" });
    },
  );
  const design = put("ex-design", { type: SYS.project, title: L("Design", "Design"), parents: [relaunch], props: { p_status: "st_active", p_period: `${day(-20)}/${day(3)}` } });
  put("ex-t-moodboard", { type: SYS.task, title: L("Moodboard sammeln", "Collect a moodboard"), parents: [design], props: { p_status: "st_done" } }, doneAt(10));
  put("ex-t-mockups", { type: SYS.task, title: L("Mockups für die Startseite", "Mockups for the home page"), parents: [design], props: { p_status: "st_active", p_priority: "pr_high", p_due: day(0) } });
  const build = put("ex-build", { type: SYS.project, title: L("Umsetzung", "Build"), parents: [relaunch], props: { p_status: "st_planning", p_period: `${day(0)}/${day(30)}` } });
  put("ex-t-cms", { type: SYS.task, title: L("CMS auswählen", "Choose a CMS"), parents: [build], props: { p_status: "st_todo", p_priority: "pr_high", p_due: day(-2) } });
  const pages = put("ex-t-pages", { type: SYS.task, title: L("Seiten anlegen", "Create the pages"), parents: [build], props: { p_status: "st_todo", p_due: day(6) } });
  put("ex-t-pages-home", { type: SYS.task, title: L("Startseite", "Home page"), parents: [pages], props: { p_status: "st_done" } }, doneAt(1));
  put("ex-t-pages-about", { type: SYS.task, title: L("Über uns", "About us"), parents: [pages], props: { p_status: "st_todo" } });
  put("ex-t-pages-contact", { type: SYS.task, title: L("Kontakt", "Contact"), parents: [pages], props: { p_status: "st_todo" } });
  put("ex-t-launch", { type: SYS.task, title: L("Livegang", "Go live"), parents: [build], props: { p_status: "st_todo", p_due: day(14) }, rels: { [BLOCKED_BY]: [pages] } });
  put("ex-n-kickoff", {
    title: L("Kickoff mit Studio Nordlicht", "Kickoff with Studio Nordlicht"),
    parents: [relaunch],
    body: L(
      "- Zielgruppe: kleine Unternehmen aus der Region\n- Wichtig: Referenzen gut sichtbar, Kontakt mit einem Klick\n- Mara schickt Logos und Fotos bis Freitag\n",
      "- Audience: small local businesses\n- Important: references easy to find, contact in one click\n- Mara sends logos and photos by Friday\n",
    ),
  });
  put("ex-newsletter", {
    type: SYS.project,
    title: L("Newsletter", "Newsletter"),
    parents: [work],
    props: { p_status: "st_paused", p_priority: "pr_low", p_summary: L("Monatlicher Newsletter – pausiert bis nach dem Relaunch.", "A monthly newsletter – paused until after the relaunch.") },
  });

  // ---------- Lernen ----------
  const learn = put("ex-learn", { title: L("Lernen", "Learning"), pinned: k2, body: L("Kurse, Mitschriften, Karteikarten.\n", "Courses, notes, flash cards.\n") });
  const course = put("ex-course", {
    title: L("Kurs Datenbanken", "Databases course"),
    parents: [learn],
    extra: { ECTS: { k: "number", v: 6 }, [L("Note", "Grade")]: { k: "number", v: 1.7 } },
    body: L(
      "Relationale Modelle, SQL, Normalisierung, Indizes. ECTS und Note sind freie Eigenschaften: einfach auf der Seite ergänzen, ohne Typ.\n",
      "Relational models, SQL, normalisation, indexes. ECTS and grade are free properties: add them on any page, no type needed.\n",
    ),
  });
  const nf = L("Normalformen", "Normal forms");
  const btree = L("B-Bäume", "B-trees");
  put("ex-k-nf", {
    type: SYS.card,
    title: nf,
    parents: [course],
    body: L(
      `**1NF:** nur atomare Werte. **2NF:** keine partiellen Abhängigkeiten vom Schlüssel. **3NF:** keine transitiven Abhängigkeiten.\n\nNach dem Normalisieren werden Abfragen über Indizes schnell, siehe [[${btree}]].\n`,
      `**1NF:** atomic values only. **2NF:** no partial dependencies on the key. **3NF:** no transitive dependencies.\n\nOnce normalised, indexes make the queries fast, see [[${btree}]].\n`,
    ),
  });
  put("ex-k-btree", {
    type: SYS.card,
    title: btree,
    parents: [course],
    body: L(
      `Balancierter Suchbaum mit vielen Kindern pro Knoten. Wenige Plattenzugriffe, deshalb die Grundlage der meisten Datenbank-Indizes.\n\nGut normalisierte Tabellen ([[${nf}]]) brauchen meist nur wenige davon.\n`,
      `A balanced search tree with many children per node. Few disk reads, which is why most database indexes use it.\n\nWell normalised tables ([[${nf}]]) usually need only a few of them.\n`,
    ),
  });
  const diagram = files.diagram;
  const sheet = files.sheet;
  put("ex-n-lecture", {
    title: L("Vorlesung 3: Entwurf", "Lecture 3: Design"),
    parents: [course],
    body:
      L("Vom Sachverhalt zum Schema: erst Entitäten und Beziehungen, dann Tabellen.\n\n", "From the domain to the schema: entities and relations first, then tables.\n\n") +
      (diagram ? `![[${diagram.name}]]\n\n` : "") +
      L(`Offene Frage: Gehört die Note zur Belegung oder zum Kurs? → [[${nf}]]\n`, `Open question: does the grade belong to the enrolment or to the course? → [[${nf}]]\n`) +
      (sheet ? L(`\nÜbung dazu: [[${sheet.name}]]\n`, `\nExercise: [[${sheet.name}]]\n`) : ""),
  });
  if (diagram) put("ex-f-diagram", { kind: "datei", title: diagram.name, parents: [course] }, (doc) => setFileMeta(doc, { ...diagram, width: 640, height: 220 }));
  if (sheet) put("ex-f-sheet", { kind: "datei", title: sheet.name, parents: [course] }, (doc) => setFileMeta(doc, sheet));

  // ---------- Persönlich: books (own type with a relation to people) and a blog in two languages ----------
  const personal = put("ex-personal", {
    title: L("Persönlich", "Personal"),
    pinned: k3,
    body:
      L("Lesen, Schreiben, alles Private.\n\n", "Reading, writing, everything private.\n\n") +
      block({ title: L("Leseliste", "Reading list"), where: { and: [{ type: EX_TYPES.book }, { under: here }] }, view: "table" }),
  });
  // people need no place: they are on the type's page and on their books
  const lena = put("ex-p-lena", { type: EX_TYPES.person, title: "Lena Berg" });
  const jonas = put("ex-p-jonas", { type: EX_TYPES.person, title: "Jonas Falk" });
  put("ex-b-city", { type: EX_TYPES.book, title: L("Die stille Stadt", "The Quiet City"), parents: [personal], props: { p_ex_read: "rd_done" }, rels: { p_ex_author: [lena] } }, doneAt(12));
  put("ex-b-moor", { type: EX_TYPES.book, title: L("Wege durchs Moor", "Paths Through the Moor"), parents: [personal], props: { p_ex_read: "rd_now" }, rels: { p_ex_author: [lena] } });
  put("ex-b-systems", { type: EX_TYPES.book, title: L("Kleine Systeme", "Small Systems"), parents: [personal], props: { p_ex_read: "rd_want" }, rels: { p_ex_author: [jonas] }, body: L("Empfehlung aus dem Lesekreis.\n", "Recommended at the book club.\n") });
  const blog = put("ex-blog", { title: L("Blog", "Blog"), parents: [personal], body: L("Artikel für die eigene Website, manche in zwei Sprachen.\n", "Posts for my own website, some in two languages.\n") });
  // the language switch on an article comes from "Sprache" plus the symmetric "Übersetzung"
  const artDe = put("ex-art-de", {
    type: EX_TYPES.article,
    title: "Warum ich zuerst offline schreibe",
    parents: [blog],
    props: { p_ex_lang: "lang_de", p_ex_stage: "stage_pub" },
    body: "Notizen gehören zuerst auf das eigene Gerät. Dann gehen sie nie verloren, auch nicht im Zug ohne Netz.\n",
  });
  put("ex-art-en", {
    type: EX_TYPES.article,
    title: "Why I write offline first",
    parents: [blog],
    props: { p_ex_lang: "lang_en", p_ex_stage: "stage_draft" },
    rels: { p_ex_tr: [artDe] },
    body: "Notes belong on my own device first. Then they never get lost, not even on a train without signal.\n",
  });

  // ---------- a page with a query block ----------
  put("ex-week", {
    title: weekTitle,
    pinned: k4,
    body:
      L("Alles Offene, das in den nächsten sieben Tagen fällig ist – oder schon drüber. Die Seite rechnet selbst, du pflegst hier nichts.\n\n", "Everything open that is due within the next seven days – or already overdue. The page works it out itself, nothing to maintain here.\n\n") +
      block({ title: weekTitle, where: { and: [{ status: "open" }, { prop: "due", op: "<=", value: "+7d" }] }, sort: [{ key: "due" }], group: "path" }),
  });

  // ---------- inbox: no type, no place ----------
  put("ex-i-references", {
    created: hoursAgo(20),
    title: L("Idee: Referenzen als Fallstudien zeigen", "Idea: show references as case studies"),
    body: L(`Für [[${relaunchTitle}]]: pro Referenz eine kurze Geschichte statt nur Logos.\n`, `For the [[${relaunchTitle}]]: a short story per reference instead of just logos.\n`),
  });
  put("ex-i-podcast", { created: hoursAgo(9), title: L("Podcast-Tipp: Folge über Wissensmanagement", "Podcast tip: an episode on knowledge management") });
  put("ex-i-bike", { created: hoursAgo(4), title: L("Fahrrad zur Inspektion bringen", "Take the bike in for a service") });
  // a keyword with notes below it, not pinned: one bundle in the inbox
  const trip = put("ex-i-trip", { created: hoursAgo(26), title: L("Urlaub im Herbst", "Autumn holiday"), body: L("Sammelpunkt, bis daraus ein Projekt wird.\n", "A place to collect until it becomes a project.\n") });
  put("ex-i-trip-1", { created: hoursAgo(25), title: L("Zugverbindungen vergleichen", "Compare train connections"), parents: [trip] });
  put("ex-i-trip-2", { created: hoursAgo(2), title: L("Ferienwohnung mit Balkon suchen", "Find a flat with a balcony"), parents: [trip] });

  return written;
}

// ---------- removing them again ----------

export interface ExampleEntry {
  id: string;
  title: string;
  type: string | null;
  isType: boolean;
  /** Edited since the setup, or used by the user's own entries: kept unless chosen. */
  changed: boolean;
  /** A type with entries that are not examples: stays in any case. */
  inUse: boolean;
}

/** The examples still there, for the preview of "Beispiele entfernen". */
export function listExamples(ix: Index): ExampleEntry[] {
  const isEx = (id: string) => ix.get(id)?.source === EXAMPLE;
  const out: ExampleEntry[] = [];
  for (const r of ix.live) {
    if (r.source !== EXAMPLE) continue;
    const isType = r.type === META_TYPE;
    const own = (id: string) => !!ix.get(id) && !isEx(id);
    const used = ix.childrenOf(r.id).some(own) || ix.backlinks(r.id).some((b) => own(b.from));
    const inUse = isType && ix.live.some((i) => i.type === r.id && i.source !== EXAMPLE);
    out.push({ id: r.id, title: r.title, type: r.type, isType, changed: r.updated !== r.created || used, inUse });
  }
  // the types last: they go only when nothing of them is left
  return out.sort((a, b) => Number(a.isType) - Number(b.isType));
}

/**
 * To the trash: exactly these ids (each marked itself, so each comes back alone). A type goes
 * only if no living entry of it is left. Returns what was removed, for "Rückgängig".
 */
export function removeExamples(w: Writer, ix: Index, ids: string[]): string[] {
  const chosen = new Set(ids.filter((id) => ix.get(id)?.source === EXAMPLE));
  const removed: string[] = [];
  for (const id of chosen) {
    if (ix.get(id)!.type === META_TYPE) continue;
    w.change(id, (doc) => setMeta(doc, { deleted: true }));
    removed.push(id);
  }
  for (const id of chosen) {
    if (ix.get(id)!.type !== META_TYPE) continue;
    if (ix.live.some((i) => i.type === id && !chosen.has(i.id))) continue;
    w.change(id, (doc) => setMeta(doc, { deleted: true }));
    removed.push(id);
  }
  return removed;
}

export function restoreExamples(w: Writer, ids: string[]) {
  for (const id of ids) w.change(id, (doc) => setMeta(doc, { deleted: null }));
}

// ---------- the two files, made here ----------

function erDiagram(lang: Lang): string {
  const L = (de: string, en: string) => (lang === "de" ? de : en);
  const box = (x: number, title: string, rows: string[], fill: string) =>
    `<g transform="translate(${x} 70)"><rect width="160" height="${44 + rows.length * 24}" rx="10" fill="#fff" stroke="${fill}" stroke-width="2"/>` +
    `<rect width="160" height="36" rx="10" fill="${fill}"/><rect y="26" width="160" height="10" fill="${fill}"/>` +
    `<text x="80" y="24" text-anchor="middle" font-weight="600" fill="#fff">${title}</text>` +
    rows.map((r, i) => `<text x="14" y="${60 + i * 24}" fill="#333">${r}</text>`).join("") +
    `</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="220" viewBox="0 0 640 220" font-family="system-ui, sans-serif" font-size="14">
<rect width="640" height="220" fill="#f7f5f2"/>
<text x="24" y="36" font-size="16" font-weight="600" fill="#333">${L("ER-Modell: Belegung", "ER model: enrolment")}</text>
<path d="M184 120 H240 M400 120 H456" stroke="#888" stroke-width="2"/>
<text x="200" y="112" fill="#666">1</text><text x="226" y="112" fill="#666">n</text>
<text x="410" y="112" fill="#666">n</text><text x="440" y="112" fill="#666">1</text>
${box(24, "Student", [L("Matrikelnr.", "Student no."), "Name"], "#2f6ae0")}
${box(240, L("Belegung", "Enrolment"), [L("Semester", "Term"), L("Note", "Grade")], "#8b4fd8")}
${box(456, L("Kurs", "Course"), [L("Kursnr.", "Course no."), L("Titel", "Title"), "ECTS"], "#23905f")}
</svg>
`;
}

/** A one-page PDF with plain text (Helvetica, WinAnsi), built by hand: no library needed. */
function tinyPdf(lines: string[]): Uint8Array<ArrayBuffer> {
  const WIN: Record<string, number> = { "–": 0x96, "„": 0x84, "“": 0x93, "”": 0x94, "’": 0x92 };
  const enc = (s: string) =>
    [...s]
      .map((c) => String.fromCharCode(WIN[c] ?? (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f)))
      .join("")
      .replace(/[\\()]/g, "\\$&");
  const text = lines.map((l, i) => (i === 0 ? `BT /F2 18 Tf 56 770 Td (${enc(l)}) Tj ET` : `BT /F1 12 Tf 56 ${770 - 18 - i * 20} Td (${enc(l)}) Tj ET`)).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const at: number[] = [];
  objs.forEach((o, i) => {
    at.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}
