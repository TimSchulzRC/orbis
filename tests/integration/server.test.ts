// The server as a program: accounts and workspaces (who sees what), with and without the web app,
// the data from before accounts, and the sync per workspace. Starts real servers.
import { test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import * as Y from "yjs";
import { tempDir, removeTempDirs } from "../support/helpers";
import { bootServer, del, get, mcpPost, mcpTool, post } from "../support/server";
import { FORMAT, PERSONAL, initItem } from "@obtion/core/model";
import { type ServerMsg, toB64 } from "@obtion/core/protocol";
import { Store } from "@obtion/server/store";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Servers start as their own processes: on a fresh checkout (cold transpiler cache) and beside the
// other checks in CI that takes seconds, more than bun's default of five. A test or hook that runs
// out of time also takes all the servers with it (bun kills the processes it spawned), so every test
// after it fails too. bootServer gives up after ten seconds; the tests get more than that.
setDefaultTimeout(30_000);

const procs: ReturnType<typeof Bun.spawn>[] = [];
async function start(env: Record<string, string>): Promise<string> {
  const { url, proc } = await bootServer(env);
  procs.push(proc);
  return url;
}

let plain = "";
let bare = "";
let legacy = "";
let legacyDir = "";
let bareDir = "";
beforeAll(async () => {
  // a built web app of its own: the test does not depend on `bun run build`
  const dist = tempDir("obtion-dist-");
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Obtion im Test</title>");
  // a data folder from before accounts, with one item
  legacyDir = tempDir("obtion-server-");
  const s = new Store(legacyDir);
  s.create({ title: "Von früher" }, "test", { id: "old-1" });
  s.flush();
  s.db.close();
  bareDir = tempDir("obtion-server-");
  [plain, bare, legacy] = await Promise.all([
    start({ OBTION_DATA: tempDir("obtion-server-"), OBTION_WEB_DIST: dist }),
    start({ OBTION_DATA: bareDir, OBTION_WEB_APP: "off", OBTION_SIGNUP: "open" }),
    start({ OBTION_DATA: legacyDir }),
  ]);
});
afterAll(async () => {
  for (const p of procs) (p.kill(), await p.exited);
  removeTempDirs();
});

async function signUp(base: string, email: string, invite?: string): Promise<{ token: string; user: { id: string } }> {
  const res = await post(base, "/api/account/signup", { name: email.split("@")[0], email, password: "geheim12345", invite });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
const account = (base: string, token: string) => get(base, "/api/account", token).then((r) => r.json());
/** A new workspace of the account, as the app creates the first one after signing up. */
const newWorkspace = (base: string, token: string, name = "Persönlich") => post(base, "/api/workspaces", { name }, token).then((r) => r.json());
const patch = (base: string, path: string, body: unknown, token: string) =>
  fetch(base + path, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test("the first account is the admin, without a workspace until it creates one; then only with an invite (default)", async () => {
  expect(await get(plain, "/api/info").then((r) => r.json())).toMatchObject({ signup: "invite", firstAccount: true });
  const ada = await signUp(plain, "ada@example.org");
  expect(await account(plain, ada.token)).toMatchObject({ admin: true, user: { email: "ada@example.org" }, workspaces: [] });
  await newWorkspace(plain, ada.token);
  const me = await account(plain, ada.token);
  expect(me.workspaces).toEqual([{ id: expect.any(String), name: "Persönlich", role: "owner" }]);
  expect((await post(plain, "/api/account/signup", { email: "eve@example.org", password: "geheim12345" })).status).toBe(403);
  expect((await get(plain, "/api/account")).status).toBe(401);

  // an invite link: Bob joins Ada's workspace
  const ws = me.workspaces[0].id as string;
  const { code } = await post(plain, `/api/workspaces/${ws}/invites`, {}, ada.token).then((r) => r.json());
  expect(await get(plain, `/api/invites/${code}`).then((r) => r.json())).toEqual({ workspace: "Persönlich", by: "ada", signup: true });
  const bob = await signUp(plain, "bob@example.org", code);
  expect((await account(plain, bob.token)).workspaces).toEqual([{ id: ws, name: "Persönlich", role: "member" }]);
  expect((await account(plain, bob.token)).admin).toBe(false);
  expect((await get(plain, `/api/workspaces/${ws}/members`, bob.token).then((r) => r.json())).map((m: any) => m.role)).toEqual(["owner", "member"]);
  // the last owner cannot leave; a member can
  expect((await del(plain, `/api/workspaces/${ws}/members/${ada.user.id}`, ada.token)).status).toBe(409);
  expect((await del(plain, `/api/workspaces/${ws}/members/${bob.user.id}`, bob.token)).status).toBe(200);
  expect((await account(plain, bob.token)).workspaces).toEqual([]);
  expect((await get(plain, `/api/workspaces/${ws}/members`, ada.token).then((r) => r.json())).map((m: any) => m.role)).toEqual(["owner"]);
});

test("a workspace is only open to its members – sync, files, activity, MCP", async () => {
  const carla = await signUp(bare, "carla@example.org"); // open signup on this server
  const dan = await signUp(bare, "dan@example.org");
  const cw = await newWorkspace(bare, carla.token);
  const dw = await newWorkspace(bare, dan.token);
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
  const call = (ws: string, t: string) => mcpPost(bare, `/w/${ws}/mcp`, t, "tools/list");
  expect((await call(cw.id, token)).status).toBe(200);
  expect((await call(dw.id, token)).status).toBe(401);
  expect((await call(cw.id, carla.token)).status).toBe(401); // a session is no MCP token
  // what the agent changes names it and the member whose token it uses
  await mcpTool(bare, token, "create", { items: [{ title: "Vom Agenten" }] }, `/w/${cw.id}/mcp`);
  const events = (await get(bare, `/w/${cw.id}/api/activity?limit=5`, carla.token).then((r) => r.json())) as { origin: string; title: string }[];
  expect(events.find((e) => e.title === "Vom Agenten")!.origin).toBe(`agent:mcp;u=${carla.user.id};n=carla`);
});

test("the sign-in only from the server's own page; other sites get no CORS answer", async () => {
  const eve = await signUp(bare, "eve@example.org");
  const w = await newWorkspace(bare, eve.token);
  const res = await fetch(`${bare}/w/${w.id}/api/activity`, { headers: { origin: "https://app.example.org", authorization: `Bearer ${eve.token}` } });
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect((await post(bare, "/api/auth/sign-in/email", { email: "eve@example.org", password: "geheim12345" }, undefined, { origin: "https://evil.example.org" })).status).toBe(403);
  const own = await post(bare, "/api/auth/sign-in/email", { email: "eve@example.org", password: "geheim12345" }, undefined, { origin: bare });
  expect(own.status).toBe(200);
  expect(await account(bare, (await own.json()).token)).toMatchObject({ user: { email: "eve@example.org" } });
});

test("without settings only passwords; the passkey routes stay shut; the OAuth cookie is traded only from the own page", async () => {
  const info = await get(bare, "/api/info").then((r) => r.json());
  expect(info.login).toEqual({ password: true, emailCode: false, passkey: false, oauth: [] });
  expect((await get(bare, "/api/auth/passkey/generate-authenticate-options")).status).toBe(404);
  expect((await post(bare, "/api/account/claim", {}, undefined, { origin: "https://evil.example.org" })).status).toBe(403);
  expect((await post(bare, "/api/account/claim", {}, undefined, { origin: bare })).status).toBe(401);
  // the way back from an OAuth provider comes from its site (Better Auth checks the state); nothing else does
  const back = await fetch(`${bare}/api/auth/callback/github?code=x&state=y`, { headers: { "sec-fetch-site": "cross-site" }, redirect: "manual" });
  expect(back.status).not.toBe(403);
  expect((await fetch(`${bare}/api/auth/list-accounts`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  expect((await post(bare, "/api/auth/callback/github", {}, undefined, { origin: "https://evil.example.org" })).status).toBe(403);
  const pw = await signUp(bare, "pw@example.org");
  expect(await account(bare, pw.token)).toMatchObject({ password: true });
});

test("linking a provider (its address may differ) needs a sign-in of the last minutes", async () => {
  const kim = await signUp(bare, "kim@example.org");
  const link = () => post(bare, "/api/auth/link-social", { provider: "github", callbackURL: "/" }, kim.token, { origin: bare });
  // fresh: on to Better Auth (no GitHub on this server)
  expect((await link()).status).not.toBe(403);
  const db = new Database(join(bareDir, "accounts.db"));
  db.query("UPDATE session SET createdAt = ? WHERE userId = ?").run(new Date(Date.now() - 11 * 60_000).toISOString(), kim.user.id);
  db.close();
  const stale = await link();
  expect(stale.status).toBe(403);
  expect(await stale.json()).toMatchObject({ error: "sign in again" });
  // however the token is written (Better Auth also takes "bearer"), and without one
  const lower = await fetch(`${bare}/api/auth/link-social`, { method: "POST", headers: { "content-type": "application/json", origin: bare, authorization: `bearer ${kim.token}` }, body: JSON.stringify({ provider: "github", callbackURL: "/" }) });
  expect(lower.status).toBe(403);
  // a fresh token on the side (the WebSocket way) does not vouch for the stale one Better Auth would use
  const fresh = await signUp(bare, "kim2@example.org");
  const mixed = await fetch(`${bare}/api/auth/link-social`, { method: "POST", headers: { "content-type": "application/json", origin: bare, authorization: `Bearer ${kim.token}`, "sec-websocket-protocol": `auth.${fresh.token}` }, body: JSON.stringify({ provider: "github", callbackURL: "/" }) });
  expect(mixed.status).toBe(403);
  expect((await post(bare, "/api/auth/link-social", { provider: "github", callbackURL: "/" }, undefined, { origin: bare })).status).toBe(403);
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
  expect((await mcpPost(legacy, "/mcp", old, "tools/list")).status).toBe(200);
  expect((await mcpPost(legacy, "/mcp", "wrong", "tools/list")).status).toBe(401);
});

test("every server brings the web app; OBTION_WEB_APP=off leaves sync, API and MCP", async () => {
  const app = await fetch(plain + "/");
  expect(app.status).toBe(200);
  expect(await app.text()).toContain("Obtion im Test");
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
  const w = await newWorkspace(bare, fay.token);
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
  expect(relayed.items.find((i) => i.d === "n1")!.o).toBe(`web:fay;u=${fay.user.id};d=a`);

  // another area inside the workspace: refused, the connection stays
  a.ws.send(JSON.stringify({ t: "hello", area: "team-x", since: 0, client: "a" }));
  expect(await a.until((m) => m.t === "denied")).toEqual({ t: "denied", area: "team-x" });
  for (const c of [a, b]) c.ws.close();
});

test("an owner deletes a workspace for everyone, with its folder; a member cannot", async () => {
  const data = tempDir("obtion-server-");
  const base = await start({ OBTION_DATA: data, OBTION_SIGNUP: "open" });
  const owner = await signUp(base, "olga@example.org");
  const w = await newWorkspace(base, owner.token);
  const { code } = await post(base, `/api/workspaces/${w.id}/invites`, {}, owner.token).then((r) => r.json());
  const member = await signUp(base, "max@example.org", code);
  const sync = await connect(base, w.id, owner.token); // open, with a connection
  const closed = new Promise<number>((resolve) => (sync.ws.onclose = (e) => resolve(e.code)));
  expect(existsSync(join(data, "workspaces", w.id))).toBe(true);

  const remove = (token: string) => del(base, `/api/workspaces/${w.id}`, token);
  expect((await remove(member.token)).status).toBe(403);
  expect((await remove(owner.token)).status).toBe(200);
  expect(await closed).toBe(4404); // the server shut it: its timers stopped, its database closed
  expect(existsSync(join(data, "workspaces", w.id))).toBe(false);
  expect((await account(base, owner.token)).workspaces).toEqual([]);
  expect((await account(base, member.token)).workspaces).toEqual([]);
  // nothing opens it again into its folder: not the API, not MCP, not a device reconnecting
  expect((await get(base, `/w/${w.id}/api/activity`, owner.token)).status).toBe(403);
  expect((await mcpPost(base, `/w/${w.id}/mcp`, owner.token, "tools/list")).status).toBe(401);
  await expect(connect(base, w.id, owner.token)).rejects.toThrow();
  expect(existsSync(join(data, "workspaces", w.id))).toBe(false);
});

test("account deletion requires a password and leaves last-owner workspaces intact", async () => {
  const user = await signUp(bare, "delete-owner@example.org");
  const workspace = await newWorkspace(bare, user.token);
  const remove = (body: unknown, token = user.token) => del(bare, "/api/account", token, body);
  expect((await remove({ password: "geheim12345" }, "invalid")).status).toBe(401);
  expect((await remove({})).status).toBe(400);
  expect((await remove({ password: "wrong" })).status).toBe(403);
  expect((await remove({ password: "geheim12345" })).status).toBe(409);
  expect((await account(bare, user.token)).workspaces).toHaveLength(1);
  expect((await del(bare, `/api/workspaces/${workspace.id}`, user.token)).status).toBe(200);
  expect((await remove({ password: "geheim12345" })).status).toBe(200);
  expect((await get(bare, "/api/account", user.token)).status).toBe(401);
  expect((await post(bare, "/api/auth/sign-in/email", { email: "delete-owner@example.org", password: "geheim12345" })).ok).toBe(false);
  // Credentials are gone too: the same email can register again.
  expect((await signUp(bare, "delete-owner@example.org")).user.id).not.toBe(user.user.id);
});

test("deleting a member revokes sessions, invites, MCP tokens and live sync without deleting shared data", async () => {
  const owner = await signUp(bare, "delete-shared-owner@example.org");
  const workspace = await newWorkspace(bare, owner.token);
  const { code } = await post(bare, `/api/workspaces/${workspace.id}/invites`, {}, owner.token).then((r) => r.json());
  const member = await signUp(bare, "delete-member@example.org", code);
  const second = await post(bare, "/api/auth/sign-in/email", { email: "delete-member@example.org", password: "geheim12345" }).then((r) => r.json());
  // only owners invite: the member becomes one first
  expect((await patch(bare, `/api/workspaces/${workspace.id}/members/${member.user.id}`, { role: "owner" }, owner.token)).status).toBe(200);
  const invite = await post(bare, `/api/workspaces/${workspace.id}/invites`, {}, member.token).then((r) => r.json());
  const agent = await post(bare, `/api/workspaces/${workspace.id}/mcp-token`, {}, member.token).then((r) => r.json());
  const live = await connect(bare, workspace.id, member.token);
  const closed = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("deleted account's sync remained open")), 3000);
    live.ws.onclose = (e) => { clearTimeout(timeout); resolve(e.code); };
  });
  expect((await del(bare, "/api/account", member.token, { password: "geheim12345" })).status).toBe(200);
  expect(await closed).toBe(4401);
  for (const token of [member.token, second.token]) expect((await get(bare, "/api/account", token)).status).toBe(401);
  expect((await get(bare, `/api/invites/${invite.code}`)).status).toBe(404);
  expect((await mcpPost(bare, `/w/${workspace.id}/mcp`, agent.token, "tools/list")).status).toBe(401);
  expect((await get(bare, `/w/${workspace.id}/api/activity`, owner.token)).status).toBe(200);
  expect(await get(bare, `/api/workspaces/${workspace.id}/members`, owner.token).then((r) => r.json())).toHaveLength(1);
});


test("owners manage members and invite links: list, revoke, roles, remove; members cannot; the last owner stays", async () => {
  const olga = await signUp(bare, "manage-olga@example.org");
  const w = await newWorkspace(bare, olga.token);
  const api = `/api/workspaces/${w.id}`;
  const first = await post(bare, `${api}/invites`, {}, olga.token).then((r) => r.json());
  const max = await signUp(bare, "manage-max@example.org", first.code);
  const role = (user: { user: { id: string } }, r: string, token: string) => patch(bare, `${api}/members/${user.user.id}`, { role: r }, token);

  // a member neither invites nor sees the links, changes roles or removes anyone
  expect((await post(bare, `${api}/invites`, {}, max.token)).status).toBe(403);
  expect((await get(bare, `${api}/invites`, max.token)).status).toBe(403);
  expect((await del(bare, `${api}/invites/${first.code}`, max.token)).status).toBe(403);
  expect((await role(olga, "member", max.token)).status).toBe(403);
  expect((await del(bare, `${api}/members/${olga.user.id}`, max.token)).status).toBe(403);

  // the owner sees every open link (newest first, who made it, until when) and revokes one
  const second = await post(bare, `${api}/invites`, {}, olga.token).then((r) => r.json());
  const links = await get(bare, `${api}/invites`, olga.token).then((r) => r.json());
  expect(links.map((l: any) => l.code)).toEqual([second.code, first.code]);
  expect(links[0]).toEqual({ code: second.code, by: "manage-olga", created: expect.any(Number), expires: expect.any(Number) });
  expect(Math.round((links[0].expires - links[0].created) / 86400_000)).toBe(14);
  expect((await del(bare, `${api}/invites/${first.code}`, olga.token)).status).toBe(200);
  expect((await del(bare, `${api}/invites/${first.code}`, olga.token)).status).toBe(404);
  expect((await get(bare, `/api/invites/${first.code}`)).status).toBe(404);
  const late = await signUp(bare, "manage-late@example.org");
  expect((await post(bare, `/api/invites/${first.code}`, {}, late.token)).status).toBe(404);
  expect((await get(bare, `${api}/invites`, olga.token).then((r) => r.json())).map((l: any) => l.code)).toEqual([second.code]);

  // roles: only "owner" or "member"; a new owner may invite
  expect((await role(max, "admin", olga.token)).status).toBe(400);
  expect((await role(max, "owner", olga.token)).status).toBe(200);
  expect((await account(bare, max.token)).workspaces[0].role).toBe("owner");
  const maxLink = await post(bare, `${api}/invites`, {}, max.token).then((r) => r.json());
  expect(maxLink.code).toEqual(expect.any(String));
  // two owners: one may step back; then the other is the last and stays
  expect((await role(olga, "member", max.token)).status).toBe(200);
  expect((await role(max, "member", max.token)).status).toBe(409);
  expect((await del(bare, `${api}/members/${max.user.id}`, max.token)).status).toBe(409);
  expect((await role(olga, "owner", max.token)).status).toBe(200);

  // removing someone: their connection ends, their agent token and their links go, the data stays
  const agent = await post(bare, `${api}/mcp-token`, {}, max.token).then((r) => r.json());
  const live = await connect(bare, w.id, max.token);
  const closed = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("the removed member's sync remained open")), 3000);
    live.ws.onclose = (e) => (clearTimeout(timeout), resolve(e.code));
  });
  expect((await del(bare, `${api}/members/${max.user.id}`, olga.token)).status).toBe(200);
  expect(await closed).toBe(4401);
  expect((await account(bare, max.token)).workspaces).toEqual([]);
  expect((await mcpPost(bare, `/w/${w.id}/mcp`, agent.token, "tools/list")).status).toBe(401);
  expect((await get(bare, `/api/invites/${maxLink.code}`)).status).toBe(404);
  expect((await get(bare, `/api/invites/${second.code}`)).status).toBe(200);
  expect((await get(bare, `/w/${w.id}/api/activity`, max.token)).status).toBe(403);
  expect((await del(bare, `${api}/members/${max.user.id}`, olga.token)).status).toBe(404);
  expect((await get(bare, `${api}/members`, olga.token).then((r) => r.json())).map((m: any) => m.role)).toEqual(["owner"]);
  expect((await role(olga, "member", olga.token)).status).toBe(409);
});
