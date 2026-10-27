// The server as a program: who it trusts with the caller's identity, with and without the web app,
// and the sync per area. Starts real servers.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "node:net";
import * as Y from "yjs";
import { tempDir, removeTempDirs } from "./helpers";
import { FORMAT, PERSONAL, initItem } from "@obtion/core/model";
import { type ServerMsg, toB64 } from "@obtion/core/protocol";
import { allowedHosts, trustedProxies } from "@obtion/server/trust";

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
    cwd: `${import.meta.dir}/..`,
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
beforeAll(async () => {
  plain = await start({ OBTION_DATA: tempDir("obtion-server-") });
  bare = await start({ OBTION_DATA: tempDir("obtion-server-"), OBTION_TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.5", OBTION_WEB_APP: "off" });
});
afterAll(async () => {
  for (const p of procs) (p.kill(), await p.exited);
  removeTempDirs();
});

const who = (base: string) => fetch(base + "/api/info", { headers: { "tailscale-user-login": "ada@example.org", "tailscale-user-name": "Ada" } }).then((r) => r.json());

test("trusted proxies: loopback by default; addresses and ranges from the list; anything else is not", () => {
  const def = trustedProxies();
  expect(def("127.0.0.1")).toBe(true);
  expect(def("::1")).toBe(true);
  expect(def("::ffff:127.0.0.1")).toBe(true);
  expect(def("172.17.0.1")).toBe(false);
  expect(def(undefined)).toBe(false);
  const list = trustedProxies("172.16.0.0/12, 10.1.2.3, fd00::1, nonsense, 1.2.3.4/99");
  expect(list("172.17.0.1")).toBe(true);
  expect(list("172.31.255.255")).toBe(true);
  expect(list("172.32.0.1")).toBe(false);
  expect(list("::ffff:10.1.2.3")).toBe(true);
  expect(list("10.1.2.4")).toBe(false);
  expect(list("FD00::1")).toBe(true);
  expect(list("127.0.0.1")).toBe(false); // a list replaces the default
});

test("host names: addresses and private names on any port, public names only when configured", () => {
  const ok = allowedHosts(["obtion.example.org", "notes.example.com:8443", ""]);
  for (const h of ["192.168.1.10:8480", "100.101.102.103:9000", "127.0.0.1:8480", "[fd7a:115c::1]:8480", "[::1]:8480", "nas:8480", "localhost:5180", "nas.local:8480", "nas.fritz.lan", "nas.tail1234.ts.net", "nas.tail1234.ts.net:8480", "obtion.example.org", "Obtion.Example.org:443", "notes.example.com:8443"])
    expect([h, ok(h)]).toEqual([h, true]);
  for (const h of ["evil.example.net", "evil.example.net:8480", "notes.example.com:8480", "ts.net.evil.example", "", null])
    expect([h, ok(h)]).toEqual([h, false]);
});

test("the identity headers count from a trusted proxy only", async () => {
  expect(await who(plain)).toMatchObject({ user: "ada@example.org", name: "Ada" });
  // the second server trusts only 10.0.0.0/8 and 192.168.1.5: the same request from loopback is anonymous
  const anon = await who(bare);
  expect(anon.user).toBe("local");
  expect(anon.name).toBeUndefined();
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

/** A sync connection that collects what the server sends. */
async function connect(base: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/sync");
  const msgs: ServerMsg[] = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
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

for (const which of ["with", "without"] as const)
  test(`sync per area (${which} the web app); an app from before areas means the personal one`, async () => {
    const base = which === "with" ? plain : bare;
    const a = await connect(base);
    const b = await connect(base);
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
    expect(relayed.area).toBe(PERSONAL);

    // an area this server does not hold for the device: refused, the connection stays
    a.ws.send(JSON.stringify({ t: "hello", area: "team-x", since: 0, client: "a" }));
    expect(await a.until((m) => m.t === "denied")).toEqual({ t: "denied", area: "team-x" });
    for (const c of [a, b]) c.ws.close();
  });
