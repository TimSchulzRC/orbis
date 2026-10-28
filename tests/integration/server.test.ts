// The server as a program: accounts and workspaces (who sees what), with and without the web app,
// the data from before accounts, and the sync per workspace. Starts real servers.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "node:net";
import * as Y from "yjs";
import { tempDir, removeTempDirs } from "../support/helpers";
import { FORMAT, PERSONAL, initItem } from "@obtion/core/model";
import { type ServerMsg, toB64 } from "@obtion/core/protocol";
import { allowedHosts } from "@obtion/server/trust";
import { Store } from "@obtion/server/store";
import { Accounts } from "@obtion/server/accounts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

const procs: ReturnType<typeof Bun.spawn>[] = [];
async function start(env: Record<string, string>): Promise<string> {
  const port = await freePort();
  const p = Bun.spawn(["bun", "apps/server/src/index.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env },
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(p);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + "/api/info").then((r) => r.ok, () => false)) return base;
    await Bun.sleep(50);
  }
  throw new Error("server did not start");
}

let plain = "";
let bare = "";
let legacy = "";
let legacyDir = "";
beforeAll(async () => {
  plain = await start({ OBTION_DATA: tempDir("obtion-server-") });
  bare = await start({ OBTION_DATA: tempDir("obtion-server-"), OBTION_WEB_APP: "off", OBTION_SIGNUP: "open" });
  // a data folder from before accounts, with one item
  legacyDir = tempDir("obtion-server-");
  const s = new Store(legacyDir);
  s.create({ title: "Von früher" }, "test", { id: "old-1" });
  s.flush();
  s.db.close();
  legacy = await start({ OBTION_DATA: legacyDir });
});
afterAll(async () => {
  for (const p of procs) (p.kill(), await p.exited);
  removeTempDirs();
});

