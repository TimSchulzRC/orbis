// Obtion server: serves the web app, the sync WebSocket, the MCP endpoint and the
// in-app agent. Intended to run on the NAS / home server behind Tailscale.
import * as Y from "yjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import type { ServerWebSocket } from "bun";
import { AreaError, Store } from "./store";
import { Mirror } from "./mirror";
import { handleMcp, INSTRUCTIONS } from "./mcp";
import { agentAvailable, runAgent } from "./agent";
import { Blobs, MAX_BLOB } from "./blobs";
import { FORMAT, PERSONAL, SETTINGS_ID, fileTypeOf } from "@obtion/core/model";
import { addLaterDefaultProps, migrateCollections, renameShippedLabels, upgradeAreas, upgradeHideEmptyTaskFields, upgradeStartPage } from "@obtion/core/setup";
import type { Lang } from "@obtion/core/i18n";
import { storeWriter } from "./importers";
import { UndoError, redoStep, undoStep } from "./undo";
import { DEFAULT_TRUSTED, trustedProxies } from "./trust";
import { type ClientMsg, type ServerMsg, type WireUpdate, fromB64, toB64 } from "@obtion/core/protocol";

const PORT = Number(process.env.PORT ?? 8480);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA = resolve(process.env.OBTION_DATA ?? "data");
/** The built web app (apps/web/dist); OBTION_WEB_DIST points elsewhere. */
const DIST = resolve(process.env.OBTION_WEB_DIST ?? join(import.meta.dir, "../../web/dist"));
const PUBLIC_URL = process.env.OBTION_PUBLIC_URL ?? "";
/** Every server brings the web app; OBTION_WEB_APP=off makes it a server for sync, API and MCP only. */
const WEB_APP = !/^(off|0|false|no)$/i.test(process.env.OBTION_WEB_APP ?? "on");

