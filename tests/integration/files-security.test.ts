// Who may read and write file contents, and how much a request may carry: every way in needs a
// token in the header (or a short signed link for one content), never a session or MCP token in the
// URL. Starts a real server.
import { test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { tempDir, removeTempDirs } from "../support/helpers";
import { bootServer, get, post } from "../support/server";
import { sha256 } from "@obtion/server/blobs";

setDefaultTimeout(60_000);

let base = "";
let proc: ReturnType<typeof Bun.spawn>;
let owner: { token: string; user: { id: string } };
let ws = "";
let agent = "";

async function signUp(email: string) {
  const res = await post(base, "/api/account/signup", { name: email.split("@")[0], email, password: "geheim12345" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

beforeAll(async () => {
  ({ url: base, proc } = await bootServer({ OBTION_DATA: tempDir("obtion-filesec-"), OBTION_WEB_APP: "off", OBTION_SIGNUP: "open" }));
  owner = await signUp("owner@example.org");
  ws = (await post(base, "/api/workspaces", { name: "Projekt" }, owner.token).then((r) => r.json())).id;
  agent = (await post(base, `/api/workspaces/${ws}/mcp-token`, {}, owner.token).then((r) => r.json())).token;
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
  const big = JSON.stringify({ email: "x@example.org", password: "geheim12345", name: "x".repeat(2 * 1024 * 1024) });
  const byLength = await fetch(`${base}/api/account/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
  expect(byLength.status).toBe(413);
  const streamed = await fetch(`${base}/api/account/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: chunked(2 * 1024 * 1024) });
  expect(streamed.status).toBe(413);
  // a small chunked body still arrives
  const small = await fetch(`${base}/api/account/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: new Blob([JSON.stringify({ email: "klein@example.org", password: "geheim12345", name: "Klein" })]).stream() });
  expect(small.status).toBe(200);
  // a workspace route as well, with a valid token
  const undo = await fetch(`${base}/w/${ws}/api/undo`, { method: "POST", headers: { "content-type": "application/json", ...bearer(owner.token) }, body: chunked(2 * 1024 * 1024) });
  expect(undo.status).toBe(413);
  // the file routes take more than that
  const file = await fetch(`${base}/w/${ws}/api/files?name=gross.bin`, { method: "POST", headers: bearer(agent), body: chunked(3 * 1024 * 1024) });
  expect(file.status).toBe(201);
});

test("the app's upload by hash streams and checks the hash: a wrong one is 400 and leaves nothing", async () => {
  const content = "Inhalt nach Hash";
  const hash = sha256(content);
  const wrong = sha256("etwas anderes");
  const bad = await fetch(`${base}/w/${ws}/api/blobs/${wrong}`, { method: "PUT", headers: bearer(owner.token), body: content });
  expect(bad.status).toBe(400);
  for (const h of [wrong, hash]) expect((await get(base, `/w/${ws}/api/blobs/${h}`, owner.token)).status).toBe(404);
  const ok = await fetch(`${base}/w/${ws}/api/blobs/${hash}`, { method: "PUT", headers: bearer(owner.token), body: new Blob([content]).stream() });
  expect(ok.status).toBe(200);
  expect(await (await get(base, `/w/${ws}/api/blobs/${hash}`, owner.token)).text()).toBe(content);
});
