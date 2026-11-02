// Everything below a Workspace sees only its own folder, so workspaces cannot reach each other's data.
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { AreaError, Store } from "./store";
import { Mirror } from "./mirror";
import { handleMcp } from "./mcp";
import { type Person, personOrigin } from "@obtion/core/origin";
import type { EventText, HistoryList, VersionText } from "@obtion/core/api";
import { Blobs } from "./blobs";
import { MAX_BLOB } from "./config";
import { body, fail, json } from "./http";
import { Backups } from "./backup";
import { FORMAT, type Item, PERSONAL, fileTypeOf } from "@obtion/core/model";
import { addLaterDefaultProps, migrateCollections, renameShippedLabels, upgradeAreas, upgradeExplicitRoles, upgradeHideEmptyTaskFields } from "@obtion/core/setup";
import { SETUP_ORIGIN, storeWriter } from "./importers";
import { UndoError, undoStep } from "./undo";
import { type ClientMsg, type ServerMsg, type WireUpdate, fromB64, toB64 } from "@obtion/core/protocol";
import { z } from "zod";

export interface Conn {
  userId: string;
  session?: string; // a password change closes connections of the other sessions
  workspace: string;
  areas: Set<string>; // only areas it said hello for are sent and accepted
  origin: string;
  user: Person;
}

// only kinds the app can show: no HTML, scripts or executables
const uploadAllowed = (name: string) => fileTypeOf(name) !== "sonstiges" || /\.(zip|json|xml|ics|vcf)$/i.test(name);
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)|application\/pdf|audio\/|video\/|text\/plain)/;

async function sniffImage(path: string): Promise<string> {
  const head = new Uint8Array(await Bun.file(path).slice(0, 12).arrayBuffer());
  if (head[0] === 0x89 && head[1] === 0x50) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (String.fromCharCode(...head.slice(8, 12)) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function upgradeOldData(store: Store) {
  // properties shipped after a default type was set up: added once, nothing migrated
  const lang = store.setupLang();
  const writer = storeWriter(store, SETUP_ORIGIN);
  if (lang && addLaterDefaultProps(writer, lang).length) store.flush();
  if (lang && renameShippedLabels(writer, lang)) store.flush();
  if (upgradeHideEmptyTaskFields(writer)) store.flush();
  // 31.10.: roles once recognised by name ("Wartet auf", "Pausiert") become explicit in the types
  if (upgradeExplicitRoles(writer, store.index()).length) store.flush();
  // 26.10.: collections removed; their views move to the types, the inbox rule to the settings
  const moved = lang ? migrateCollections(writer, store.index(), store.eachDoc(), lang) : [];
  if (moved.length) {
    store.flush();
    console.log(`[obtion] collections migrated:\n  ${moved.join("\n  ")}`);
  }
  // 27.10.: documents from before areas belong to the personal area
  const marked = upgradeAreas(writer, store.eachDoc());
  if (marked) {
    store.flush();
    console.log(`[obtion] areas: ${marked} documents marked as personal`);
  }
}

// The workspace is the unit of rights now; inside it only the personal area syncs.
const AREAS = new Set([PERSONAL]);
/** Documents per message of a first sync. */
const SYNC_BATCH = 150;
const BLOBS = "/api/blobs/";

const clientMsg: z.ZodType<ClientMsg> = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), area: z.string(), since: z.number(), sinceId: z.string().optional(), device: z.string().optional() }),
  z.object({ t: z.literal("push"), area: z.string(), items: z.array(z.object({ k: z.string(), d: z.string(), u: z.string(), s: z.string().optional() })) }),
  z.object({ t: z.literal("ping") }),
]);

