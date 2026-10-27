import { test, expect } from "bun:test";
import { MemRepo } from "./helpers";
import { runSetup, SYS, defaultStartBody, upgradeStartPage, isDefaultStartBody } from "@obtion/core/setup";
import { findBlocks, readBlock, runQuery, parseQuery } from "@obtion/core/query";
import { addDaysISO, todayISO, SETTINGS_ID, replaceBody } from "@obtion/core/model";
import { dayBrief } from "@obtion/core/today";

function world() {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  const active = m.add({ title: "Website", type: SYS.project, props: { p_status: "st_active" } });
  const paused = m.add({ title: "Altes Projekt", type: SYS.project, props: { p_status: "st_paused" } });
  const finished = m.add({ title: "Fertiges Projekt", type: SYS.project, props: { p_status: "st_done" } });
  const t = (title: string, parent: string, props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    m.add({ title, type: SYS.task, parents: [parent], props: { p_status: "st_todo", ...props } as any, ...extra });
  return { m, active, paused, finished, t };
}

function blocks(m: MemRepo) {
  const ix = m.index();
  const body = defaultStartBody("de");
  return findBlocks(body).map((b) => readBlock(b.src, ix).def);
}
const titles = (m: MemRepo, i: number) => {
  const ix = m.index();
  return runQuery(blocks(m)[i]!, { ix }).items.map((x) => x.title).sort();
};

test("tasks of paused or finished projects stay out of the urgent sections", () => {
  const { m, active, paused, finished, t } = world();
  t("Überfällig aktiv", active, { p_due: addDaysISO(-1) });
  t("Überfällig pausiert", paused, { p_due: addDaysISO(-1) });
  t("Überfällig fertig", finished, { p_due: addDaysISO(-1) });
  t("Heute aktiv", active, { p_due: todayISO() });
  t("Heute pausiert", paused, { p_due: todayISO() });
  t("Läuft", active, { p_status: "st_active" });
  t("Läuft im pausierten", paused, { p_status: "st_active" });
  t("Selbst pausiert", active, { p_status: "st_paused" });
  expect(titles(m, 0)).toEqual(["Überfällig aktiv"]);
  expect(titles(m, 1)).toEqual(["Heute aktiv"]);
  expect(titles(m, 3)).toEqual(["Läuft"]);
  // active projects: the paused one (group active) is not listed
  expect(titles(m, 4)).toEqual(["Website"]);
});

test("the next task: open, not blocked, no open subtasks; due by today, then in progress, then priority", () => {
  const { m, active, t } = world();
  const ix = () => m.index();
  const next = () => ix().nextTask(active, todayISO())?.title;
  const container = t("Großer Block", active, { p_due: addDaysISO(-3) });
  t("Unteraufgabe", container, { p_priority: "pr_low" });
  expect(next()).toBe("Unteraufgabe"); // the container itself has open subtasks
  const blocker = t("Zertifikat", active, { p_priority: "pr_high" });
  t("Gesperrt", active, { p_due: addDaysISO(-5) }, { rels: { p_blocked: [blocker] } });
  t("Wartet", active, { p_due: addDaysISO(-5), p_waiting: "Kunde" });
  expect(next()).toBe("Zertifikat"); // blocked and waiting tasks are skipped; high priority first
  t("Läuft", active, { p_status: "st_active" });
  expect(next()).toBe("Läuft"); // in progress before priority
  t("Fällig heute", active, { p_due: todayISO() });
  expect(next()).toBe("Fällig heute"); // due by today before everything
  t("Längst fällig", active, { p_due: addDaysISO(-2) });
  expect(next()).toBe("Längst fällig");
  // the start page shows it in the list of active projects
  const q = parseQuery("typ:Projekt status:aktiv -ruhend spalten:nächste", ix());
  expect(q.def.columns).toEqual(["next"]);
  expect(q.def.where).toEqual({ and: [{ type: SYS.project }, { status: "active" }, { not: { dormant: true } }] });
});

test("recently done: done within 7 days, newest first", () => {
  const { m, active, t } = world();
  const a = t("Gestern erledigt", active, { p_status: "st_done" });
  const b = t("Heute erledigt", active, { p_status: "st_done" });
  t("Längst erledigt", active, { p_status: "st_done" });
  t("Offen", active);
  const at = (id: string, ms: number) => m.change(id, (d) => d.getMap("meta").set("done", ms));
  at(a, Date.now() - 864e5);
  at(b, Date.now());
  at(m.index().live.find((x) => x.title === "Längst erledigt")!.id, Date.now() - 30 * 864e5);
  const ix = m.index();
  expect(runQuery(blocks(m)[6]!, { ix }).items.map((x) => x.title)).toEqual(["Heute erledigt", "Gestern erledigt"]);
});

test("an unchanged start page gets the new default; an edited one stays", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  const old = (start: string) => m.change(SETTINGS_ID, (d) => replaceBody(d, start));
  // the page as the first setup wrote it
  const v1 = m.get(SETTINGS_ID)!.body.replace(defaultStartBody("de"), "");
  expect(v1).toBe(""); // setup already writes the new default
  old(startV1());
  expect(upgradeStartPage(m.writer, "de")).toBe(true);
  expect(m.get(SETTINGS_ID)!.body).toBe(defaultStartBody("de"));
  old(startV1() + "\nMeine Notiz");
  expect(upgradeStartPage(m.writer, "de")).toBe(false);
  expect(m.get(SETTINGS_ID)!.body).toContain("Meine Notiz");
});