const post = (base: string, path: string, body: unknown, token?: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
const get = (base: string, path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
async function signUp(base: string, email: string, invite?: string): Promise<{ token: string; user: { id: string } }> {
  const res = await post(base, "/api/account/signup", { name: email.split("@")[0], email, password: "geheim12345", invite });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
const account = (base: string, token: string) => get(base, "/api/account", token).then((r) => r.json());

test("host names: addresses and private names on any port, public names only when configured", () => {
  const ok = allowedHosts(["obtion.example.org", "notes.example.com:8443", ""]);
  for (const h of ["192.168.1.10:8480", "100.101.102.103:9000", "127.0.0.1:8480", "[fd7a:115c::1]:8480", "[::1]:8480", "nas:8480", "localhost:5180", "nas.local:8480", "nas.fritz.lan", "nas.tail1234.ts.net", "nas.tail1234.ts.net:8480", "obtion.example.org", "Obtion.Example.org:443", "notes.example.com:8443"])
    expect([h, ok(h)]).toEqual([h, true]);
  for (const h of ["evil.example.net", "evil.example.net:8480", "notes.example.com:8480", "ts.net.evil.example", "", null])
    expect([h, ok(h)]).toEqual([h, false]);
});

test("the first account is the admin with a personal workspace; then only with an invite (default)", async () => {
  expect(await get(plain, "/api/info").then((r) => r.json())).toMatchObject({ signup: "invite", firstAccount: true });
  const ada = await signUp(plain, "ada@example.org");
  const me = await account(plain, ada.token);
  expect(me).toMatchObject({ admin: true, user: { email: "ada@example.org" } });
  expect(me.workspaces).toEqual([{ id: expect.any(String), name: "Persönlich", role: "owner" }]);
  expect((await post(plain, "/api/account/signup", { email: "eve@example.org", password: "geheim12345" })).status).toBe(403);
  expect((await get(plain, "/api/account")).status).toBe(401);

  // an invite link: Bob joins Ada's workspace and gets none of his own
  const ws = me.workspaces[0].id as string;
  const { code } = await post(plain, `/api/workspaces/${ws}/invites`, {}, ada.token).then((r) => r.json());
  expect(await get(plain, `/api/invites/${code}`).then((r) => r.json())).toEqual({ workspace: "Persönlich", by: "ada", signup: true });
  const bob = await signUp(plain, "bob@example.org", code);
  expect((await account(plain, bob.token)).workspaces).toEqual([{ id: ws, name: "Persönlich", role: "member" }]);
  expect((await account(plain, bob.token)).admin).toBe(false);
  expect((await get(plain, `/api/workspaces/${ws}/members`, bob.token).then((r) => r.json())).map((m: any) => m.role)).toEqual(["owner", "member"]);
  // the last owner cannot leave; a member can
  expect((await fetch(`${plain}/api/workspaces/${ws}/members/${ada.user.id}`, { method: "DELETE", headers: { authorization: `Bearer ${ada.token}` } })).status).toBe(409);
});

test("a workspace is only open to its members – sync, files, activity, MCP", async () => {
  const carla = await signUp(bare, "carla@example.org"); // open signup on this server
  const dan = await signUp(bare, "dan@example.org");
  const [cw] = (await account(bare, carla.token)).workspaces;
  const [dw] = (await account(bare, dan.token)).workspaces;
  expect(cw.id).not.toBe(dw.id);
  expect((await get(bare, `/w/${cw.id}/api/activity`, carla.token)).status).toBe(200);
  expect((await get(bare, `/w/${cw.id}/api/activity`, dan.token)).status).toBe(403);
  expect((await get(bare, `/w/${cw.id}/api/activity`)).status).toBe(401);
  const hash = "0".repeat(64);
  expect((await get(bare, `/w/${cw.id}/api/blobs/${hash}`, dan.token)).status).toBe(403);
  expect((await get(bare, `/w/${cw.id}/api/blobs/${hash}?t=${dan.token}`)).status).toBe(403);
  expect((await get(bare, `/w/${cw.id}/api/blobs/${hash}?t=${carla.token}`)).status).toBe(404);
  await expect(connect(bare, cw.id, dan.token)).rejects.toThrow();
  // MCP: a member's token for one workspace opens that one only
  const { token, mcpUrl } = await post(bare, `/api/workspaces/${cw.id}/mcp-token`, {}, carla.token).then((r) => r.json());
  expect(mcpUrl).toEndWith(`/w/${cw.id}/mcp`);
  const call = (ws: string, t: string) => post(bare, `/w/${ws}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, t, { accept: "application/json, text/event-stream" });
  expect((await call(cw.id, token)).status).toBe(200);
  expect((await call(dw.id, token)).status).toBe(401);
  expect((await call(cw.id, carla.token)).status).toBe(401); // a session is no MCP token
});

test("the sign-in only from the server's own page; other sites get no CORS answer", async () => {
  const eve = await signUp(bare, "eve@example.org");
  const [w] = (await account(bare, eve.token)).workspaces;
  const res = await fetch(`${bare}/w/${w.id}/api/activity`, { headers: { origin: "https://app.example.org", authorization: `Bearer ${eve.token}` } });
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect((await post(bare, "/api/auth/sign-in/email", { email: "eve@example.org", password: "geheim12345" }, undefined, { origin: "https://evil.example.org" })).status).toBe(403);
  const own = await post(bare, "/api/auth/sign-in/email", { email: "eve@example.org", password: "geheim12345" }, undefined, { origin: bare });
  expect(own.status).toBe(200);
  expect(await account(bare, (await own.json()).token)).toMatchObject({ user: { email: "eve@example.org" } });
});

test("the data from before accounts become a workspace of the first account; the old MCP address still opens them", async () => {
  expect(existsSync(join(legacyDir, "obtion.db"))).toBe(false);
  const ada = await signUp(legacy, "ada@example.org");
  const [w] = (await account(legacy, ada.token)).workspaces;
  expect(w).toEqual({ id: expect.any(String), name: "Persönlich", role: "owner", legacy: true });
  expect(existsSync(join(legacyDir, "workspaces", w.id, "obtion.db"))).toBe(true);
  const c = await connect(legacy, w.id, ada.token);
  c.ws.send(JSON.stringify({ t: "hello", area: PERSONAL, since: 0, client: "a" }));
  const first = (await c.until((m) => m.t === "updates" && !!m.done)) as Extract<ServerMsg, { t: "updates" }>;
  expect(first.items.map((i) => i.d)).toContain("old-1");
  c.ws.close();
  const old = JSON.parse(readFileSync(join(legacyDir, "config.json"), "utf8")).token;
  expect((await post(legacy, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, old, { accept: "application/json, text/event-stream" })).status).toBe(200);
  expect((await post(legacy, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong", { accept: "application/json, text/event-stream" })).status).toBe(401);
});

test("every server brings the web app; OBTION_WEB_APP=off leaves sync, API and MCP", async () => {
  const app = await fetch(plain + "/");
  expect(app.status).not.toBe(404); // the app (or 503 while it is not built)
  const none = await fetch(bare + "/");
  expect(none.status).toBe(404);
  expect(await none.text()).toContain("OBTION_WEB_APP=off");
  expect((await fetch(bare + "/api/info")).status).toBe(200);
  expect((await fetch(bare + "/mcp", { method: "POST" })).status).toBe(401); // there, asks for its token
});

/** A sync connection to a workspace that collects what the server sends; the token goes as subprotocol, as in browsers. */
async function connect(base: string, workspace: string, token: string) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/w/${workspace}/sync`, ["obtion", `auth.${token}`]);
  const msgs: ServerMsg[] = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j), (ws.onclose = j)));
  const until = async (pred: (m: ServerMsg) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const m = msgs.find(pred);
      if (m) return m;
      await Bun.sleep(20);
    }
    throw new Error("no such message: " + JSON.stringify(msgs));
  };
  return { ws, msgs, until };
}

