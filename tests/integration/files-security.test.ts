// Who may read and write file contents, and how much a request may carry: every way in needs a
// token in the header, never a session or MCP token in the URL, and no link opens a content
// without one. Starts a real server.
import { test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { tempDir, removeTempDirs } from "../support/helpers";
import { bootServer, del, get, mcpTool, post } from "../support/server";
import { sha256 } from "@obtion/server/blobs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

setDefaultTimeout(60_000);

let base = "";
let data = "";
let proc: ReturnType<typeof Bun.spawn>;
let owner: { token: string; user: { id: string } };
let ws = "";
let agent = "";
/** Another account with its own workspace and MCP token. */
let stranger: { token: string; user: { id: string } };
let strangerWs = "";
let strangerAgent = "";

async function signUp(email: string) {
  const res = await post(base, "/api/account/signup", { name: email.split("@")[0], email, password: "secret12345" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

beforeAll(async () => {
  data = tempDir("obtion-filesec-");
  ({ url: base, proc } = await bootServer({ OBTION_DATA: data, OBTION_WEB_APP: "off", OBTION_SIGNUP: "open" }));
  owner = await signUp("owner@example.org");
  ws = (await post(base, "/api/workspaces", { name: "Project" }, owner.token).then((r) => r.json())).id;
  agent = (await post(base, `/api/workspaces/${ws}/mcp-token`, {}, owner.token).then((r) => r.json())).token;
  stranger = await signUp("stranger@example.org");
  strangerWs = (await post(base, "/api/workspaces", { name: "Stranger" }, stranger.token).then((r) => r.json())).id;
  strangerAgent = (await post(base, `/api/workspaces/${strangerWs}/mcp-token`, {}, stranger.token).then((r) => r.json())).token;
});
afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  removeTempDirs();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
/** A body sent in chunks, without Content-Length. */
const chunked = (bytes: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let left = bytes; left > 0; left -= 64 * 1024) c.enqueue(new Uint8Array(Math.min(left, 64 * 1024)).fill(0x7b));
      c.close();
    },
  });

test("routes without a file take small bodies only: 413 by Content-Length and when chunked", async () => {
  const big = JSON.stringify({ email: "x@example.org", password: "secret12345", name: "x".repeat(2 * 1024 * 1024) });
  const byLength = await fetch(`${base}/api/account/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
  expect(byLength.status).toBe(413);
  const streamed = await fetch(`${base}/api/account/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: chunked(2 * 1024 * 1024) });
  expect(streamed.status).toBe(413);
  // a small chunked body still arrives
  const small = await fetch(`${base}/api/account/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: new Blob([JSON.stringify({ email: "small@example.org", password: "secret12345", name: "Small" })]).stream() });
  expect(small.status).toBe(200);
  // a workspace route as well, with a valid token
  const undo = await fetch(`${base}/w/${ws}/api/undo`, { method: "POST", headers: { "content-type": "application/json", ...bearer(owner.token) }, body: chunked(2 * 1024 * 1024) });
  expect(undo.status).toBe(413);
  // the file routes take more than that
  const file = await fetch(`${base}/w/${ws}/api/files?name=big.bin`, { method: "POST", headers: bearer(agent), body: chunked(3 * 1024 * 1024) });
  expect(file.status).toBe(201);
});

test("the app's upload by hash streams and checks the hash: a wrong one is 400 and leaves nothing", async () => {
  const content = "Content by hash";
  const hash = sha256(content);
  const wrong = sha256("something else");
  const bad = await fetch(`${base}/w/${ws}/api/blobs/${wrong}`, { method: "PUT", headers: bearer(owner.token), body: content });
  expect(bad.status).toBe(400);
  for (const h of [wrong, hash]) expect((await get(base, `/w/${ws}/api/blobs/${h}`, owner.token)).status).toBe(404);
  const ok = await fetch(`${base}/w/${ws}/api/blobs/${hash}`, { method: "PUT", headers: bearer(owner.token), body: new Blob([content]).stream() });
  expect(ok.status).toBe(200);
  expect(await (await get(base, `/w/${ws}/api/blobs/${hash}`, owner.token)).text()).toBe(content);
});

const files = (w = ws) => `${base}/w/${w}/api/files`;
const blobs = (hash: string, w = ws) => `${base}/w/${w}/api/blobs/${hash}`;
async function uploaded(name: string, content: string, token = agent) {
  const res = await fetch(`${files()}?name=${encodeURIComponent(name)}`, { method: "POST", headers: bearer(token), body: content });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; hash: string; url: string };
}
/** Every way to read or write the content of `f`, with `headers` and the query `q`. */
function attempts(f: { id: string; hash: string }, headers: Record<string, string>, q = "") {
  return {
    "GET file": () => fetch(`${files()}/${f.id}${q}`, { headers }),
    "HEAD file": () => fetch(`${files()}/${f.id}${q}`, { method: "HEAD", headers }),
    "POST file": () => fetch(`${files()}?name=new.txt${q ? "&" + q.slice(1) : ""}`, { method: "POST", headers, body: "new" }),
    "PUT file": () => fetch(`${files()}/${f.id}${q}`, { method: "PUT", headers, body: "replaced" }),
    "GET blob": () => fetch(`${blobs(f.hash)}${q}`, { headers }),
    "PUT blob": () => fetch(`${blobs(sha256("written"))}${q}`, { method: "PUT", headers, body: "written" }),
    "GET text": () => fetch(`${base}/w/${ws}/api/texts/${f.hash}${q}`, { headers }),
    "GET link": () => fetch(`${base}/w/${ws}/api/links/${f.hash}${q}`, { headers }),
  };
}
/** 401 or 403, and nothing of the content in the answer. */
async function refused(f: { id: string; hash: string }, content: string, headers: Record<string, string>, q = "", only?: string[]) {
  for (const [what, go] of Object.entries(attempts(f, headers, q))) {
    if (only && !only.includes(what)) continue;
    const res = await go();
    const body = await res.text();
    if (![401, 403].includes(res.status)) throw new Error(`${what} ${q}: ${res.status} ${body}`);
    expect(body).not.toContain(content);
    expect(res.headers.get("x-obtion-hash")).toBeNull();
  }
}

test("without a token, with a wrong one, with the token in the query: 401, no data", async () => {
  const secret = "Secret content 1";
  const f = await uploaded("secret.txt", secret);
  await refused(f, secret, {});
  await refused(f, secret, bearer("obt_wrong"));
  await refused(f, secret, bearer(owner.token.slice(0, -2) + "xx"));
  await refused(f, secret, { authorization: owner.token }); // without "Bearer"
  // tokens never count in the URL, neither the session nor the MCP token, under any name
  for (const name of ["t", "token", "access_token", "s", "auth"])
    for (const token of [owner.token, agent]) await refused(f, secret, {}, `?${name}=${encodeURIComponent(token)}`);
});

test("the MCP token of another workspace, or a session of a non-member: 401/403, no data", async () => {
  const secret = "Secret content 2";
  const f = await uploaded("secret2.txt", secret);
  await refused(f, secret, bearer(strangerAgent));
  await refused(f, secret, bearer(stranger.token));
  // the MCP token opens the file API and /mcp only, not the app's routes
  await refused(f, secret, bearer(agent), "", ["GET blob", "PUT blob", "GET text", "GET link"]);
  expect((await get(base, `/w/${ws}/api/activity`, agent)).status).toBe(401);
  // nor a workspace's MCP endpoint for another workspace
  expect((await fetch(`${base}/w/${ws}/mcp`, { method: "POST", headers: { ...bearer(strangerAgent), "content-type": "application/json" }, body: "{}" })).status).toBe(401);
});

test("a former member: session and MCP token refused at once", async () => {
  const { code } = await post(base, `/api/workspaces/${ws}/invites`, {}, owner.token).then((r) => r.json());
  const member = await signUp("member@example.org");
  expect((await post(base, `/api/invites/${code}`, {}, member.token)).status).toBe(200);
  const memberAgent = (await post(base, `/api/workspaces/${ws}/mcp-token`, {}, member.token).then((r) => r.json())).token;
  const secret = "Secret content 3";
  const f = await uploaded("secret3.txt", secret, memberAgent);
  expect(await (await get(base, `/w/${ws}/api/blobs/${f.hash}`, member.token)).text()).toBe(secret);

  expect((await del(base, `/api/workspaces/${ws}/members/${member.user.id}`, owner.token)).status).toBe(200);
  await refused(f, secret, bearer(member.token));
  await refused(f, secret, bearer(memberAgent));
  expect((await fetch(`${base}/w/${ws}/mcp`, { method: "POST", headers: { ...bearer(memberAgent), "content-type": "application/json" }, body: "{}" })).status).toBe(401);
});

test("a new MCP token ends the one before; a revoked one is refused at once", async () => {
  const first = (await post(base, `/api/workspaces/${strangerWs}/mcp-token`, {}, stranger.token).then((r) => r.json())).token;
  const second = (await post(base, `/api/workspaces/${strangerWs}/mcp-token`, {}, stranger.token).then((r) => r.json())).token;
  const list = (token: string) => fetch(`${files(strangerWs)}?name=x.txt`, { method: "POST", headers: bearer(token), body: "x" });
  expect((await list(first)).status).toBe(401);
  expect((await list(strangerAgent)).status).toBe(401);
  expect((await list(second)).status).toBe(201);
  expect((await del(base, `/api/workspaces/${strangerWs}/mcp-token`, stranger.token)).status).toBe(200);
  expect((await list(second)).status).toBe(401);
  expect((await fetch(`${base}/w/${strangerWs}/mcp`, { method: "POST", headers: { ...bearer(second), "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  // only one's own token: someone else's revoke route needs membership
  expect((await del(base, `/api/workspaces/${strangerWs}/mcp-token`, owner.token)).status).toBe(403);
  strangerAgent = (await post(base, `/api/workspaces/${strangerWs}/mcp-token`, {}, stranger.token).then((r) => r.json())).token;
});

test("no link opens a content without a token: no signed links, no token in the URL", async () => {
  const secret = "Secret content 4";
  const f = await uploaded("secret4.txt", secret);
  // the app reads with the session in the header and shows the content from a blob: URL
  const ok = await get(base, `/w/${ws}/api/blobs/${f.hash}`, owner.token);
  expect(await ok.text()).toBe(secret);
  expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
  // nothing hands out a link, and nothing in a URL stands in for the token
  expect((await get(base, `/w/${ws}/api/links/${f.hash}`, owner.token)).status).toBe(404);
  for (const q of ["?s=1.x.y", `?s=${Math.floor(Date.now() / 1000) + 300}.${Buffer.from(owner.user.id).toString("base64url")}.abc`, "?download=1&name=a.txt"]) {
    for (const url of [`${blobs(f.hash)}${q}`, `${files()}/${f.id}${q}`, `${base}/w/${ws}/api/texts/${f.hash}${q}`]) {
      const res = await fetch(url);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(secret);
    }
  }
});

test("contents by hash: no reading across workspaces, no foreign content under a hash", async () => {
  const secret = "Secret content 5";
  const f = await uploaded("secret5.txt", secret);
  // the hash is known (X-Obtion-Hash, ETag, get): still nothing from another workspace
  for (const token of [stranger.token, strangerAgent]) {
    for (const path of [blobs(f.hash, strangerWs), `${blobs(f.hash, strangerWs)}?check=1`]) {
      const res = await fetch(path, { headers: { ...bearer(token), "x-obtion-probe": "1" } });
      expect(res.status === 401 || res.headers.get("x-obtion-missing") === "1").toBe(true);
      expect(await res.text()).not.toContain(secret);
    }
  }
  // writing another content under that hash fails, here and there
  for (const [w, token] of [[ws, owner.token], [strangerWs, stranger.token]] as const) {
    const res = await fetch(blobs(f.hash, w), { method: "PUT", headers: bearer(token), body: "slipped in" });
    expect(res.status).toBe(400);
  }
  expect(await (await get(base, `/w/${ws}/api/blobs/${f.hash}`, owner.token)).text()).toBe(secret);
  expect((await get(base, `/w/${strangerWs}/api/blobs/${f.hash}`, stranger.token)).status).toBe(404);
});

test("CSRF and CORS: no way in without the header, no CORS answer for foreign sites", async () => {
  const f = await uploaded("csrf.txt", "csrf");
  const evil = { origin: "https://evil.example", "sec-fetch-site": "cross-site", cookie: `better-auth.session_token=${owner.token}` };
  for (const [method, url] of [["POST", `${files()}?name=x.txt`], ["PUT", `${files()}/${f.id}`], ["PUT", blobs(sha256("x"))]] as const)
    expect((await fetch(url, { method, headers: evil, body: "x" })).status).toBe(403);
  // even from this site, a cookie alone is no token
  expect((await fetch(`${files()}/${f.id}`, { headers: { cookie: `better-auth.session_token=${owner.token}` } })).status).toBe(401);
  const pre = await fetch(`${files()}/${f.id}`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "PUT", "access-control-request-headers": "authorization" } });
  expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
  const read = await fetch(`${files()}/${f.id}`, { headers: { ...bearer(agent), origin: "https://evil.example" } });
  expect(read.headers.get("access-control-allow-origin")).toBeNull();
  expect(read.headers.get("access-control-allow-credentials")).toBeNull();
});

test("HTML and SVG never run in the app's origin, on any route", async () => {
  const html = "<html><script>alert(1)</script></html>";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  for (const [name, content] of [["x.html", html], ["x.svg", svg], ["x.htm", html], ["x.xhtml", html]] as const) {
    const f = await uploaded(name, content);
    for (const res of [await get(base, `/w/${ws}/api/files/${f.id}`, agent), await get(base, `/w/${ws}/api/blobs/${f.hash}`, owner.token)]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      // an SVG shows as an image (sandboxed, its script never runs); the rest downloads
      if (name.endsWith(".svg")) expect(res.headers.get("content-type")).toMatch(/^(image\/svg\+xml|application\/octet-stream)$/);
      else {
        expect(res.headers.get("content-type")).toBe("application/octet-stream");
        expect(res.headers.get("content-disposition")).toStartWith("attachment;");
      }
    }
  }
});

test("answers, instructions, docs and the vault carry no token and no link that opens a content", async () => {
  const f = await uploaded("Report.txt", "Report");
  const tokens = [agent, owner.token];
  const said = [
    JSON.stringify(f),
    await mcpTool(base, agent, "get", { ref: f.id }, `/w/${ws}/mcp`),
    JSON.stringify(await fetch(`${base}/w/${ws}/mcp`, { method: "POST", headers: { ...bearer(agent), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) }).then((r) => r.json())),
    JSON.stringify(await fetch(`${base}/w/${ws}/mcp`, { method: "POST", headers: { ...bearer(agent), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }).then((r) => r.json())),
    readFileSync(join(import.meta.dir, "../../docs/files-api.md"), "utf8"),
  ];
  for (const text of said) {
    for (const t of tokens) expect(text).not.toContain(t);
    expect(text).not.toMatch(/[?&](t|s|token)=/);
  }
  // the vault (Markdown mirror) names files by path, never by a URL
  const vault = join(data, "workspaces", ws, "vault");
  for (let i = 0; i < 100 && !readdirSync(vault, { recursive: true }).some((p) => String(p).endsWith("Report.txt")); i++) await Bun.sleep(50);
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const md = walk(vault).filter((p) => p.endsWith(".md"));
  expect(md.length).toBeGreaterThan(0);
  for (const p of md) {
    const text = readFileSync(p, "utf8");
    for (const t of tokens) expect(text).not.toContain(t);
    expect(text).not.toMatch(/api\/(blobs|files|texts|links)|[?&](t|s)=|https?:\/\/127/);
  }
});

test("attach with a url fetches public addresses only", async () => {
  const tool = (args: unknown) => mcpTool(base, agent, "attach", { name: "x.txt", parent: undefined, ...(args as object) }, `/w/${ws}/mcp`);
  for (const url of [`${base}/api/info`, "http://localhost:1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.1.1/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/", "file:///etc/passwd"]) {
    const out = await tool({ url });
    expect(out).toMatch(/not a public address|Only http\(s\)|Can't resolve/);
  }
});