/** The first default, as it was written before the start rules (copied from setup.ts history). */
function startV1() {
  const f = (o: unknown) => "```abfrage\n" + JSON.stringify(o) + "\n```";
  return [
    "## Fokus",
    f({ title: "Überfällig", hideEmpty: true, where: { and: [{ status: "open" }, { prop: "due", op: "<", value: "+0d" }] }, sort: [{ key: "due" }] }),
    f({ title: "Heute", hideEmpty: true, where: { and: [{ status: "open" }, { prop: "due", op: ":", value: "+0d" }] } }),
    f({ title: "Nächste 7 Tage", hideEmpty: true, where: { and: [{ status: "open" }, { prop: "due", op: ">", value: "+0d" }, { prop: "due", op: "<=", value: "+7d" }] }, sort: [{ key: "due" }] }),
    f({ title: "In Arbeit", hideEmpty: true, where: { and: [{ type: SYS.task }, { status: "active" }] } }),
    "\n## Aktive Projekte",
    f({ where: { and: [{ type: SYS.project }, { status: "active" }] }, sort: [{ key: "updated", desc: true }] }),
    "\n## Eingang",
    f({ where: { inbox: true }, sort: [{ key: "created", desc: true }], limit: 5 }),
    "\n## Zuletzt bearbeitet",
    f({ where: { not: { inbox: true } }, sort: [{ key: "updated", desc: true }], limit: 6 }),
  ].join("\n");
}

test("a start page as shipped in version 2 is brought up to date", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  m.change(SETTINGS_ID, (d) => replaceBody(d, defaultStartBody("de", 2)));
  expect(upgradeStartPage(m.writer, "de")).toBe(true);
  expect(m.get(SETTINGS_ID)!.body).toBe(defaultStartBody("de"));
  expect(upgradeStartPage(m.writer, "de")).toBe(false);
  // "In Arbeit" leaves out what "Nächste 7 Tage" shows already
  expect(defaultStartBody("de")).toContain('{"not":{"prop":"due","op":"<=","value":"+7d"}}');
});

test("the day in one line: due today, overdue, inbox, the first step – or the next date", () => {
  const { m, active, paused, t } = world();
  const today = todayISO();
  expect(dayBrief(m.index(), today).first).toBeUndefined();
  t("Später", active, { p_due: addDaysISO(5) });
  t("Noch später", active, { p_due: addDaysISO(9) });
  let b = dayBrief(m.index(), today);
  expect([b.today.length, b.overdue.length, b.next?.item.title]).toEqual([0, 0, "Später"]); // nothing due: the next date
  t("Heute dran", active, { p_due: today });
  t("Längst überfällig", active, { p_due: addDaysISO(-4) });
  t("Überfällig", active, { p_due: addDaysISO(-1) });
  t("Ruht", paused, { p_due: addDaysISO(-9) }); // below a paused project: not counted
  t("Erledigt", active, { p_due: addDaysISO(-2), p_status: "st_done" });
  m.add({ title: "Gedanke" }); // inbox
  b = dayBrief(m.index(), today);
  expect(b.today.map((x) => x.title)).toEqual(["Heute dran"]);
  expect(b.overdue.map((x) => x.title)).toEqual(["Längst überfällig", "Überfällig"]);
  expect(b.first?.title).toBe("Längst überfällig");
  expect(b.next).toBeUndefined();
  expect(b.inbox).toBeGreaterThanOrEqual(1);
});

test("the unchanged start page follows the UI language", () => {
  expect(isDefaultStartBody(defaultStartBody("de"))).toBe(true);
  expect(isDefaultStartBody(defaultStartBody("en"))).toBe(true);
  expect(isDefaultStartBody(defaultStartBody("de") + "\nMeine Notiz")).toBe(false);
});

test("recently edited leaves out files (version 4); a version 3 start page is brought up to date", () => {
  const m = new MemRepo();
  runSetup(m.writer, "de");
  m.change(SETTINGS_ID, (d) => replaceBody(d, defaultStartBody("de", 3)));
  expect(upgradeStartPage(m.writer, "de")).toBe(true);
  m.add({ title: "Meeting", parents: [m.add({ title: "Projekt" })], body: "![[bild.png]]" });
  m.add({ kind: "datei", title: "bild.png" });
  const ix = m.index();
  const recent = findBlocks(defaultStartBody("de")).map((b) => readBlock(b.src, ix).def).at(-1)!;
  expect(runQuery(recent, { ix }).items.map((i) => i.title)).not.toContain("bild.png");
});

test("start version 5: cards in two columns split by ---, projects with progress, the done card closed, no recently edited", () => {
  const body = defaultStartBody("de");
  const [main, side] = body.split(/^\s*---\s*$/m);
  expect(side).toBeDefined();
  expect(main).toContain("## Fokus");
  expect(main).toContain("## Aktive Projekte");
  expect(side).toContain("## Eingang");
  expect(body).not.toContain("Zuletzt bearbeitet");
  const r = new MemRepo();
  const defs = findBlocks(body).map((b) => readBlock(b.src, r.index()).def);
  expect(defs.find((d) => d.columns?.includes("progress"))?.columns).toEqual(["progress", "next"]);
  expect(defs.find((d) => d.where && "inbox" in d.where)?.limit).toBe(3);
  expect(defs.at(-1)!.collapsed).toBe(true);
  // the options are words in the query text too
  expect(parseQuery("typ:Task zu:ja spalten:fortschritt,nächste", r.index()).def).toMatchObject({ collapsed: true, columns: ["progress", "next"] });
  // a version 4 start page as shipped is brought up to date
  runSetup(r.writer, "de");
  r.change(SETTINGS_ID, (d) => replaceBody(d, defaultStartBody("de", 4)));
  expect(upgradeStartPage(r.writer, "de")).toBe(true);
  expect(r.get(SETTINGS_ID)!.body).toBe(body);
});
