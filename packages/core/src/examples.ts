// Example data for "Start with examples". Everything carries meta.source = "example" so
// "Remove examples" finds exactly these again; fixed ids (ex-*) make a second run a no-op.
import type * as Y from "yjs";
import { type FileMeta, type ItemInit, META_TYPE, appendUpdate, addDaysISO, fileTypeOf, initItem, initType, metaMap, setFileMeta, setMeta, todayISO } from "./model";
import type { Index } from "./graph";
import { BLOCKED_BY, SYS, type Writer } from "./setup";
import { keysFor } from "./sortkey";
import { blockSource, queryFence, type QueryDef } from "./query";
import { type Lang, type Values, translate, words } from "./i18n";

export const EXAMPLE = "example";
export const EXAMPLE_ORIGIN = "system:examples";

export const EX_TYPES = { book: "ex-type-book", person: "ex-type-person", article: "ex-type-article" } as const;

/** Made here, stored by the caller (server: blobs, device: its file store). */
export interface ExampleFile {
  key: "diagram" | "sheet";
  name: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
  pages?: number;
  text?: string;
}

export async function addExamples(w: Writer, lang: Lang, put: (f: ExampleFile) => Promise<FileMeta>, now = Date.now()) {
  const metas: Partial<Record<ExampleFile["key"], FileMeta>> = {};
  for (const f of exampleFiles(lang)) metas[f.key] = await put(f);
  return writeExamples(w, lang, metas, now);
}

export function fileFacts(f: ExampleFile, hash: string): FileMeta {
  return { hash, name: f.name, mime: f.mime, filetype: fileTypeOf(f.name, f.mime), size: f.bytes.length, ...(f.pages ? { pages: f.pages } : {}), ...(f.text ? { text: f.text } : {}) };
}

export function exampleFiles(lang: Lang): ExampleFile[] {
  const ex = (key: string, values?: Values) => translate(lang, `sample.${key}`, values);
  const sheet = [
    ex("sheet.title"),
    "",
    ex("sheet.task1"),
    ex("sheet.task2"),
    ex("sheet.task3"),
    ex("sheet.task4"),
    "",
    ex("sheet.due"),
  ];
  return [
    { key: "diagram", name: ex("file.diagram"), mime: "image/svg+xml", bytes: new TextEncoder().encode(erDiagram(lang)) },
    { key: "sheet", name: ex("file.sheet"), mime: "application/pdf", bytes: tinyPdf(sheet), pages: 1, text: sheet.filter(Boolean).join("\n") },
  ];
}

