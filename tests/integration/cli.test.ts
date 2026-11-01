// The `obtion` CLI against a real server: login, pull a subtree as a folder, status, push edits,
// new notes, folders and files, conflicts with edits in Obtion, deletions only with --delete.
import { test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tempDir, removeTempDirs } from "../support/helpers";
import { ROOT, bootServer, mcpTool, post } from "../support/server";

setDefaultTimeout(120_000);

let base = "";
let proc: ReturnType<typeof Bun.spawn>;
let ws = "";
let token = "";
let config = "";
let dir = "";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const tool = (name: string, args: unknown) => mcpTool(base, token, name, args, `/w/${ws}/mcp`);
const idOf = (answer: string) => /\[([0-9a-z]{17})\]/.exec(answer)![1]!;

/** Runs the CLI as a program, like a user or an agent does. */
async function obtion(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const p = Bun.spawn([process.execPath, join(ROOT, "apps/cli/src/index.ts"), ...args], {
    cwd: dir && existsSync(dir) ? dir : ROOT,
    env: { ...process.env, OBTION_CONFIG: config, OBTION_TOKEN: "", OBTION_SERVER: "", OBTION_WORKSPACE: "", ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

async function tree(under: string) {
  const res = await fetch(`${base}/w/${ws}/api/items?under=${encodeURIComponent(under)}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as { root: string; items: { id: string; title: string; kind: string; body?: string; parents: string[]; file?: { name: string; hash: string } }[] };
}
const byTitle = async (t: string) => (await tree(rootId)).items.find((i) => i.title === t);
const read = (p: string) => readFileSync(join(dir, p));
const bodyOf = (p: string) => read(p).toString("utf8").replace(/^---\n[\s\S]*?\n---\n/, "");

let rootId = "";
const XSD = '<?xml version="1.0"?>\n<xs:schema/>\n';

beforeAll(async () => {
  ({ url: base, proc } = await bootServer({ OBTION_DATA: tempDir("obtion-cli-"), OBTION_WEB_APP: "off", OBTION_SIGNUP: "open" }));
  const owner = await post(base, "/api/account/signup", { name: "Owner", email: "owner@example.org", password: "geheim12345" }).then((r) => r.json());
  ws = (await post(base, "/api/workspaces", { name: "Projekt" }, owner.token).then((r) => r.json())).id;
  token = (await post(base, `/api/workspaces/${ws}/mcp-token`, {}, owner.token).then((r) => r.json())).token;
  config = join(tempDir("obtion-cli-config-"), "sub", "config.json");

  rootId = idOf(await tool("create", { items: [{ title: "Kunde A", pin: true, body: "Seite des Kunden" }] }));
  await tool("create", {
    items: [
      { title: "Notizen", parents: [rootId], body: "Zeile 1\r\nZeile 2 😀\r\n" },
      { title: "Mapping", parents: [rootId], body: "Projekt-Mapping" },
      { title: "A/B: C?", parents: [rootId], body: "unerlaubte Zeichen" },
      { title: "CON", parents: [rootId] },
      { title: "Doppelt", parents: [rootId], body: "eins" },
    ],
  });
  await tool("create", { items: [{ title: "Doppelt", parents: [rootId], body: "zwei" }] });
  await tool("create", { items: [{ title: "Ablauf", parents: ["Mapping"], body: "---\ntitle: eigener Kopf\n---\nText" }] });
  // below two parents in the subtree: once, at its home
  await tool("create", { items: [{ title: "Geteilt", parents: [rootId, "Mapping"], body: "einmal" }] });
  await tool("place", { ref: "Geteilt", home: "Mapping" });
  const up = await fetch(`${base}/w/${ws}/api/files?name=schema.xsd&parent=Mapping`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: XSD });
  expect(up.status).toBe(201);
});
afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  removeTempDirs();
});

test("login: token from stdin, checked, stored for this user only", async () => {
  const bad = await obtion(["login", base, "--workspace", ws], { stdin: "falsch\n" });
  expect(bad.code).toBe(2);
  expect(existsSync(config)).toBe(false);
  const ok = await obtion(["login", base + "/", "--workspace", ws], { stdin: `${token}\n` });
  expect(ok.err).toBe("");
  expect(ok.code).toBe(0);
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ server: base, workspace: ws, token });
  if (process.platform !== "win32") expect(statSync(config).mode & 0o777).toBe(0o600);
});

test("pull mirrors the subtree: folders, notes with front matter, originals, safe and unique names", async () => {
  dir = join(tempDir("obtion-cli-dir-"), "kunde");
  const r = await obtion(["pull", "Kunde A", dir]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  const files = readdirSync(dir).sort();
  expect(files).toEqual([".obtion", "A_B_ C_.md", "Doppelt (2).md", "Doppelt.md", "Mapping", "Notizen.md", "README.md", "_CON.md"]);
  expect(readdirSync(join(dir, "Mapping")).sort()).toEqual(["Ablauf.md", "Geteilt.md", "README.md", "schema.xsd"]);
  // bytes exactly as in Obtion: CRLF, emoji, a body's own front matter
  expect(bodyOf("Notizen.md")).toBe("Zeile 1\r\nZeile 2 😀\r\n");
  expect(read("Notizen.md").toString()).toMatch(/^---\nobtion_id: [0-9a-z]{17}\nobtion_version: [0-9a-f]{12}\n---\n/);
  expect(bodyOf("Mapping/Ablauf.md")).toBe("---\ntitle: eigener Kopf\n---\nText");
  expect(bodyOf("README.md")).toBe("Seite des Kunden");
  expect(bodyOf("Doppelt.md")).toBe("eins");
  expect(bodyOf("Doppelt (2).md")).toBe("zwei");
  expect(read("Mapping/schema.xsd").toString()).toBe(XSD);
  const st = await obtion(["status"], { env: {} });
  expect(st.out).toContain("No local changes.");
  expect(st.out).toContain("No changes in Obtion.");
});

test("push: edited note with base_version, new note, new folder with README, new and changed binary files", async () => {
  writeFileSync(join(dir, "Notizen.md"), read("Notizen.md").toString().replace("😀", "😁 bearbeitet"));
  writeFileSync(join(dir, "Neu.md"), "Neue Notiz\r\nmit CRLF\r\n");
  const bin = new Uint8Array(70_000).map((_, i) => (i * 7919) % 256);
  writeFileSync(join(dir, "daten.bin"), bin);
  mkdirSync(join(dir, "Tools"));
  writeFileSync(join(dir, "Tools", "run.py"), "print('hallo')\n");
  writeFileSync(join(dir, "Tools", "README.md"), "# Tools\nStart: python run.py\n");
  writeFileSync(join(dir, "Mapping", "schema.xsd"), XSD.replace("schema/", "schema version=\"2\"/"));
  writeFileSync(join(dir, ".DS_Store"), "ignored");

  const st = await obtion(["status"]);
  expect(st.out).toContain("modified  Notizen.md");
  expect(st.out).toContain("modified  Mapping/schema.xsd");
  expect(st.out).toContain("new       Tools/");
  expect(st.out).not.toContain(".DS_Store");

  const dry = await obtion(["push", "--dry-run"]);
  expect(dry.code).toBe(0);
  expect(dry.out).toContain("Dry run, nothing sent");
  expect((await byTitle("Neu"))).toBeUndefined();

  const r = await obtion(["push"]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect((await byTitle("Notizen"))!.body).toBe("Zeile 1\r\nZeile 2 😁 bearbeitet\r\n");
  expect((await byTitle("Neu"))!.body).toBe("Neue Notiz\r\nmit CRLF\r\n");
  const tools = (await byTitle("Tools"))!;
  expect(tools.body).toBe("# Tools\nStart: python run.py\n");
  expect(tools.parents).toEqual([rootId]);
  const items = (await tree(rootId)).items;
  const run = items.find((i) => i.file?.name === "run.py")!;
  expect(run.parents).toEqual([tools.id]);
  const data = items.find((i) => i.file?.name === "daten.bin")!;
  expect(data.file!.hash).toBe(sha(bin));
  const down = new Uint8Array(await (await fetch(`${base}/w/${ws}/api/files/${data.id}`, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer());
  expect(sha(down)).toBe(sha(bin));
  expect(items.find((i) => i.file?.name === "schema.xsd")!.file!.hash).toBe(sha(read("Mapping/schema.xsd")));
  expect(items.some((i) => i.title === ".DS_Store")).toBe(false);
  // the new note carries its id now; everything is in sync
  expect(read("Neu.md").toString()).toMatch(/^---\nobtion_id: /);
  const after = await obtion(["status"]);
  expect(after.out).toContain("No local changes.");
  expect(after.out).toContain("No changes in Obtion.");
});

test("conflict: edited here and in Obtion – push keeps the local file, writes Obtion's text next to it, exits non-zero", async () => {
  await tool("update", { ref: "Notizen", old_text: "Zeile 1", new_text: "Zeile EINS (App)" });
  writeFileSync(join(dir, "Notizen.md"), read("Notizen.md").toString() + "lokal\n");
  const mine = read("Notizen.md").toString();

  const pulled = await obtion(["pull"]);
  expect(pulled.code).toBe(1);
  expect(pulled.out).toContain("conflict  Notizen.md");
  expect(read("Notizen.md").toString()).toBe(mine);

  const r = await obtion(["push"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("conflict  Notizen.md");
  expect(read("Notizen.md").toString()).toBe(mine);
  expect(bodyOf("Notizen.obtion-conflict.md")).toBe("Zeile EINS (App)\r\nZeile 2 😁 bearbeitet\r\n");
  expect((await byTitle("Notizen"))!.body).toBe("Zeile EINS (App)\r\nZeile 2 😁 bearbeitet\r\n");
  // not merged yet: still refused
  expect((await obtion(["push"])).out).toContain("not resolved");
  // merged and the copy deleted: it goes up
  writeFileSync(join(dir, "Notizen.md"), read("Notizen.md").toString().replace("Zeile 1", "Zeile EINS (App)"));
  rmSync(join(dir, "Notizen.obtion-conflict.md"));
  const done = await obtion(["push"]);
  expect(done.code).toBe(0);
  expect((await byTitle("Notizen"))!.body).toBe("Zeile EINS (App)\r\nZeile 2 😁 bearbeitet\r\nlokal\n");
});

test("pull brings changes from Obtion, renames and moves follow, local edits are never overwritten", async () => {
  await tool("update", { ref: "Ablauf", old_text: "Text", new_text: "Text aus der App" });
  await tool("update", { ref: "Mapping", title: "Mapping BIS" });
  await tool("create", { items: [{ title: "Neu aus der App", parents: [rootId], body: "hallo" }] });
  writeFileSync(join(dir, "Neu.md"), read("Neu.md").toString() + "lokal\r\n");
  const st = await obtion(["status"]);
  expect(st.out).toContain("moved     Mapping/Ablauf.md → Mapping BIS/Ablauf.md");
  expect(st.out).toContain("new       Neu aus der App.md");

  const r = await obtion(["pull"]);
  expect(r.code).toBe(0);
  expect(existsSync(join(dir, "Mapping"))).toBe(false);
  expect(bodyOf("Mapping BIS/Ablauf.md")).toBe("---\ntitle: eigener Kopf\n---\nText aus der App");
  expect(read("Mapping BIS/schema.xsd").toString()).toContain('version="2"');
  expect(bodyOf("Neu aus der App.md")).toBe("hallo");
  expect(bodyOf("Neu.md")).toBe("Neue Notiz\r\nmit CRLF\r\nlokal\r\n");
  expect(r.out).toContain("kept      Neu.md");
  expect((await obtion(["push"])).code).toBe(0);
  expect((await byTitle("Neu"))!.body).toBe("Neue Notiz\r\nmit CRLF\r\nlokal\r\n");
});

test("a file replaced in Obtion and here: conflict copy with Obtion's original", async () => {
  const xsd = (await tree(rootId)).items.find((i) => i.file?.name === "schema.xsd")!;
  await fetch(`${base}/w/${ws}/api/files/${xsd.id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: "<app/>" });
  writeFileSync(join(dir, "Mapping BIS", "schema.xsd"), "<lokal/>");
  const r = await obtion(["push"]);
  expect(r.code).toBe(1);
  expect(read("Mapping BIS/schema.obtion-conflict.xsd").toString()).toBe("<app/>");
  expect(read("Mapping BIS/schema.xsd").toString()).toBe("<lokal/>");
  rmSync(join(dir, "Mapping BIS", "schema.obtion-conflict.xsd"));
  expect((await obtion(["push"])).code).toBe(0);
  expect((await tree(rootId)).items.find((i) => i.id === xsd.id)!.file!.hash).toBe(sha("<lokal/>"));
});

test("deletions are sent only with --delete, and then go to the trash", async () => {
  rmSync(join(dir, "Doppelt (2).md"));
  const plain = await obtion(["push"]);
  expect(plain.code).toBe(0);
  expect(plain.out).toContain("deleted   Doppelt (2).md  (not sent");
  expect((await tree(rootId)).items.filter((i) => i.title === "Doppelt")).toHaveLength(2);
  const r = await obtion(["push", "--delete"]);
  expect(r.code).toBe(0);
  expect((await tree(rootId)).items.filter((i) => i.title === "Doppelt").map((i) => i.body)).toEqual(["eins"]);
  expect((await tool("search", { query: "zwei" })).includes("Doppelt")).toBe(false);
  expect((await obtion(["status"])).out).toContain("No local changes.");
});

test("environment variables override the stored login; another workspace's folder is refused", async () => {
  const r = await obtion(["status"], { env: { OBTION_WORKSPACE: "anderer" } });
  expect(r.code).toBe(2);
  expect(r.err).toContain("belongs to workspace");
});
