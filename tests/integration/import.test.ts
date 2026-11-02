// `obtion import` against a real server: a Git repository made here (several commits, nested
// folders, README per folder, links between notes, binary and CRLF files, odd names, LFS-less),
// the completeness report, contents byte for byte, an idempotent second run, and a conflict after
// an edit in Obtion.
import { test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tempDir, removeTempDirs } from "../support/helpers";
import { ROOT, bootServer, mcpTool, post } from "../support/server";

setDefaultTimeout(120_000);

let base = "";
let proc: ReturnType<typeof Bun.spawn>;
let ws = "";
let token = "";
let repo = "";
let work = "";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const tool = (name: string, args: unknown) => mcpTool(base, token, name, args, `/w/${ws}/mcp`);

type Item = {
  id: string;
  title: string;
  kind: string;
  type: string | null;
  body?: string;
  parents: string[];
  source?: string;
  file?: { name: string; hash: string };
  updates?: { at: number; text: string }[];
};
async function items(under: string): Promise<Item[]> {
  const res = await fetch(`${base}/w/${ws}/api/items?under=${encodeURIComponent(under)}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Item[] }).items;
}
const bySource = async (path: string) => [...(await items("Altes Repo")), ...(await items("Werkzeugkiste"))].find((i) => i.source === `repo:ablage/${path}`);

async function obtion(args: string[]) {
  const p = Bun.spawn([process.execPath, join(ROOT, "apps/cli/src/index.ts"), ...args], {
    cwd: work,
    env: { ...process.env, OBTION_CONFIG: join(work, "none.json"), OBTION_SERVER: base, OBTION_WORKSPACE: ws, OBTION_TOKEN: token, TMPDIR: work },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

function git(...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}
let day = 0;
function commit(message: string) {
  day++;
  const date = `2026-0${Math.min(day, 9)}-1${day}T10:00:00+02:00`;
  git("add", "-A");
  const p = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.org",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.org",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString() + p.stdout.toString());
}
function put(path: string, content: string | Uint8Array) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

const BIN = new Uint8Array(100_000).map((_, i) => (i * 31 + (i >> 8)) % 256);
const CRLF = "Kunde ACME\r\n\r\nStand: [Status](STATUS_2026-10-30.md#6-offen), Schema `sources/schema.xsd`.\r\n";
const ODD = "kunden/Austria_Beispiel/Prüfung #1 [alt] & Co.txt";

beforeAll(async () => {
  ({ url: base, proc } = await bootServer({ OBTION_DATA: tempDir("obtion-import-"), OBTION_WEB_APP: "off", OBTION_SIGNUP: "open" }));
  const owner = await post(base, "/api/account/signup", { name: "Owner", email: "owner@example.org", password: "geheim12345" }).then((r) => r.json());
  ws = (await post(base, "/api/workspaces", { name: "Arbeit" }, owner.token).then((r) => r.json())).id;
  token = (await post(base, `/api/workspaces/${ws}/mcp-token`, {}, owner.token).then((r) => r.json())).token;
  await tool("define_type", {
    name: "Projekt",
    properties: [{ name: "Status", kind: "select", options: ["Offen (todo)", "Aktiv (active)", "Fertig (done)"] }],
    capabilities: { status: "Status", updates: true },
  });

  work = tempDir("obtion-import-work-");
  repo = join(tempDir("obtion-import-repo-"), "ablage");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  put("README.md", "# Ablage\n\nKunden: [ACME](kunden/Germany_ACME/) und [Beispiel](kunden/Austria_Beispiel/README.md). Regeln in CLAUDE.md.\n");
  put("CLAUDE.md", "Regeln: Werkzeuge liegen in `_tools/run.py`.\n");
  put(".gitignore", "*.tmp\n");
  put("leer/.gitkeep", "");
  commit("Start: Ablage angelegt");
  put("kunden/Germany_ACME/README.md", CRLF);
  put("kunden/Germany_ACME/STATUS_2026-10-30.md", "## 6 offen\n\nSiehe ../Austria_Beispiel/README.md und [fehlt](nicht-da.md).\n");
  put("kunden/Germany_ACME/sources/schema.xsd", '<?xml version="1.0"?>\n<xs:schema/>\n');
  put("kunden/Germany_ACME/sources/daten.bin", BIN);
  commit("ACME: Status und Quellen\n\nLange Nachricht\nmit zwei Zeilen.");
  put("kunden/Austria_Beispiel/README.md", "Beispielkunde, mehr in STATUS_2026-10-30.md §6.\n");
  put(ODD, "seltsamer Name\n");
  put("kunden/Austria_Beispiel/latin1.md", new Uint8Array([0x47, 0x72, 0xf6, 0xdf, 0x65, 0x0a])); // "Größe" in Latin-1
  put("_tools/run.py", "print('hallo')\n");
  commit("Beispiel und Werkzeuge");
  // a place outside the import's root, named by a rule
  await tool("create", { items: [{ title: "Werkzeugkiste", pin: true }] });
  writeFileSync(
    join(work, "mapping.json"),
    JSON.stringify({
      rules_file: "CLAUDE.md",
      rules: [
        { path: "kunden/Germany_*", match: "^Germany_(.+)$", title: "{1}", type: "Projekt" },
        { path: "_tools", parent: "Werkzeugkiste" },
        { path: "leer", parent: "path:kunden/Germany_ACME" }, // a deeper folder as parent
        { path: "kunden/Germany_ACME/sources/schema.xsd", pin: true },
      ],
    }),
  );
});
afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  removeTempDirs();
});

let report = "";

test("dry run plans without writing", async () => {
  const r = await obtion(["import", repo, "--into", "Altes Repo", "--config", "mapping.json", "--dry-run"]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Dry run, nothing written");
  expect(await fetch(`${base}/w/${ws}/api/items?under=Altes%20Repo`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.status)).toBe(404);
});

test("import: every tracked file arrives, the report proves it", async () => {
  const r = await obtion(["import", repo, "--into", "Altes Repo", "--config", "mapping.json", "--report", "bericht.md"]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  report = readFileSync(join(work, "bericht.md"), "utf8");
  expect(report).toContain("**Vollständig:**");
  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
  for (const p of tracked) expect(report).toContain(`| ${p.replace(/\|/g, "\\|")} |`);
  expect(report).toMatch(/\| \.gitignore \|  \| ignored \|/);
  expect(report).toMatch(/\| leer\/\.gitkeep \|  \| ignored \|/);

  const all = await items("Altes Repo");
  const root = all.find((i) => i.title === "Altes Repo")!;
  // README.md of the repo is the root's text, a folder's README.md the folder's
  expect(root.source).toBe("repo:ablage");
  const acme = (await bySource("kunden/Germany_ACME"))!;
  expect(acme.title).toBe("ACME");
  expect(acme.type).toBe("Projekt");
  const status = (await bySource("kunden/Germany_ACME/STATUS_2026-10-30.md"))!;
  const schema = (await bySource("kunden/Germany_ACME/sources/schema.xsd"))!;
  // CRLF kept, links rewritten to ids, nothing else changed
  expect(acme.body).toBe(`Kunde ACME\r\n\r\nStand: [[${status.id}#6-offen|Status]], Schema [[${schema.id}|sources/schema.xsd]].\r\n`);
  const beispiel = (await bySource("kunden/Austria_Beispiel"))!;
  expect(status.body).toBe(`## 6 offen\n\nSiehe [[${beispiel.id}|../Austria_Beispiel/README.md]] und [fehlt](nicht-da.md).\n`);
  expect(beispiel.body).toBe(`Beispielkunde, mehr in [[${status.id}|STATUS_2026-10-30.md]] §6.\n`);
  expect(root.body).toBe(`# Ablage\n\nKunden: [[${acme.id}|ACME]] und [[${beispiel.id}|Beispiel]]. Regeln in [[${(await bySource("CLAUDE.md"))!.id}|CLAUDE.md]].\n`);
  expect(report).toContain("`kunden/Germany_ACME/STATUS_2026-10-30.md`: `nicht-da.md`");
  // CLAUDE.md as the rules for agents
  const rules = (await bySource("CLAUDE.md"))!;
  expect(rules.title).toBe("Regeln für Agenten");
  expect(rules.body).toBe(`Regeln: Werkzeuge liegen in [[${(await bySource("_tools/run.py"))!.id}|_tools/run.py]].\n`);
  // binary, odd name, not UTF-8: files with the same SHA-256
  const bin = (await bySource("kunden/Germany_ACME/sources/daten.bin"))!;
  expect(bin.file!.hash).toBe(sha(BIN));
  const down = new Uint8Array(await (await fetch(`${base}/w/${ws}/api/files/${bin.id}`, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer());
  expect(sha(down)).toBe(sha(BIN));
  expect((await bySource(ODD))!.file!.name).toBe("Prüfung #1 [alt] & Co.txt");
  expect((await bySource("kunden/Austria_Beispiel/latin1.md"))!.kind).toBe("file");
  // places: the folder tree
  expect(schema.parents).toEqual([(await bySource("kunden/Germany_ACME/sources"))!.id]);
  expect((await bySource("leer"))!.parents).toEqual([acme.id]);
  // outside the root: below the mapped place, found and checked all the same
  const kiste = (await items("Werkzeugkiste")).find((i) => i.title === "Werkzeugkiste")!;
  const tools = (await items("Werkzeugkiste")).find((i) => i.source === "repo:ablage/_tools")!;
  expect(tools.parents).toEqual([kiste.id]);
  expect(report).toMatch(/\| _tools\/run\.py \| \w+ \| imported \|/);
  expect(JSON.parse(await tool("get", { ref: schema.id })).pinned).toBe(true);
  // the source is what agents see and search
  expect(await tool("get", { ref: status.id })).toContain('"source": "repo:ablage/kunden/Germany_ACME/STATUS_2026-10-30.md"');
  expect(await tool("search", { query: "Germany_ACME STATUS_2026-10-30" })).toContain(status.id);

  // history: every commit, updates dated like the commits, a bundle
  const hist = all.find((i) => i.title === "Git-Verlauf")!;
  for (const c of git("log", "--format=%H").trim().split("\n")) expect(hist.body).toContain(c);
  expect(hist.body).toContain("Lange Nachricht\nmit zwei Zeilen.");
  expect(acme.updates!.map((u) => new Date(u.at).toISOString().slice(0, 10))).toEqual(["2026-02-12"]);
  expect(acme.updates![0]!.text).toContain("ACME: Status und Quellen");
  expect(all.some((i) => i.title === "Verlauf kunden")).toBe(true);
  const bundle = all.find((i) => i.file?.name === "ablage.bundle")!;
  const clone = join(tempDir("obtion-import-clone-"), "c.bundle");
  writeFileSync(clone, new Uint8Array(await (await fetch(`${base}/w/${ws}/api/files/${bundle.id}`, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer()));
  expect(Bun.spawnSync(["git", "bundle", "verify", clone], { cwd: repo }).exitCode).toBe(0);
  const back = join(dirname(clone), "zurueck");
  expect(Bun.spawnSync(["git", "clone", "-q", clone, back]).exitCode).toBe(0);
  expect(readFileSync(join(back, "kunden/Germany_ACME/README.md"), "utf8")).toBe(CRLF);
  // the report as a note
  expect(all.some((i) => i.title.startsWith("Importbericht ablage "))).toBe(true);
});

test("a second run changes nothing", async () => {
  const before = [...(await items("Altes Repo")), ...(await items("Werkzeugkiste"))];
  const r = await obtion(["import", repo, "--into", "Altes Repo", "--config", "mapping.json", "--report", "bericht2.md"]);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/: 0 new, 0 updated, \d+ unchanged, 0 conflict/);
  const after = [...(await items("Altes Repo")), ...(await items("Werkzeugkiste"))];
  expect(after.length).toBe(before.length);
  const content = (xs: Item[]) =>
    xs
      .filter((i) => !i.title.startsWith("Importbericht") && !i.source?.endsWith("#state"))
      .map((i) => `${i.id} ${i.body ?? i.file?.hash} ${i.updates?.length ?? 0}`)
      .sort();
  expect(content(after)).toEqual(content(before));
});

test("repo changes go in; an edit in Obtion is never overwritten (conflict, exit 1)", async () => {
  put("kunden/Germany_ACME/STATUS_2026-10-30.md", "## 6 offen\n\nNeu im Repo.\n");
  put("kunden/Germany_ACME/sources/schema.xsd", "<xs:schema version='2'/>\n");
  put("kunden/Germany_ACME/neu.txt", "neu\n");
  put("kunden/Austria_Beispiel/README.md", "Beispielkunde, im Repo geändert.\n");
  // Git LFS pointers: one whose object is in the repo's LFS store, one whose isn't
  const scan = "%PDF-1.7 Scan\n";
  const pointer = (content: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${sha(content)}\nsize ${content.length}\n`;
  put("kunden/Germany_ACME/scan.PDF", pointer(scan));
  put(`.git/lfs/objects/${sha(scan).slice(0, 2)}/${sha(scan).slice(2, 4)}/${sha(scan)}`, scan);
  put("kunden/Germany_ACME/fehlt.PDF", pointer("nie geholt"));
  commit("ACME: Stand 2");
  await tool("update", { ref: (await bySource("kunden/Austria_Beispiel"))!.id, body: " (in Obtion ergänzt)", body_mode: "append" });

  const r = await obtion(["import", repo, "--into", "Altes Repo", "--config", "mapping.json", "--report", "bericht3.md"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("conflict  kunden/Austria_Beispiel/README.md");
  expect((await bySource("kunden/Austria_Beispiel"))!.body).toContain("(in Obtion ergänzt)");
  expect((await bySource("kunden/Germany_ACME/STATUS_2026-10-30.md"))!.body).toBe("## 6 offen\n\nNeu im Repo.\n");
  expect((await bySource("kunden/Germany_ACME/sources/schema.xsd"))!.file!.hash).toBe(sha("<xs:schema version='2'/>\n"));
  expect((await bySource("kunden/Germany_ACME/neu.txt"))!.file!.hash).toBe(sha("neu\n"));
  const acme = (await bySource("kunden/Germany_ACME"))!;
  expect(acme.updates!.map((u) => new Date(u.at).toISOString().slice(0, 10))).toEqual(["2026-02-12", "2026-04-14"]);
  const rep = readFileSync(join(work, "bericht3.md"), "utf8");
  expect((await bySource("kunden/Germany_ACME/scan.PDF"))!.file!.hash).toBe(sha("%PDF-1.7 Scan\n"));
  expect(await bySource("kunden/Germany_ACME/fehlt.PDF")).toBeUndefined();
  expect(rep).toMatch(/\| kunden\/Germany_ACME\/fehlt\.PDF \|  \| failed \|.*Git LFS pointer/);
  // the conflict, the pointer without content, and (where git-lfs is installed) that content missing as an LFS version
  const lfs = Bun.spawnSync(["git", "lfs", "version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  expect(rep).toContain(`**Unvollständig: ${lfs ? 3 : 2} Problem(e)**`);
  expect(rep).toMatch(/\| kunden\/Austria_Beispiel\/README\.md \| \w+ \| conflict \|/);
  expect(rep).toMatch(/\| kunden\/Germany_ACME\/sources\/schema\.xsd \| \w+ \| updated \|/);
  // the same items, no duplicates
  expect((await items("Altes Repo")).filter((i) => i.source === "repo:ablage/kunden/Germany_ACME/STATUS_2026-10-30.md")).toHaveLength(1);
});

test("folders that can't be made (a cycle of path: parents) make the report incomplete", async () => {
  const other = join(tempDir("obtion-import-cycle-"), "zyklus");
  mkdirSync(join(other, "a"), { recursive: true });
  mkdirSync(join(other, "z"), { recursive: true });
  writeFileSync(join(other, "a", ".gitkeep"), "");
  writeFileSync(join(other, "z", ".gitkeep"), "");
  writeFileSync(
    join(work, "zyklus.json"),
    JSON.stringify({
      rules: [
        { path: "a", parent: "path:z" },
        { path: "z", parent: "path:a" },
      ],
    }),
  );
  const r = await obtion(["import", other, "--into", "Zyklus", "--config", "zyklus.json", "--report", "zyklus.md"]);
  expect(r.code).toBe(1);
  const rep = readFileSync(join(work, "zyklus.md"), "utf8");
  expect(rep).toContain("**Unvollständig: 2 Problem(e)**");
  expect(rep).toContain("## Ordner nicht angelegt (2)");
});
