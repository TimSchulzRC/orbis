// Files for agents and scripts: the HTTP file API with the MCP token (and the app session), every
// file type, safe serving, the text the server reads from files, files through MCP (get, attach,
// undo). Starts a real server.
import { test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { tempDir, removeTempDirs } from "../support/helpers";
import { bootServer, get, mcpTool, post } from "../support/server";
import { docx, pdfWithEmbedded, pptx, xlsx, zip } from "../support/fixtures";
import { sha256 } from "@obtion/server/blobs";
import { Store } from "@obtion/server/store";
import { Workspace } from "@obtion/server/workspace";
import { initItem, setFileMeta } from "@obtion/core/model";
import { runSetup } from "@obtion/core/setup";
import { storeWriter } from "@obtion/server/setup";
import { searchIds } from "@obtion/core/search";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

setDefaultTimeout(60_000);

let base = "";
let proc: ReturnType<typeof Bun.spawn>;
let owner: { token: string; user: { id: string } };
let ws = "";
let agent = ""; // the owner's MCP token for ws
let other: { token: string };
let otherAgent = ""; // an MCP token of another account, for its own workspace

async function signUp(email: string) {
  const res = await post(base, "/api/account/signup", { name: email.split("@")[0], email, password: "secret12345" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

beforeAll(async () => {
  ({ url: base, proc } = await bootServer({ OBTION_DATA: tempDir("obtion-files-"), OBTION_WEB_APP: "off", OBTION_SIGNUP: "open" }));
  owner = await signUp("owner@example.org");
  ws = (await post(base, "/api/workspaces", { name: "Project" }, owner.token).then((r) => r.json())).id;
  agent = (await post(base, `/api/workspaces/${ws}/mcp-token`, {}, owner.token).then((r) => r.json())).token;
  other = await signUp("other@example.org");
  const ow = (await post(base, "/api/workspaces", { name: "Stranger" }, other.token).then((r) => r.json())).id;
  otherAgent = (await post(base, `/api/workspaces/${ow}/mcp-token`, {}, other.token).then((r) => r.json())).token;
});
afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  removeTempDirs();
});

const files = () => `${base}/w/${ws}/api/files`;
/** `token` "": none. */
const upload = (name: string, body: Uint8Array | string, token = agent, query = "") =>
  fetch(`${files()}?name=${encodeURIComponent(name)}${query}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: body as BodyInit });
const tool = (name: string, args: unknown) => mcpTool(base, agent, name, args, `/w/${ws}/mcp`);

/** The file's facts as `get` shows them, once the server has read its text. */
async function readText(id: string): Promise<{ file: Record<string, unknown>; text?: string; text_note?: string }> {
  for (let i = 0; i < 100; i++) {
    const out = JSON.parse(await tool("get", { ref: id }));
    if (!out.text_note?.includes("still reading")) return out;
    await Bun.sleep(100);
  }
  throw new Error("text never read");
}

test("upload with the MCP token, download the original with its name; no token or a foreign one: 401", async () => {
  const xsd = '<?xml version="1.0"?>\n<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="Example"/></xs:schema>\n';
  const res = await upload("Schema Example.xsd", xsd);
  expect(res.status).toBe(201);
  const made = await res.json();
  expect(made).toMatchObject({ name: "Schema Example.xsd", hash: sha256(xsd), size: xsd.length, url: `${files()}/${made.id}`, step: expect.stringMatching(/^s\w+/) });

  const down = await fetch(made.url, { headers: { authorization: `Bearer ${agent}` } });
  expect(down.status).toBe(200);
  expect(await down.text()).toBe(xsd);
  expect(down.headers.get("content-disposition")).toBe(`attachment; filename="Schema Example.xsd"; filename*=UTF-8''Schema%20Example.xsd`);
  expect(down.headers.get("content-type")).toBe("application/octet-stream");
  expect(down.headers.get("x-content-type-options")).toBe("nosniff");
  // the app session works as well
  expect((await fetch(made.url, { headers: { authorization: `Bearer ${owner.token}` } })).status).toBe(200);

  expect((await upload("x.txt", "x", "")).status).toBe(401);
  expect((await fetch(made.url)).status).toBe(401);
  expect((await upload("x.txt", "x", otherAgent)).status).toBe(401); // MCP token of another workspace
  expect((await fetch(made.url, { headers: { authorization: `Bearer ${otherAgent}` } })).status).toBe(401);
  expect((await fetch(made.url, { headers: { authorization: `Bearer ${other.token}` } })).status).toBe(403); // a session, not a member
  expect((await fetch(`${made.url}?t=${agent}`)).status).toBe(401); // never as a query parameter
  // the MCP token opens the file API only
  expect((await get(base, `/w/${ws}/api/activity`, agent)).status).toBe(401);
  expect((await get(base, `/w/${ws}/api/blobs/${made.hash}`, agent)).status).toBe(401);
  expect((await get(base, `/w/${ws}/api/blobs/${made.hash}?t=${agent}`)).status).toBe(401);
});

test("a parent by id or title; bad requests change nothing", async () => {
  await tool("create", { items: [{ title: "Documents" }] });
  const res = await upload("plan.txt", "Plan", agent, "&parent=Documents");
  expect(res.status).toBe(201);
  const out = JSON.parse(await tool("get", { ref: (await res.json()).id }));
  expect(out.part_of).toEqual(["Documents"]);
  expect((await upload("", "x")).status).toBe(400);
  expect((await upload("x.txt", "x", agent, "&parent=Does%20not%20exist")).status).toBe(400);
  expect((await fetch(`${files()}/nope`, { method: "PUT", headers: { authorization: `Bearer ${agent}` }, body: "x" })).status).toBe(404);
  expect((await fetch(`${files()}/a/b`, { headers: { authorization: `Bearer ${agent}` } })).status).toBe(404);
  // a name with folders keeps only the name
  expect((await (await upload("../../etc/passwd.txt", "p")).json()).name).toBe("passwd.txt");
});

test("every file type is accepted; only safe types show in the browser, the rest downloads", async () => {
  const names = ["page.html", "image.svg", "script.js", "run.ps1", "lib.jar", "data.seexsd", "x.idoc", "Mail.msg", "app.exe", "none"];
  const made: Record<string, { id: string; hash: string }> = {};
  for (const n of names) {
    const res = await upload(n, n === "image.svg" ? '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' : `<p>Text of ${n}</p><script>alert("${n}")</script>`);
    expect(res.status).toBe(201);
    made[n] = await res.json();
  }
  // the app's upload (content by hash) takes them too
  const html = "<html><script>alert(2)</script></html>";
  const put = await fetch(`${base}/w/${ws}/api/blobs/${sha256(html)}?name=new.html`, { method: "PUT", headers: { authorization: `Bearer ${owner.token}` }, body: html });
  expect(put.status).toBe(200);

  const viaApp = async (n: string) => fetch(`${base}/w/${ws}/api/blobs/${made[n]!.hash}`, { headers: { authorization: `Bearer ${owner.token}` } });
  for (const n of names.filter((x) => x !== "image.svg")) {
    const r = await viaApp(n);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toStartWith("attachment;");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("sandbox");
  }
  // an SVG shows as an image, sandboxed: its script never runs
  const svg = await viaApp("image.svg");
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expect(svg.headers.get("content-security-policy")).toBe("sandbox");
  expect(svg.headers.get("content-disposition")).toBeNull();
  // through the file API always a download
  const svgDown = await fetch(`${files()}/${made["image.svg"]!.id}`, { headers: { authorization: `Bearer ${agent}` } });
  expect(svgDown.headers.get("content-disposition")).toStartWith("attachment;");
  expect(svgDown.headers.get("content-security-policy")).toBe("sandbox");
  // HTML is read as text, without its script
  expect((await readText(made["page.html"]!.id)).text).toBe("Text of page.html");
});

test("replace the content: same item, old version kept, in the activity, undoable", async () => {
  const first = await (await upload("mapping.xslt", "<xsl:stylesheet>old</xsl:stylesheet>")).json();
  const res = await fetch(`${files()}/${first.id}`, { method: "PUT", headers: { authorization: `Bearer ${agent}` }, body: "<xsl:stylesheet>new</xsl:stylesheet>" });
  expect(res.status).toBe(200);
  const r = await res.json();
  expect(r).toMatchObject({ id: first.id, name: "mapping.xslt", replaced: true, previous: first.hash, hash: sha256("<xsl:stylesheet>new</xsl:stylesheet>") });
  expect(await (await fetch(`${files()}/${first.id}`, { headers: { authorization: `Bearer ${agent}` } })).text()).toBe("<xsl:stylesheet>new</xsl:stylesheet>");
  const got = await readText(first.id);
  expect(got.text).toBe("<xsl:stylesheet>new</xsl:stylesheet>");
  expect(got.file.versions_before).toBe(1);
  // the same content again: nothing to do
  const same = await fetch(`${files()}/${first.id}`, { method: "PUT", headers: { authorization: `Bearer ${agent}` }, body: "<xsl:stylesheet>new</xsl:stylesheet>" });
  expect(await same.json()).toMatchObject({ replaced: false });

  const events = (await get(base, `/w/${ws}/api/activity?doc=${first.id}`, owner.token).then((x) => x.json())) as { origin: string; step?: string }[];
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events.every((e) => e.origin.startsWith(`agent:`) && e.origin.includes(`u=${owner.user.id}`))).toBe(true);
  // undo the replacement with the step from the answer
  const undone = await tool("undo", { step: r.step });
  expect(undone).toStartWith("Undone step");
  expect(JSON.parse(await tool("get", { ref: first.id })).file.hash).toBe(first.hash);
});

test("get on a file: facts, download URL and curl commands with a placeholder, never the token", async () => {
  const made = await (await upload("Report's.txt", "Content")).json();
  const out = await readText(made.id);
  expect(out.file).toMatchObject({ name: "Report's.txt", size: 7, hash: sha256("Content"), mime: "text/plain", download: `${files()}/${made.id}` });
  expect(out.file.download_curl).toBe(`curl -fsS -H "Authorization: Bearer $OBTION_TOKEN" -o 'Report'\\''s.txt' '${files()}/${made.id}'`);
  expect(out.file.replace_curl).toContain("--data-binary @'Report'\\''s.txt'");
  expect(out.text).toBe("Content");
  const raw = await tool("get", { ref: made.id });
  expect(raw).not.toContain(agent);
  // the instructions and attach explain the upload, without the token
  const init = await fetch(`${base}/w/${ws}/mcp`, { method: "POST", headers: { authorization: `Bearer ${agent}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) }).then((r) => r.json());
  expect(init.result.instructions).toContain(`--data-binary @report.pdf "${files()}?name=report.pdf`);
  // an upload without parent lands in the inbox, where the agent can only suggest
  expect(init.result.instructions).toContain("Always give parent (an id or exact title): without it the file lands in the inbox");
  expect(JSON.stringify(init)).not.toContain(agent);
});

test("text from Office files, ZIPs and a Factur-X PDF lands in get and search", async () => {
  const xml = '<?xml version="1.0"?><rsm:CrossIndustryInvoice><ram:ID>RE-TEST-777</ram:ID></rsm:CrossIndustryInvoice>';
  const cases: [string, Uint8Array, string][] = [
    ["Concept.docx", docx(["Supplier approval process"], [["Field", "Value"]]), "Supplier approval process\nField\tValue"],
    ["List.xlsx", xlsx({ Partner: [["Name", "Number"], ["Examplepartner", 4711]] }), "Sheet: Partner\nName\tNumber\nExamplepartner\t4711"],
    ["Talk.pptx", pptx([["Rollout schedule"]]), "Slide 1\nRollout schedule"],
    ["package.zip", zip({ "a/rule.txt": "r" }), "ZIP archive, 1 file(s):\na/rule.txt\t1"],
  ];
  for (const [name, data, want] of cases) {
    const made = await (await upload(name, data)).json();
    expect((await readText(made.id)).text).toBe(want);
  }
  const pdf = await (await upload("invoice.pdf", pdfWithEmbedded("Invoice", "factur-x.xml", xml))).json();
  const got = await readText(pdf.id);
  expect(got.file.pages).toBe(1);
  expect(got.text).toContain("factur-x.xml");
  expect(got.text).toContain("RE-TEST-777");
  expect(await tool("search", { query: "Examplepartner" })).toContain("List.xlsx");
  expect(await tool("search", { query: "RE-TEST-777" })).toContain("invoice.pdf");
});

test("attach: any type, one step with undo; base64 limits point to the HTTP upload", async () => {
  const out = await tool("attach", { name: "rule.properties", base64: Buffer.from("key=value\n").toString("base64"), description: "Config" });
  expect(out).toMatch(/^Attached:\n- rule\.properties \[/);
  expect(out).toMatch(/\(step s\w+ – undo it with the undo tool\)/);
  const id = /\[([\w-]+)\]/.exec(out)![1]!;
  expect((await readText(id)).text).toBe("key=value");
  // replace through attach
  const rep = await tool("attach", { name: "rule.properties", replace: id, base64: Buffer.from("key=new\n").toString("base64") });
  expect(rep).toStartWith("Replaced the content:");
  expect((await readText(id)).text).toBe("key=new");
  await tool("undo", {});
  expect((await readText(id)).text).toBe("key=value");
  const undo = await tool("undo", {});
  expect(undo).toContain("To the trash (created in that step)");
  expect(await tool("get", { ref: id })).toStartWith("Nothing matches"); // in the trash
  expect(await tool("restore", { ref: id })).toStartWith('Restored "rule.properties"');
  // no content: the answer names the HTTP upload
  expect(await tool("attach", { name: "x.txt" })).toContain("HTTP upload");
  const list = await fetch(`${base}/w/${ws}/mcp`, { method: "POST", headers: { authorization: `Bearer ${agent}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }).then((r) => r.json());
  const attach = list.result.tools.find((t: { name: string }) => t.name === "attach");
  expect(attach.description).toContain(`--data-binary @file.xsd "${files()}?name=file.xsd`);
  expect(attach.description).toContain("Always give parent");
});

test("a file whose text was not read yet (e.g. the server stopped) is read when the workspace opens", async () => {
  const dir = tempDir("obtion-backfill-");
  const s = new Store(dir);
  runSetup(storeWriter(s, "system:setup"), "de");
  const content = "old note with content";
  mkdirSync(join(dir, "blobs"), { recursive: true });
  await Bun.write(join(dir, "blobs", sha256(content)), content);
  s.change("old-1", "test", (doc) => {
    initItem(doc, { kind: "file", title: "old.md" });
    setFileMeta(doc, { hash: sha256(content), name: "old.md", mime: "text/markdown", filetype: "document", size: content.length });
  });
  s.flush();
  s.db.close();
  const w = new Workspace(dir);
  try {
    for (let i = 0; i < 100 && !w.store.records.get("old-1")!.file!.text; i++) await Bun.sleep(50);
    expect(w.store.records.get("old-1")!.file!.text).toBe(content);
    expect(w.store.records.get("old-1")!.file!.extracted).toBe(sha256(content).slice(0, 16));
    expect(w.blobs.needsWork(w.store.records.get("old-1")!)).toBe(false);
  } finally {
    w.shut();
  }
});

test("a long text stays on the server: the facts carry its start, get and search the whole", async () => {
  const words = Array.from({ length: 800 }, (_, i) => `word${i}`).join(" ");
  const content = `Start of the minutes\n${words}\nClosing word Targetmark`;
  const made = await (await upload("minutes.txt", content, agent, "&parent=Documents")).json();
  const out = await readText(made.id);
  expect(out.text).toContain("Closing word Targetmark");
  expect(await tool("search", { query: "Targetmark" })).toContain("minutes.txt");
  // the app reads the whole text with its session; the MCP token does not open it
  const whole = await get(base, `/w/${ws}/api/texts/${made.hash}`, owner.token);
  expect(whole.status).toBe(200);
  expect(await whole.text()).toBe(content);
  expect((await get(base, `/w/${ws}/api/texts/${made.hash}`, agent)).status).toBe(401);
  expect((await get(base, `/w/${ws}/api/texts/${made.hash}`, other.token)).status).toBe(403);
});

test("the facts of a file hold at most the start of its text; the whole text stays beside the content", async () => {
  const dir = tempDir("obtion-facts-text-");
  const s = new Store(dir);
  runSetup(storeWriter(s, "system:setup"), "de");
  const fresh = `New\n${"one more line\n".repeat(600)}Footer Traceword`;
  mkdirSync(join(dir, "blobs"), { recursive: true });
  await Bun.write(join(dir, "blobs", sha256(fresh)), fresh);
  s.change("new-1", "test", (doc) => {
    initItem(doc, { kind: "file", title: "new.txt" });
    setFileMeta(doc, { hash: sha256(fresh), name: "new.txt", mime: "text/plain", filetype: "document", size: fresh.length });
  });
  s.flush();
  s.db.close();
  const w = new Workspace(dir);
  try {
    for (let i = 0; i < 100 && !w.store.records.get("new-1")!.file!.text; i++) await Bun.sleep(50);
    for (const [id, text] of [["new-1", fresh]] as const) {
      const f = w.store.records.get(id)!.file!;
      expect(f.text!.length).toBeLessThanOrEqual(4002);
      expect(f.text).toEndWith("\n…");
      expect(w.blobs.text(f)).toBe(text);
    }
    expect(searchIds(w.store.searchIndex, "Traceword")).toEqual(["new-1"]);
  } finally {
    w.shut();
  }
});

test("collect removes contents and texts no file points to, keeps older versions; a dry run removes nothing", async () => {
  const dir = tempDir("obtion-collect-");
  const w = new Workspace(dir);
  try {
    const [now, before, orphan] = ["now", "before", "orphaned"].map((c) => `${c}\n${"line\n".repeat(900)}`);
    for (const c of [now!, before!, orphan!]) await Bun.write(join(dir, "blobs", sha256(c)), c);
    for (const c of [now!, before!, orphan!]) await Bun.write(w.blobs.textPath(sha256(c)), c);
    w.store.change("f-1", "test", (doc) => {
      initItem(doc, { kind: "file", title: "a.txt" });
      setFileMeta(doc, { hash: sha256(now!), name: "a.txt", mime: "text/plain", filetype: "document", size: now!.length, extracted: sha256(now!).slice(0, 16), history: [{ hash: sha256(before!), at: 1 }] });
    });
    w.store.flush();
    expect(w.blobs.collect(true)).toEqual([sha256(orphan!)]);
    expect(existsSync(join(dir, "blobs", sha256(orphan!)))).toBe(true);
    expect(existsSync(w.blobs.textPath(sha256(orphan!)))).toBe(true);
    expect(w.blobs.collect()).toEqual([sha256(orphan!)]);
    expect(readdirSync(join(dir, "blobs")).filter((n) => /^[0-9a-f]{64}$/.test(n)).sort()).toEqual([sha256(now!), sha256(before!)].sort());
    expect(existsSync(w.blobs.textPath(sha256(orphan!)))).toBe(false);
    for (const c of [now!, before!]) expect(existsSync(w.blobs.textPath(sha256(c)))).toBe(true);
  } finally {
    w.shut();
  }
});

test("a content over the limit is refused while it streams and leaves nothing behind", async () => {
  const dir = tempDir("obtion-limit-");
  const w = new Workspace(dir);
  try {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(1024).fill(i));
        c.close();
      },
    });
    expect(await w.blobs.putStream(body, 4096)).toBe("too large");
    expect(readdirSync(join(dir, "blobs"))).toEqual([]);
  } finally {
    w.shut();
  }
});