export function writeExamples(w: Writer, lang: Lang, files: Partial<Record<ExampleFile["key"], FileMeta>>, now = Date.now()): string[] {
  const ex = (key: string, values?: Values) => translate(lang, `sample.${key}`, values);
  const t = (k: string) => translate(lang, `setup.${k}`);
  const typeKey = words(lang, "q.key.type")[0];
  const block = (q: QueryDef) => queryFence(blockSource(q)) + "\n";
  const here = { this: true as const };
  const day = (n: number) => (n === 0 ? todayISO() : addDaysISO(n));
  const H = 3600_000;
  const D = 24 * H;
  // spread over the last three weeks in the order below, so the history reads like real use
  let clock = now - 21 * D;
  const hoursAgo = (h: number) => now - h * H;
  const written: string[] = [];

  function put(id: string, init: ItemInit, extra?: (doc: Y.Doc) => void) {
    if (w.get(id)) return id;
    clock += 12 * H;
    const created = init.created ?? Math.min(clock, now - 30 * H);
    w.change(id, (doc) => {
      // updated stays equal to created until the user edits it; "Remove examples" relies on that
      initItem(doc, { source: EXAMPLE, createdBy: EXAMPLE_ORIGIN, ...init, created });
      extra?.(doc);
    });
    written.push(id);
    return id;
  }
  const doneAt = (daysAgo: number) => (doc: Y.Doc) => metaMap(doc).set("done", now - daysAgo * D);

  const type = (id: string, spec: Parameters<typeof initType>[1], plural: string) => {
    if (w.get(id)) return;
    w.change(id, (doc) => initType(doc, { ...spec, plural }, { source: EXAMPLE, createdBy: EXAMPLE_ORIGIN, created: now - 22 * D }));
    written.push(id);
  };
  const person = "Person";
  const book = ex("book.name");
  const article = ex("article.name");
  type(EX_TYPES.person, { name: person, icon: "user", color: "teal", description: ex("person.description"), capabilities: {}, properties: [] }, ex("person.plural"));
  type(
    EX_TYPES.book,
    {
      name: book,
      icon: "book",
      color: "brown",
      description: ex("book.description"),
      capabilities: {},
      properties: [
        { id: "p_ex_author", name: ex("book.author"), kind: "relation", multiple: true, target: `${typeKey}:${person}`, inverseName: ex("book.authorInverse") },
        {
          id: "p_ex_read",
          name: ex("book.reading"),
          kind: "status",
          default: "rd_want",
          options: [
            { id: "rd_want", name: ex("book.wantToRead"), group: "todo", color: "gray" },
            { id: "rd_now", name: ex("book.readingNow"), group: "active", color: "amber" },
            { id: "rd_done", name: ex("book.read"), group: "done", color: "green" },
          ],
        },
      ],
    },
    ex("book.plural"),
  );
  type(
    EX_TYPES.article,
    {
      name: article,
      icon: "file-text",
      color: "pink",
      description: ex("article.description"),
      capabilities: {},
      properties: [
        { id: "p_ex_lang", name: t("prop.language"), kind: "select", options: [{ id: "lang_de", name: "DE", color: "gray" }, { id: "lang_en", name: "EN", color: "gray" }] },
        { id: "p_ex_stage", name: ex("article.stage"), kind: "select", options: [{ id: "stage_draft", name: ex("article.draft"), color: "amber" }, { id: "stage_pub", name: ex("article.published"), color: "green" }] },
        { id: "p_ex_tr", name: ex("article.translation"), kind: "relation", target: `${typeKey}:${article}`, symmetric: true },
      ],
    },
    ex("article.plural"),
  );

  const [k0, k1, k2, k3, k4] = keysFor(5);
  const relaunchTitle = ex("relaunch.title");
  const weekTitle = ex("week.title");
  const customerTitle = "Studio Nordlicht";
  put("ex-welcome", {
    title: ex("welcome.title"),
    pinned: k0,
    body: ex("welcome.body", { relaunch: relaunchTitle, customer: customerTitle, book, week: weekTitle }),
  });

  const work = put("ex-work", {
    title: ex("work.title"),
    pinned: k1,
    body:
      ex("work.body") +
      block({ title: ex("work.activeProjects"), where: { and: [{ type: SYS.project }, { under: here }, { status: "active" }] }, columns: ["progress", "next"] }),
  });
  const clients = put("ex-clients", { title: ex("clients.title"), parents: [work], body: ex("clients.body") });
  const nordlicht = put("ex-nordlicht", {
    title: customerTitle,
    parents: [clients],
    body: ex("nordlicht.body") + block({ title: ex("nordlicht.openTasks"), where: { and: [{ type: SYS.task }, { under: here }, { status: "open" }] }, sort: [{ key: "due" }] }),
  });
  const relaunch = put(
    "ex-relaunch",
    {
      type: SYS.project,
      title: relaunchTitle,
      parents: [work, nordlicht],
      props: { p_status: "st_active", p_priority: "pr_high", p_period: `${day(-20)}/${day(30)}`, p_summary: ex("relaunch.summary") },
      body: ex("relaunch.body"),
    },
    (doc) => {
      appendUpdate(doc, { at: now - 9 * D, text: ex("relaunch.update1"), by: "you" });
      appendUpdate(doc, { at: now - 2 * D, text: ex("relaunch.update2"), by: "agent:claude" });
    },
  );
  const design = put("ex-design", { type: SYS.project, title: ex("design.title"), parents: [relaunch], props: { p_status: "st_active", p_period: `${day(-20)}/${day(3)}` } });
  put("ex-t-moodboard", { type: SYS.task, title: ex("task.moodboard"), parents: [design], props: { p_status: "st_done" } }, doneAt(10));
  put("ex-t-mockups", { type: SYS.task, title: ex("task.mockups"), parents: [design], props: { p_status: "st_active", p_priority: "pr_high", p_due: day(0) } });
  const build = put("ex-build", { type: SYS.project, title: ex("build.title"), parents: [relaunch], props: { p_status: "st_planning", p_period: `${day(0)}/${day(30)}` } });
  put("ex-t-cms", { type: SYS.task, title: ex("task.cms"), parents: [build], props: { p_status: "st_todo", p_priority: "pr_high", p_due: day(-2) } });
  const pages = put("ex-t-pages", { type: SYS.task, title: ex("task.pages"), parents: [build], props: { p_status: "st_todo", p_due: day(6) } });
  put("ex-t-pages-home", { type: SYS.task, title: ex("task.pagesHome"), parents: [pages], props: { p_status: "st_done" } }, doneAt(1));
  put("ex-t-pages-about", { type: SYS.task, title: ex("task.pagesAbout"), parents: [pages], props: { p_status: "st_todo" } });
  put("ex-t-pages-contact", { type: SYS.task, title: ex("task.pagesContact"), parents: [pages], props: { p_status: "st_todo" } });
  put("ex-t-launch", { type: SYS.task, title: ex("task.launch"), parents: [build], props: { p_status: "st_todo", p_due: day(14) }, rels: { [BLOCKED_BY]: [pages] } });
  put("ex-n-kickoff", {
    title: ex("kickoff.title"),
    parents: [relaunch],
    body: ex("kickoff.body"),
  });
  put("ex-newsletter", {
    type: SYS.project,
    title: ex("newsletter.title"),
    parents: [work],
    props: { p_status: "st_paused", p_priority: "pr_low", p_summary: ex("newsletter.summary") },
  });

  const learn = put("ex-learn", { title: ex("learn.title"), pinned: k2, body: ex("learn.body") });
  const course = put("ex-course", {
    title: ex("course.title"),
    parents: [learn],
    body: ex("course.body"),
  });
  const nf = ex("card.normalForms");
  const btree = ex("card.btree");
  put("ex-k-nf", {
    type: SYS.card,
    title: nf,
    parents: [course],
    body: ex("card.normalFormsBody", { btree }),
  });
  put("ex-k-btree", {
    type: SYS.card,
    title: btree,
    parents: [course],
    body: ex("card.btreeBody", { nf }),
  });
  const diagram = files.diagram;
  const sheet = files.sheet;
  put("ex-n-lecture", {
    title: ex("lecture.title"),
    parents: [course],
    body:
      ex("lecture.body") +
      (diagram ? `![[${diagram.name}]]\n\n` : "") +
      ex("lecture.question", { nf }) +
      (sheet ? ex("lecture.exercise", { sheet: sheet.name }) : ""),
  });
  if (diagram) put("ex-f-diagram", { kind: "file", title: diagram.name, parents: [course] }, (doc) => setFileMeta(doc, { ...diagram, width: 640, height: 220 }));
  if (sheet) put("ex-f-sheet", { kind: "file", title: sheet.name, parents: [course] }, (doc) => setFileMeta(doc, sheet));

  const personal = put("ex-personal", {
    title: ex("personal.title"),
    pinned: k3,
    body:
      ex("personal.body") +
      block({ title: ex("personal.readingList"), where: { and: [{ type: EX_TYPES.book }, { under: here }] }, view: "table" }),
  });
  // people need no place: they are on the type's page and on their books
  const lena = put("ex-p-lena", { type: EX_TYPES.person, title: "Lena Berg" });
  const jonas = put("ex-p-jonas", { type: EX_TYPES.person, title: "Jonas Falk" });
  put("ex-b-city", { type: EX_TYPES.book, title: ex("bookCity.title"), parents: [personal], props: { p_ex_read: "rd_done" }, rels: { p_ex_author: [lena] } }, doneAt(12));
  put("ex-b-moor", { type: EX_TYPES.book, title: ex("bookMoor.title"), parents: [personal], props: { p_ex_read: "rd_now" }, rels: { p_ex_author: [lena] } });
  put("ex-b-systems", { type: EX_TYPES.book, title: ex("bookSystems.title"), parents: [personal], props: { p_ex_read: "rd_want" }, rels: { p_ex_author: [jonas] }, body: ex("bookSystems.body") });
  const blog = put("ex-blog", { title: ex("blog.title"), parents: [personal], body: ex("blog.body") });
  // the language switch on an article comes from "Language" plus the symmetric "Translation"
  const artDe = put("ex-art-de", {
    type: EX_TYPES.article,
    title: ex("articleDe.title"),
    parents: [blog],
    props: { p_ex_lang: "lang_de", p_ex_stage: "stage_pub" },
    body: ex("articleDe.body"),
  });
  put("ex-art-en", {
    type: EX_TYPES.article,
    title: "Why I write offline first",
    parents: [blog],
    props: { p_ex_lang: "lang_en", p_ex_stage: "stage_draft" },
    rels: { p_ex_tr: [artDe] },
    body: "Notes belong on my own device first. Then they never get lost, not even on a train without signal.\n",
  });

  put("ex-week", {
    title: weekTitle,
    pinned: k4,
    body:
      ex("week.body") +
      block({ title: weekTitle, where: { and: [{ status: "open" }, { prop: "due", op: "<=", value: "+7d" }] }, sort: [{ key: "due" }], group: "path" }),
  });

  put("ex-i-references", {
    created: hoursAgo(20),
    title: ex("idea.references"),
    body: ex("idea.referencesBody", { relaunch: relaunchTitle }),
  });
  put("ex-i-podcast", { created: hoursAgo(9), title: ex("idea.podcast") });
  put("ex-i-bike", { created: hoursAgo(4), title: ex("idea.bike") });
  const trip = put("ex-i-trip", { created: hoursAgo(26), title: ex("trip.title"), body: ex("trip.body") });
  put("ex-i-trip-1", { created: hoursAgo(25), title: ex("trip.trains"), parents: [trip] });
  put("ex-i-trip-2", { created: hoursAgo(2), title: ex("trip.flat"), parents: [trip] });

  return written;
}