export function parseClientMsg(raw: string): ClientMsg | null {
  try {
    const parsed = clientMsg.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class Workspace {
  store: Store;
  blobs: Blobs;
  conns = new Set<ServerWebSocket<Conn>>();
  private backups: Backups;
  private mirror: Mirror;

  constructor(dir: string) {
    this.store = new Store(dir);
    upgradeOldData(this.store);
    this.blobs = new Blobs(join(dir, "blobs"), this.store);
    this.mirror = new Mirror(this.store, join(dir, "vault"), this.blobs);
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
    this.mirror.start();
    this.backups = new Backups(this.store, join(dir, "backups"));
    this.backups.start();
  }

  close() {
    this.backups.stop();
    this.mirror.stop();
    this.store.flush();
  }

  /** For a deleted workspace: nothing may write into its folder afterwards. */
  shut() {
    for (const ws of this.conns) ws.close(4404, "workspace deleted");
    this.close();
    this.blobs.stop();
    this.store.db.close();
  }

  hello(ws: ServerWebSocket<Conn>, msg: Extract<ClientMsg, { t: "hello" }>) {
    const area = msg.area;
    if (!AREAS.has(area)) return send(ws, { t: "denied", area });
    if (msg.device) ws.data.origin = personOrigin(ws.data.user, msg.device);
    const store = this.store;
    const last = store.last(area);
    send(ws, { t: "welcome", hub: store.serverId, area, seq: last.seq, format: FORMAT });
    const reset = !store.knowsCursor(area, msg.since, msg.sinceId); // server restored from an older backup; replica must merge everything
    const ids = store.docsSince(area, reset ? 0 : msg.since);
    if (ids.length === 0) send(ws, { t: "updates", area, items: [], last: last.seq, lastId: last.uid || undefined, initial: true, done: true, reset });
    for (let i = 0; i < ids.length; i += SYNC_BATCH) {
      const items = ids.slice(i, i + SYNC_BATCH).map((d) => ({ d, u: toB64(store.stateOf(d)) }));
      const done = i + SYNC_BATCH >= ids.length;
      // Only the final batch carries the real position, so an interrupted first sync is retried.
      send(ws, { t: "updates", area, items, last: done ? last.seq : 0, lastId: done ? last.uid || undefined : undefined, initial: true, done, reset: reset && i === 0 });
    }
    ws.data.areas.add(area);
  }

  message(ws: ServerWebSocket<Conn>, msg: ClientMsg) {
    if (msg.t === "hello") this.hello(ws, msg);
    else if (msg.t === "ping") send(ws, { t: "pong" });
    else if (msg.t === "push") {
      // before the welcome the client has not checked the server id. No ack, so its outbox
      // resends after the next hello.
      const area = msg.area;
      if (!ws.data.areas.has(area)) return;
      const keys: string[] = [];
      for (const it of msg.items) {
        try {
          const step = it.s && /^[\w-]{1,40}$/.test(it.s) ? it.s : undefined;
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

  /** `rest` is the path after /w/<id>. */
  async handle(req: Request, rest: string, ctx: { user: Person }): Promise<Response> {
    const url = new URL(req.url);
    const store = this.store;

    if (rest === "/api/activity") {
      const before = Number(url.searchParams.get("before") ?? 0) || undefined;
      const doc = url.searchParams.get("doc") ?? undefined;
      return json(store.events({ before, doc, limit: Number(url.searchParams.get("limit") ?? 60) }));
    }

    // the kept versions of an item's text: the list (doc), one text (version), what an activity entry changed (event)
    if (rest === "/api/history") {
      store.flush();
      const q = url.searchParams;
      if (q.has("event")) {
        const t = store.eventText(Number(q.get("event")));
        return t ? json<EventText>(t) : fail(404, "no versions for this entry");
      }
      if (q.has("version")) {
        const text = store.versionText(Number(q.get("version")), q.get("doc") ?? undefined);
        return text === undefined ? fail(404, "unknown version") : json<VersionText>({ text });
      }
      const doc = q.get("doc");
      if (!doc) return fail(400, "doc, version or event required");
      return json<HistoryList>({ versions: store.versions(doc) });
    }

    if (rest === "/api/undo" && req.method === "POST") {
      if (!(req.headers.get("content-type") ?? "").includes("application/json")) return fail(415, "JSON required");
      const b = await body<{ step?: unknown; device?: unknown }>(req);
      if (typeof b?.step !== "string") return fail(400, "step required");
      try {
        return json(undoStep(store, b.step, personOrigin(ctx.user, typeof b.device === "string" ? b.device : undefined)));
      } catch (e) {
        if (e instanceof UndoError) return fail(409, e.message);
        throw e;
      }
    }

    if (rest.startsWith(BLOBS)) return this.blob(req, url, rest.slice(BLOBS.length));
    return fail(404, "not found");
  }

  /** No person for the pre-accounts /mcp address. */
  mcp(req: Request, person?: Person): Promise<Response> {
    return handleMcp(this.store, req, this.blobs, person);
  }

  private async blob(req: Request, url: URL, hash: string): Promise<Response> {
    const { blobs, store } = this;
    if (!Blobs.valid(hash)) return fail(400, "bad hash");
    if (req.method === "PUT") {
      const name = url.searchParams.get("name") ?? "";
      if (!uploadAllowed(name) && !url.searchParams.has("derived")) return fail(415, "file type not allowed");
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BLOB) return fail(413, "too large");
      const data = new Uint8Array(await req.arrayBuffer());
      if (data.length > MAX_BLOB) return fail(413, "too large");
      return (await blobs.put(hash, data)) ? json({ ok: true }) : fail(422, "hash mismatch");
    }
    // the probe header lets the app check without a console error
    if (!blobs.has(hash)) {
      if (req.headers.get("x-obtion-probe")) return new Response(null, { status: 204, headers: { "x-obtion-missing": "1" } });
      return fail(404, "not found");
    }
    if (url.searchParams.has("check")) return new Response(null, { status: 204 });
    const hasThisFile = (r: Item) => r.file?.hash === hash;
    const record = store.live().find(hasThisFile) ?? [...store.records.values()].find(hasThisFile);
    const mime = record?.file?.mime ?? (await sniffImage(blobs.path(hash))); // derived versions have no record
    const headers: Record<string, string> = {
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      // never let a file run as part of the app (SVG, HTML-like content)
      "content-security-policy": mime === "application/pdf" ? "script-src 'none'" : "sandbox",
      "content-type": INLINE.test(mime) ? mime : "application/octet-stream",
    };
    const fname = (url.searchParams.get("name") ?? record?.file?.name ?? hash).replace(/["\\\r\n]/g, "");
    if (url.searchParams.has("download") || !INLINE.test(mime)) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`;
    return new Response(Bun.file(blobs.path(hash)), { headers });
  }
}

function send(ws: ServerWebSocket<Conn>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}