test("sync per workspace: members get each other's changes; an app from before areas means the personal area", async () => {
  const fay = await signUp(bare, "fay@example.org");
  const [w] = (await account(bare, fay.token)).workspaces;
  const { code } = await post(bare, `/api/workspaces/${w.id}/invites`, {}, fay.token).then((r) => r.json());
  const gus = await signUp(bare, "gus@example.org", code);
  const a = await connect(bare, w.id, fay.token);
  const b = await connect(bare, w.id, gus.token);
  a.ws.send(JSON.stringify({ t: "hello", area: PERSONAL, since: 0, client: "a", device: "a" }));
  b.ws.send(JSON.stringify({ t: "hello", since: 0, client: "b" })); // no area: from before
  expect(await a.until((m) => m.t === "welcome")).toMatchObject({ area: PERSONAL, format: FORMAT });
  expect(await b.until((m) => m.t === "welcome")).toMatchObject({ area: PERSONAL });
  await b.until((m) => m.t === "updates" && !!m.done);

  const d = new Y.Doc({ guid: "n1" });
  d.transact(() => initItem(d, { title: "Aus dem Test" }));
  a.ws.send(JSON.stringify({ t: "push", area: PERSONAL, items: [{ k: "k1", d: "n1", u: toB64(Y.encodeStateAsUpdate(d)) }] }));
  expect(await a.until((m) => m.t === "ack")).toMatchObject({ area: PERSONAL, keys: ["k1"] });
  const relayed = (await b.until((m) => m.t === "updates" && m.items.some((i) => i.d === "n1"))) as Extract<ServerMsg, { t: "updates" }>;
  expect(relayed.items.find((i) => i.d === "n1")!.o).toBe("web:fay@a");

  // another area inside the workspace: refused, the connection stays
  a.ws.send(JSON.stringify({ t: "hello", area: "team-x", since: 0, client: "a" }));
  expect(await a.until((m) => m.t === "denied")).toEqual({ t: "denied", area: "team-x" });
  for (const c of [a, b]) c.ws.close();
});