export interface ExampleEntry {
  id: string;
  title: string;
  type: string | null;
  isType: boolean;
  /** Edited since the setup or used by the user's own entries; kept unless chosen. */
  changed: boolean;
  /** A type with non-example entries; never removed. */
  inUse: boolean;
}

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
  // types last: they go only when none of their entries is left
  return out.sort((a, b) => Number(a.isType) - Number(b.isType));
}

/**
 * Each id is trashed by itself (no cascade), so each comes back alone. A type goes only if no
 * living entry of it is left. Returns what was removed, for "Undo".
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

function erDiagram(lang: Lang): string {
  const ex = (key: string, values?: Values) => translate(lang, `sample.${key}`, values);
  const box = (x: number, title: string, rows: string[], fill: string) =>
    `<g transform="translate(${x} 70)"><rect width="160" height="${44 + rows.length * 24}" rx="10" fill="#fff" stroke="${fill}" stroke-width="2"/>` +
    `<rect width="160" height="36" rx="10" fill="${fill}"/><rect y="26" width="160" height="10" fill="${fill}"/>` +
    `<text x="80" y="24" text-anchor="middle" font-weight="600" fill="#fff">${title}</text>` +
    rows.map((r, i) => `<text x="14" y="${60 + i * 24}" fill="#333">${r}</text>`).join("") +
    `</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="220" viewBox="0 0 640 220" font-family="system-ui, sans-serif" font-size="14">
<rect width="640" height="220" fill="#f7f5f2"/>
<text x="24" y="36" font-size="16" font-weight="600" fill="#333">${ex("diagram.title")}</text>
<path d="M184 120 H240 M400 120 H456" stroke="#888" stroke-width="2"/>
<text x="200" y="112" fill="#666">1</text><text x="226" y="112" fill="#666">n</text>
<text x="410" y="112" fill="#666">n</text><text x="440" y="112" fill="#666">1</text>
${box(24, "Student", [ex("diagram.studentNo"), "Name"], "#2f6ae0")}
${box(240, ex("diagram.enrolment"), [ex("diagram.term"), ex("diagram.grade")], "#8b4fd8")}
${box(456, ex("diagram.course"), [ex("diagram.courseNo"), ex("diagram.courseTitle"), "ECTS"], "#23905f")}
</svg>
`;
}

/** Hand-built one-page PDF (Helvetica, WinAnsi), so no PDF library is needed. */
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