mkdirSync(DATA, { recursive: true });
const configPath = join(DATA, "config.json");
const config: { token: string } = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, "utf8"))
  : { token: Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url") };
if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

const store = new Store(DATA);
// Properties shipped after a default type was set up ("Wartet auf"): added once, nothing migrated.
{
  const lang = store.records.get(SETTINGS_ID)?.settings?.setupLang as Lang | undefined;
  if (lang && addLaterDefaultProps(storeWriter(store, "system:setup"), lang).length) store.flush();
  if (lang && upgradeStartPage(storeWriter(store, "system:setup"), lang)) store.flush();
  if (lang && renameShippedLabels(storeWriter(store, "system:setup"), lang)) store.flush();
  if (upgradeHideEmptyTaskFields(storeWriter(store, "system:setup"))) store.flush();
  // collections are gone (26.10.): their views go to the types, the inbox rule to the settings
  const moved = lang ? migrateCollections(storeWriter(store, "system:setup"), store.index(), store.docs, lang) : [];
  if (moved.length) (store.flush(), console.log(`[obtion] collections migrated:\n  ${moved.join("\n  ")}`));
  // areas (27.10.): every document from before belongs to the personal area
  const marked = upgradeAreas(storeWriter(store, "system:setup"), store.docs);
  if (marked) (store.flush(), console.log(`[obtion] areas: ${marked} documents marked as personal`));
}
/** The areas a device may sync. One for now; with accounts (later) the server decides per user. */
const AREAS = new Set([PERSONAL]);
const blobs = new Blobs(join(DATA, "blobs"), store);
const mirror = new Mirror(store, join(DATA, "vault"), blobs);

console.log(`[obtion] ${store.records.size} nodes, seq ${store.seq}, data in ${DATA}`);

// ---------- sync server ----------

interface Conn {
  areas: Set<string>; // said hello for these: only then it gets (and may push) their updates
  origin: string;
  user: string;
}
const conns = new Set<ServerWebSocket<Conn>>();

function send(ws: ServerWebSocket<Conn>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

store.on({
  update: (u, from) => {
    const item: WireUpdate = { s: u.seq, d: u.doc, u: toB64(u.data), o: u.origin };
    for (const ws of conns) if (ws.data.areas.has(u.area) && ws !== from) send(ws, { t: "updates", area: u.area, items: [item], last: u.seq, lastId: u.uid });
  },
  event: (event) => {
    if (event.step) Object.assign(event, store.stepState(event.step));
    const area = store.areaOf(event.doc) ?? PERSONAL;
    for (const ws of conns) if (ws.data.areas.has(area)) send(ws, { t: "event", event });
  },
  record: (r) => {
    if (r.file && blobs.needsWork(r)) blobs.schedule(r.id);
  },
});
blobs.onStored = (hash) => {
  for (const ws of conns) if (ws.data.areas.size) send(ws, { t: "blob", hash });
};
blobs.scan();
mirror.start();

function handleHello(ws: ServerWebSocket<Conn>, msg: Extract<ClientMsg, { t: "hello" }>) {
  const area = typeof msg.area === "string" ? msg.area : PERSONAL; // apps from before areas: personal
  if (!AREAS.has(area)) return send(ws, { t: "denied", area });
  if (msg.device) ws.data.origin = `web:${ws.data.user}@${String(msg.device).slice(0, 40)}`;
  const last = store.last(area);
  send(ws, { t: "welcome", hub: store.serverId, area, seq: last.seq, format: FORMAT });
  const reset = !store.knowsCursor(area, msg.since, msg.sinceId); // server restored from an older backup; replica must merge everything
  const ids = store.docsSince(area, reset ? 0 : msg.since);
  const BATCH = 150;
  if (ids.length === 0) send(ws, { t: "updates", area, items: [], last: last.seq, lastId: last.uid || undefined, initial: true, done: true, reset });
  for (let i = 0; i < ids.length; i += BATCH) {
    const items = ids.slice(i, i + BATCH).map((d) => ({ d, u: toB64(Y.encodeStateAsUpdate(store.getDoc(d))) }));
    const done = i + BATCH >= ids.length;
    // Only the final batch carries the real position, so an interrupted first sync is retried.
    send(ws, { t: "updates", area, items, last: done ? last.seq : 0, lastId: done ? last.uid || undefined : undefined, initial: true, done, reset: reset && i === 0 });
  }
  ws.data.areas.add(area);
}

// ---------- http ----------

/**
 * Browsers always send Origin on WebSocket upgrades and cross-site requests. Reject
 * other sites (cross-site WebSocket hijacking, CSRF against the agent and uploads).
 * Requests without Origin come from non-browser clients on the tailnet.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

// DNS rebinding guard: only answer to host names we actually serve under.
const ALLOWED_HOSTS = new Set(
  [
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
    "localhost:5180", // vite dev server proxy
    PUBLIC_URL ? new URL(PUBLIC_URL).host : "",
    ...(process.env.OBTION_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()),
  ].filter(Boolean),
);

/** Uploads: only kinds the app knows how to show (no HTML, scripts, executables). */
const UPLOAD_OK = (name: string) => fileTypeOf(name) !== "sonstiges" || /\.(zip|json|xml|ics|vcf)$/i.test(name);
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)|application\/pdf|audio\/|video\/|text\/plain)/;

