// One workspace on the server: its own folder (workspaces/<id>/) with the database, the file
// contents, the Markdown mirror, the daily backups and the agent's sessions – what the whole
// server was before accounts. Opened when it is first used; everything below sees only it, so
// workspaces cannot reach each other's data.
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { AreaError, Store } from "./store";
import { Mirror } from "./mirror";
import { handleMcp } from "./mcp";
import { runAgent } from "./agent";
import { Blobs, MAX_BLOB } from "./blobs";
import { Backups } from "./backup";
import { FORMAT, PERSONAL, SETTINGS_ID, fileTypeOf } from "@obtion/core/model";
import { addLaterDefaultProps, migrateCollections, renameShippedLabels, upgradeAreas, upgradeHideEmptyTaskFields } from "@obtion/core/setup";
import type { Lang } from "@obtion/core/i18n";
import { storeWriter } from "./importers";
import { UndoError, redoStep, undoStep } from "./undo";
import { type ClientMsg, type ServerMsg, type WireUpdate, fromB64, toB64 } from "@obtion/core/protocol";

export interface Conn {
  workspace: string;
  areas: Set<string>; // said hello for these: only then it gets (and may push) their updates
  origin: string;
  user: string;
}

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

/** One-time upgrades of older data, as the server ran them at start before workspaces. */
function upgrade(store: Store) {
  // Properties shipped after a default type was set up ("Wartet auf"): added once, nothing migrated.
  const lang = store.records.get(SETTINGS_ID)?.settings?.setupLang as Lang | undefined;
  if (lang && addLaterDefaultProps(storeWriter(store, "system:setup"), lang).length) store.flush();
  if (lang && renameShippedLabels(storeWriter(store, "system:setup"), lang)) store.flush();
  if (upgradeHideEmptyTaskFields(storeWriter(store, "system:setup"))) store.flush();
  // collections are gone (26.10.): their views go to the types, the inbox rule to the settings
  const moved = lang ? migrateCollections(storeWriter(store, "system:setup"), store.index(), store.eachDoc(), lang) : [];
  if (moved.length) (store.flush(), console.log(`[obtion] collections migrated:\n  ${moved.join("\n  ")}`));
  // areas (27.10.): every document from before belongs to the personal area
  const marked = upgradeAreas(storeWriter(store, "system:setup"), store.eachDoc());
  if (marked) (store.flush(), console.log(`[obtion] areas: ${marked} documents marked as personal`));
}

/**
 * The areas a device may sync inside a workspace. One: the workspace is the unit of rights now,
 * the area inside it stays the personal one.
 */
const AREAS = new Set([PERSONAL]);

export class Workspace {
  store: Store;
  blobs: Blobs;
  conns = new Set<ServerWebSocket<Conn>>();
  private backups: Backups;
  private mirror: Mirror;

  constructor(
    public id: string,
    public dir: string,
  ) {
    this.store = new Store(dir);
    upgrade(this.store);
    this.blobs = new Blobs(join(dir, "blobs"), this.store);
    const mirror = (this.mirror = new Mirror(this.store, join(dir, "vault"), this.blobs));
    this.store.on({
      update: (u, from) => {
        const item: WireUpdate = { s: u.seq, d: u.doc, u: toB64(u.data), o: u.origin };
        for (const ws of this.conns) if (ws.data.areas.has(u.area) && ws !== from) send(ws, { t: "updates", area: u.area, items: [item], last: u.seq, lastId: u.uid });
      },
      event: (event) => {
        if (event.step) Object.assign(event, this.store.stepState(event.step));
        const area = this.store.areaOf(event.doc) ?? PERSONAL;
        for (const ws of this.conns) if (ws.data.areas.has(area)) send(ws, { t: "event", event });
      },
      record: (r) => {
        if (r.file && this.blobs.needsWork(r)) this.blobs.schedule(r.id);
      },
    });
    this.blobs.onStored = (hash) => {
      for (const ws of this.conns) if (ws.data.areas.size) send(ws, { t: "blob", hash });
    };
    this.blobs.scan();
    mirror.start();
    this.backups = new Backups(this.store, join(dir, "backups"));
    this.backups.start();
  }

  close() {
    this.backups.stop();
    this.mirror.stop();
    this.store.flush();
  }

  /** Closed for good (deleted): connections end, nothing writes into its folder any more. */
  shut() {
    for (const ws of this.conns) ws.close(4404, "workspace deleted");
    this.close();
    this.blobs.stop();
    this.store.db.close();
  }

  // ---------- sync ----------