test("an owner deletes a workspace for everyone, with its folder; a member cannot", async () => {
  const data = tempDir("obtion-server-");
  const base = await start({ OBTION_DATA: data, OBTION_SIGNUP: "open" });
  const owner = await signUp(base, "olga@example.org");
  const [w] = (await account(base, owner.token)).workspaces;
  const { code } = await post(base, `/api/workspaces/${w.id}/invites`, {}, owner.token).then((r) => r.json());
  const member = await signUp(base, "max@example.org", code);
  const sync = await connect(base, w.id, owner.token); // open, with a connection
  expect(existsSync(join(data, "workspaces", w.id))).toBe(true);

  const del = (token: string) => fetch(`${base}/api/workspaces/${w.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  expect((await del(member.token)).status).toBe(403);
  expect((await del(owner.token)).status).toBe(200);
  expect(existsSync(join(data, "workspaces", w.id))).toBe(false);
  expect((await account(base, owner.token)).workspaces).toEqual([]);
  expect((await account(base, member.token)).workspaces).toEqual([]);
  expect((await get(base, `/w/${w.id}/api/activity`, owner.token)).status).not.toBe(200);
  sync.ws.close();
  // nothing comes back into its folder afterwards
  await Bun.sleep(2000);
  expect(existsSync(join(data, "workspaces", w.id))).toBe(false);
});

test("account deletion requires a password and leaves last-owner workspaces intact", async () => {
  const user = await signUp(bare, "delete-owner@example.org");
  const [workspace] = (await account(bare, user.token)).workspaces;
  const remove = (body: unknown, token = user.token) => fetch(bare + "/api/account", {
    method: "DELETE", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await remove({ password: "geheim12345" }, "invalid")).status).toBe(401);
  expect((await remove({})).status).toBe(400);
  expect((await remove({ password: "wrong" })).status).toBe(403);
  expect((await remove({ password: "geheim12345" })).status).toBe(409);
  expect((await account(bare, user.token)).workspaces).toHaveLength(1);
  expect((await fetch(`${bare}/api/workspaces/${workspace.id}`, { method: "DELETE", headers: { authorization: `Bearer ${user.token}` } })).status).toBe(200);
  expect((await remove({ password: "geheim12345" })).status).toBe(200);
  expect((await get(bare, "/api/account", user.token)).status).toBe(401);
  expect((await post(bare, "/api/auth/sign-in/email", { email: "delete-owner@example.org", password: "geheim12345" })).ok).toBe(false);
  // Credentials are gone too: the same email can register again.
  expect((await signUp(bare, "delete-owner@example.org")).user.id).not.toBe(user.user.id);
});

test("deleting a member revokes sessions, invites, MCP tokens and live sync without deleting shared data", async () => {
  const owner = await signUp(bare, "delete-shared-owner@example.org");
  const [workspace] = (await account(bare, owner.token)).workspaces;
  const { code } = await post(bare, `/api/workspaces/${workspace.id}/invites`, {}, owner.token).then((r) => r.json());
  const member = await signUp(bare, "delete-member@example.org", code);
  const second = await post(bare, "/api/auth/sign-in/email", { email: "delete-member@example.org", password: "geheim12345" }).then((r) => r.json());
  const invite = await post(bare, `/api/workspaces/${workspace.id}/invites`, {}, member.token).then((r) => r.json());
  const agent = await post(bare, `/api/workspaces/${workspace.id}/mcp-token`, {}, member.token).then((r) => r.json());
  const live = await connect(bare, workspace.id, member.token);
  const closed = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("deleted account's sync remained open")), 3000);
    live.ws.onclose = (e) => { clearTimeout(timeout); resolve(e.code); };
  });
  expect((await fetch(bare + "/api/account", {
    method: "DELETE", headers: { authorization: `Bearer ${member.token}`, "content-type": "application/json" }, body: JSON.stringify({ password: "geheim12345" }),
  })).status).toBe(200);
  expect(await closed).toBe(4401);
  for (const token of [member.token, second.token]) expect((await get(bare, "/api/account", token)).status).toBe(401);
  expect((await get(bare, `/api/invites/${invite.code}`)).status).toBe(404);
  expect((await post(bare, `/w/${workspace.id}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, agent.token)).status).toBe(401);
  expect((await get(bare, `/w/${workspace.id}/api/activity`, owner.token)).status).toBe(200);
  expect(await get(bare, `/api/workspaces/${workspace.id}/members`, owner.token).then((r) => r.json())).toHaveLength(1);
});


test("a co-owner can delete their account, including admin and credential records", async () => {
  const accounts = new Accounts(tempDir("obtion-account-delete-"), { secret: "a-test-secret-longer-than-thirty-two-characters", baseURL: "http://localhost:8480", policy: "open" });
  try {
    await accounts.init(() => "Personal");
    const first = await accounts.signUp({ email: "first@example.org", name: "First", password: "geheim12345", personal: "Personal" });
    const [workspace] = accounts.workspacesOf(first.user.id);
    const invite = accounts.createInvite(workspace!.id, first.user.id);
    const second = await accounts.signUp({ email: "second@example.org", name: "Second", password: "geheim12345", personal: "Personal", invite });
    accounts.db.query("UPDATE members SET role = 'owner' WHERE user = ?").run(second.user.id);
    expect(accounts.isAdmin(first.user.id)).toBe(true);
    await accounts.deleteAccount(first.user.id, "geheim12345");
    expect(accounts.isAdmin(first.user.id)).toBe(false);
    expect(accounts.userCount()).toBe(1);
    expect(accounts.members(workspace!.id).map((m) => m.id)).toEqual([second.user.id]);
    expect(accounts.exists(workspace!.id)).toBe(true);
    for (const table of ["session", "account"])
      expect(accounts.db.query(`SELECT 1 FROM "${table}" WHERE userId = ?`).get(first.user.id)).toBeNull();
  } finally { accounts.db.close(); }
});