async function sniffImage(path: string): Promise<string> {
  const head = new Uint8Array(await Bun.file(path).slice(0, 12).arrayBuffer());
  if (head[0] === 0x89 && head[1] === 0x50) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (String.fromCharCode(...head.slice(8, 12)) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

/**
 * tailscale serve adds who is calling (tailscale-user-login/-name). Only trusted when the
 * connection comes from a trusted proxy (trust.ts: loopback, or OBTION_TRUSTED_PROXIES) – with
 * HOST=0.0.0.0 anyone else could send the header.
 */
const trusted = trustedProxies(process.env.OBTION_TRUSTED_PROXIES || DEFAULT_TRUSTED);
let viaLocal = (_req: Request) => false; // set once the server runs (it knows the peer address)
function userOf(req: Request) {
  return (viaLocal(req) && req.headers.get("tailscale-user-login")) || "local";
}
function userName(req: Request) {
  return (viaLocal(req) && req.headers.get("tailscale-user-name")) || undefined;
}

function sse(gen: AsyncGenerator<unknown>, onClose: () => void): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of gen) controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      } catch (e) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "error", message: String(e) })}\n\n`));
      } finally {
        controller.close();
      }
    },
    cancel: onClose,
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}

async function serveStatic(path: string): Promise<Response> {
  const clean = path.replace(/\.\.+/g, "");
  let file = Bun.file(join(DIST, clean === "/" ? "index.html" : clean));
  let isIndex = clean === "/";
  if (!(await file.exists())) {
    if (extname(clean)) return new Response("Not found", { status: 404 });
    file = Bun.file(join(DIST, "index.html"));
    isIndex = true;
    if (!(await file.exists())) return new Response("Web app not built. Run `bun run build`.", { status: 503 });
  }
  const immutable = clean.startsWith("/assets/");
  return new Response(file, {
    headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : isIndex || clean.endsWith("sw.js") ? "no-cache" : "public, max-age=3600" },
  });
}

const server = Bun.serve<Conn>({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!ALLOWED_HOSTS.has(req.headers.get("host") ?? "")) return new Response("Unknown host", { status: 421 });
    const guarded = path === "/sync" || path === "/api/connect" || (path.startsWith("/api/") && req.method !== "GET");
    if (guarded && !sameOrigin(req)) return new Response("Forbidden", { status: 403 });

    if (path === "/sync") {
      const user = userOf(req).split("@")[0]!;
      if (srv.upgrade(req, { data: { areas: new Set<string>(), origin: `web:${user}`, user } })) return;
      return new Response("Expected WebSocket", { status: 400 });
    }

    if (path === "/mcp") {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${config.token}`) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      return handleMcp(store, req, blobs);
    }

    if (path === "/api/info") {
      return Response.json({
        user: userOf(req),
        name: userName(req),
        agent: agentAvailable(),
        nodes: store.live().length,
        seq: store.seq,
      });
    }

    if (path === "/api/connect") {
      const base = PUBLIC_URL || `${url.protocol}//${req.headers.get("host")}`;
      const mcpUrl = `${base}/mcp`;
      return Response.json({
        mcpUrl,
        token: config.token,
        claudeCode: `claude mcp add --transport http obtion ${mcpUrl} --header "Authorization: Bearer ${config.token}" -s user`,
        json: { mcpServers: { obtion: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${config.token}` } } } },
        vault: join(DATA, "vault"),
        instructions: INSTRUCTIONS,
      });
    }

    if (path === "/api/activity") {
      const before = Number(url.searchParams.get("before") ?? 0) || undefined;
      const doc = url.searchParams.get("doc") ?? undefined;
      return Response.json(store.events({ before, doc, limit: Number(url.searchParams.get("limit") ?? 60) }));
    }

    if (path === "/api/undo" && req.method === "POST") {
      if (!(req.headers.get("content-type") ?? "").includes("application/json")) return new Response("JSON required", { status: 415 });
      const body = (await req.json()) as { step?: string; redo?: boolean; device?: string };
      if (typeof body.step !== "string") return new Response("step required", { status: 400 });
      const actor = `web:${userOf(req).split("@")[0]}${body.device ? "@" + String(body.device).slice(0, 40) : ""}`;
      try {
        return Response.json((body.redo ? redoStep : undoStep)(store, body.step, actor));
      } catch (e) {
        if (e instanceof UndoError) return Response.json({ error: e.message }, { status: 409 });
        throw e;
      }
    }

    if (path === "/api/agent" && req.method === "POST") {
      if (!(req.headers.get("content-type") ?? "").includes("application/json")) return new Response("JSON required", { status: 415 });
      const body = (await req.json()) as { message: string; sessionId?: string; context?: string; model?: string };
      if (!body.message?.trim()) return new Response("message required", { status: 400 });
      const ac = new AbortController();
      req.signal.addEventListener("abort", () => ac.abort());
      const gen = runAgent({
        message: body.message,
        sessionId: body.sessionId,
        context: body.context,
        model: body.model || process.env.OBTION_AGENT_MODEL || "sonnet",
        mcpUrl: `http://127.0.0.1:${PORT}/mcp`,
        token: config.token,
        dataDir: DATA,
        signal: ac.signal,
      });
      return sse(gen, () => ac.abort());
    }

    if (path.startsWith("/api/blobs/")) {
      const hash = path.slice("/api/blobs/".length);
      if (!Blobs.valid(hash)) return new Response("bad hash", { status: 400 });
      if (req.method === "PUT") {
        const name = url.searchParams.get("name") ?? "";
        if (!UPLOAD_OK(name) && !url.searchParams.has("derived")) return new Response("File type not allowed", { status: 415 });
        if (Number(req.headers.get("content-length") ?? 0) > MAX_BLOB) return new Response("Too large", { status: 413 });
        const data = new Uint8Array(await req.arrayBuffer());
        if (data.length > MAX_BLOB) return new Response("Too large", { status: 413 });
        return (await blobs.put(hash, data)) ? Response.json({ ok: true }) : new Response("Hash mismatch", { status: 422 });
      }
      // the app asks politely (no error in the console) and shows "Datei fehlt"
      if (!blobs.has(hash)) return req.headers.get("x-obtion-probe") ? new Response(null, { status: 204, headers: { "x-obtion-missing": "1" } }) : new Response("Not found", { status: 404 });
      if (url.searchParams.has("check")) return new Response(null, { status: 204 });
      const rec = store.live().find((r) => r.file?.hash === hash) ?? [...store.records.values()].find((r) => r.file?.hash === hash);
      const mime = rec?.file?.mime ?? (await sniffImage(blobs.path(hash))); // derived versions: WebP (or PNG/JPEG from a device)
      const headers: Record<string, string> = {
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        // Never let a file run as part of the app (SVG, HTML-like content).
        "content-security-policy": mime === "application/pdf" ? "script-src 'none'" : "sandbox",
        "content-type": INLINE.test(mime) ? mime : "application/octet-stream",
      };
      const fname = (url.searchParams.get("name") ?? rec?.file?.name ?? hash).replace(/["\\\r\n]/g, "");
      if (url.searchParams.has("download") || !INLINE.test(mime)) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`;
      return new Response(Bun.file(blobs.path(hash)), { headers });
    }

    if (path.startsWith("/api/")) return new Response("Not found", { status: 404 });
    if (!WEB_APP) return new Response("This Obtion server serves sync, API and MCP only (OBTION_WEB_APP=off).", { status: 404 });
    return serveStatic(path);
  },
  websocket: {
    maxPayloadLength: 64 * 1024 * 1024,
    open(ws) {
      conns.add(ws);
    },
    close(ws) {
      conns.delete(ws);
    },
    message(ws, raw) {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === "hello") handleHello(ws, msg);
      else if (msg.t === "ping") send(ws, { t: "pong" });
      else if (msg.t === "push") {
        // only after the welcome: the client has to know which server it writes to (server-id check);
        // no ack, so its outbox keeps the changes and sends them again after the next hello
        const area = typeof msg.area === "string" ? msg.area : PERSONAL;
        if (!ws.data.areas.has(area)) return;
        const keys: string[] = [];
        for (const it of msg.items) {
          try {
            const step = typeof it.s === "string" && /^[\w-]{1,40}$/.test(it.s) ? it.s : undefined;
            store.applyRemote(it.d, fromB64(it.u), ws.data.origin, ws, step, area);
            keys.push(it.k);
          } catch (e) {
            if (e instanceof AreaError) console.error(`[sync] refused: ${e.message}`);
            else console.error("[sync] bad update", it.d, e);
            keys.push(it.k); // drop malformed or misplaced updates instead of retrying forever
          }
        }
        const last = store.last(area);
        send(ws, { t: "ack", area, keys, last: last.seq, lastId: last.uid || undefined });
      }
    },
  },
});

viaLocal = (r) => trusted(server.requestIP(r)?.address);

console.log(`[obtion] listening on http://${server.hostname}:${server.port}${WEB_APP ? "" : " (no web app: OBTION_WEB_APP=off)"}`);

process.on("SIGTERM", () => {
  store.flush();
  process.exit(0);
});
process.on("SIGINT", () => {
  store.flush();
  process.exit(0);
});
