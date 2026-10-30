// One workspace on the server: its own folder (workspaces/<id>/) with the database, the file
// contents, the Markdown mirror, the daily backups – what the whole server was before accounts. Opened when it is first used; everything below sees only it, so
// workspaces cannot reach each other's data.
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { AreaError, Store } from "./store";
import { Mirror } from "./mirror";
import { handleMcp } from "./mcp";
import { Blobs } from "./blobs";
import { MAX_BLOB } from "./config";
import { body, fail, json } from "./http";
import { Backups } from "./backup";
import { FORMAT, PERSONAL, fileTypeOf } from "@obtion/core/model";
import { addLaterDefaultProps, migrateCollections, renameShippedLabels, upgradeAreas, upgradeHideEmptyTaskFields } from "@obtion/core/setup";
import { SETUP_ORIGIN, storeWriter } from "./importers";
import { UndoError, redoStep, undoStep } from "./undo";
import { type ClientMsg, type ServerMsg, type WireUpdate, fromB64, toB64 } from "@obtion/core/protocol";

export interface Conn {
  userId: string;
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
  const lang = store.setupLang();
  const w = storeWriter(store, SETUP_ORIGIN);
  if (lang && addLaterDefaultProps(w, lang).length) store.flush();
  if (lang && renameShippedLabels(w, lang)) store.flush();
  if (upgradeHideEmptyTaskFields(w)) store.flush();
  // collections are gone (26.10.): their views go to the types, the inbox rule to the settings
  const moved = lang ? migrateCollections(w, store.index(), store.eachDoc(), lang) : [];
  if (moved.length) (store.flush(), console.log(`[obtion] collections migrated:\n  ${moved.join("\n  ")}`));
  // areas (27.10.): every document from before belongs to the personal area
  const marked = upgradeAreas(w, store.eachDoc());
  if (marked) (store.flush(), console.log(`[obtion] areas: ${marked} documents marked as personal`));
}

/**
 * The areas a device may sync inside a workspace. One: the workspace is the unit of rights now,
 * the area inside it stays the personal one.
 */
const AREAS = new Set([PERSONAL]);

/** Who did something, as the activity names them: "web:Ada", from a device "web:Ada@Mac-x3f9". */
export const actorOf = (user: string, device?: unknown) => `web:${user}${device ? "@" + String(device).slice(0, 40) : ""}`;

export class Workspace {
  store: Store;
  blobs: Blobs;
  conns = new Set<ServerWebSocket<Conn>>();
  private backups: Backups;
  private mirror: Mirror;

  constructor(dir: string) {
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
    if (msg.device) ws.data.origin = actorOf(ws.data.user, msg.device);
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

  /** The workspace's API for a member. `rest` is the path after /w/<id>; `ctx.user` is their first name. */
  async handle(req: Request, rest: string, ctx: { user: string }): Promise<Response> {
    const url = new URL(req.url);
    const store = this.store;

    if (rest === "/api/activity") {
      const before = Number(url.searchParams.get("before") ?? 0) || undefined;
      const doc = url.searchParams.get("doc") ?? undefined;
      return json(store.events({ before, doc, limit: Number(url.searchParams.get("limit") ?? 60) }));
    }

    if (rest === "/api/undo" && req.method === "POST") {
      if (!(req.headers.get("content-type") ?? "").includes("application/json")) return fail(415, "JSON required");
      const b = await body<{ step?: unknown; redo?: boolean; device?: unknown }>(req);
      if (typeof b?.step !== "string") return fail(400, "step required");
      try {
        return json((b.redo ? redoStep : undoStep)(store, b.step, actorOf(ctx.user, b.device)));
      } catch (e) {
        if (e instanceof UndoError) return fail(409, e.message);
        throw e;
      }
    }

    if (rest.startsWith("/api/blobs/")) return this.blob(req, url, rest.slice("/api/blobs/".length));
    return fail(404, "not found");
  }

  mcp(req: Request): Promise<Response> {
    return handleMcp(this.store, req, this.blobs);
  }

  private async blob(req: Request, url: URL, hash: string): Promise<Response> {
    const { blobs, store } = this;
    if (!Blobs.valid(hash)) return fail(400, "bad hash");
    if (req.method === "PUT") {
      const name = url.searchParams.get("name") ?? "";
      if (!UPLOAD_OK(name) && !url.searchParams.has("derived")) return fail(415, "file type not allowed");
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BLOB) return fail(413, "too large");
      const data = new Uint8Array(await req.arrayBuffer());
      if (data.length > MAX_BLOB) return fail(413, "too large");
      return (await blobs.put(hash, data)) ? json({ ok: true }) : fail(422, "hash mismatch");
    }
    // the app asks politely (no error in the console) and shows "Datei fehlt"
    if (!blobs.has(hash)) return req.headers.get("x-obtion-probe") ? new Response(null, { status: 204, headers: { "x-obtion-missing": "1" } }) : fail(404, "not found");
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

function send(ws: ServerWebSocket<Conn>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}