  hello(ws: ServerWebSocket<Conn>, msg: Extract<ClientMsg, { t: "hello" }>) {
    const area = typeof msg.area === "string" ? msg.area : PERSONAL; // apps from before areas: personal
    if (!AREAS.has(area)) return send(ws, { t: "denied", area });
    if (msg.device) ws.data.origin = `web:${ws.data.user}@${String(msg.device).slice(0, 40)}`;
    const store = this.store;
    const last = store.last(area);
    send(ws, { t: "welcome", hub: store.serverId, area, seq: last.seq, format: FORMAT });
    const reset = !store.knowsCursor(area, msg.since, msg.sinceId); // server restored from an older backup; replica must merge everything
    const ids = store.docsSince(area, reset ? 0 : msg.since);
    const BATCH = 150;
    if (ids.length === 0) send(ws, { t: "updates", area, items: [], last: last.seq, lastId: last.uid || undefined, initial: true, done: true, reset });
    for (let i = 0; i < ids.length; i += BATCH) {
      const items = ids.slice(i, i + BATCH).map((d) => ({ d, u: toB64(store.stateOf(d)) }));
      const done = i + BATCH >= ids.length;
      // Only the final batch carries the real position, so an interrupted first sync is retried.
      send(ws, { t: "updates", area, items, last: done ? last.seq : 0, lastId: done ? last.uid || undefined : undefined, initial: true, done, reset: reset && i === 0 });
    }
    ws.data.areas.add(area);
  }

  message(ws: ServerWebSocket<Conn>, msg: ClientMsg) {
    if (msg.t === "hello") this.hello(ws, msg);
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
          this.store.applyRemote(it.d, fromB64(it.u), ws.data.origin, ws, step, area);
          keys.push(it.k);
        } catch (e) {
          if (e instanceof AreaError) console.error(`[sync] refused: ${e.message}`);
          else console.error("[sync] bad update", it.d, e);
          keys.push(it.k); // drop malformed or misplaced updates instead of retrying forever
        }
      }
      const last = this.store.last(area);
      send(ws, { t: "ack", area, keys, last: last.seq, lastId: last.uid || undefined });
    }
  }

  // ---------- http: /w/<id>/<rest> ----------

  /**
   * The workspace's API for a member. `rest` is the path after /w/<id>; `actor` names the user
   * in the activity ("web:Ada@Mac-x3f9").
   */
  async handle(req: Request, rest: string, ctx: { user: string; agent: { allowed: boolean; mcpUrl: string; token: string; model?: string } }): Promise<Response> {
    const url = new URL(req.url);
    const store = this.store;

    if (rest === "/api/activity") {
      const before = Number(url.searchParams.get("before") ?? 0) || undefined;
      const doc = url.searchParams.get("doc") ?? undefined;
      return Response.json(store.events({ before, doc, limit: Number(url.searchParams.get("limit") ?? 60) }));
    }

    if (rest === "/api/undo" && req.method === "POST") {
      if (!(req.headers.get("content-type") ?? "").includes("application/json")) return new Response("JSON required", { status: 415 });
      const body = (await req.json()) as { step?: string; redo?: boolean; device?: string };
      if (typeof body.step !== "string") return new Response("step required", { status: 400 });
      const actor = `web:${ctx.user}${body.device ? "@" + String(body.device).slice(0, 40) : ""}`;
      try {
        return Response.json((body.redo ? redoStep : undoStep)(store, body.step, actor));
      } catch (e) {
        if (e instanceof UndoError) return Response.json({ error: e.message }, { status: 409 });
        throw e;
      }
    }

    if (rest === "/api/agent" && req.method === "POST") {
      if (!ctx.agent.allowed) return new Response("The agent is not available for this account", { status: 403 });
      if (!(req.headers.get("content-type") ?? "").includes("application/json")) return new Response("JSON required", { status: 415 });
      const body = (await req.json()) as { message: string; sessionId?: string; context?: string; model?: string };
      if (!body.message?.trim()) return new Response("message required", { status: 400 });
      const ac = new AbortController();
      req.signal.addEventListener("abort", () => ac.abort());
      const gen = runAgent({
        message: body.message,
        sessionId: body.sessionId,
        context: body.context,
        model: body.model || ctx.agent.model || "sonnet",
        mcpUrl: ctx.agent.mcpUrl,
        token: ctx.agent.token,
        dataDir: this.dir,
        signal: ac.signal,
      });
      return sse(gen, () => ac.abort());
    }

    if (rest.startsWith("/api/blobs/")) return this.blob(req, url, rest.slice("/api/blobs/".length));
    return new Response("Not found", { status: 404 });
  }

  mcp(req: Request): Promise<Response> {
    return handleMcp(this.store, req, this.blobs);
  }

  private async blob(req: Request, url: URL, hash: string): Promise<Response> {
    const { blobs, store } = this;
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
}

export function send(ws: ServerWebSocket<Conn>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
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
