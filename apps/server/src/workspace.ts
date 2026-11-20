// Everything below a Workspace sees only its own folder, so workspaces cannot reach each other's data.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventText, PurgeResult } from "@orbis/core/api";
import { FORMAT, type Item, PERSONAL } from "@orbis/core/model";
import { type Person, personOrigin } from "@orbis/core/origin";
import {
	type ClientMsg,
	fromB64,
	type ServerMsg,
	toB64,
	type WireUpdate,
} from "@orbis/core/protocol";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { Blobs } from "./blobs";
import { MAX_BLOB } from "./config";
import { body, fail, json } from "./http";
import { handleMcp } from "./mcp";
import { Mirror } from "./mirror";
import { fileName, OpError, Ops } from "./ops";
import { AreaError, Store } from "./store";
import { UndoError, undoStep } from "./undo";

export interface Conn {
	userId: string;
	session?: string; // a password change closes connections of the other sessions
	workspace: string;
	areas: Set<string>; // only areas it said hello for are sent and accepted
	origin: string;
	user: Person;
}

// Every file type may be uploaded. Only these types are shown inline (nosniff, sandboxed);
// everything else is served as application/octet-stream with "attachment".
const INLINE =
	/^(image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain)\s*(;.*)?$/i;
/** The type a content is served as: one of INLINE, else application/octet-stream. */
const servedType = (mime: string) =>
	INLINE.exec(mime)?.[1]?.toLowerCase() ?? "application/octet-stream";

/** Headers for an original or a derived version; `download`: always as a file to save. */
function fileHeaders(mime: string, name: string, download: boolean): Record<string, string> {
	const type = servedType(mime);
	const headers: Record<string, string> = {
		"x-content-type-options": "nosniff",
		// a link inside the file gets no address of this server
		"referrer-policy": "no-referrer",
		// never let a file run as part of the app (SVG, HTML-like content)
		"content-security-policy": type === "application/pdf" ? "script-src 'none'" : "sandbox",
		"content-type": type,
	};
	if (download || type === "application/octet-stream")
		headers["content-disposition"] = contentDisposition(name);
	return headers;
}

/** attachment with the file's name: plain ASCII for old clients, UTF-8 for the rest. */
function contentDisposition(name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters (and quotes) is what this regex is for
	const clean = name.replace(/[\u0000-\u001f\u007f"\\]/g, "") || "file";
	const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

async function sniffImage(path: string): Promise<string> {
	const head = new Uint8Array(await Bun.file(path).slice(0, 12).arrayBuffer());
	if (head[0] === 0x89 && head[1] === 0x50) return "image/png";
	if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
	if (String.fromCharCode(...head.slice(8, 12)) === "WEBP") return "image/webp";
	return "application/octet-stream";
}

// The workspace is the unit of rights now; inside it only the personal area syncs.
const AREAS = new Set([PERSONAL]);
/** Documents per message of a first sync. */
const SYNC_BATCH = 150;
const BLOBS = "/api/blobs/";
const TEXTS = "/api/texts/";

const clientMsg: z.ZodType<ClientMsg> = z.discriminatedUnion("t", [
	z.object({
		t: z.literal("hello"),
		area: z.string(),
		since: z.number(),
		sinceId: z.string().optional(),
		device: z.string().optional(),
	}),
	z.object({
		t: z.literal("push"),
		area: z.string(),
		items: z.array(
			z.object({ k: z.string(), d: z.string(), u: z.string(), s: z.string().optional() }),
		),
	}),
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
	private mirror: Mirror;

	constructor(dir: string) {
		this.store = new Store(dir);
		this.blobs = new Blobs(join(dir, "blobs"), this.store);
		this.store.fileText = (f) => this.blobs.text(f);
		this.store.reindexFiles();
		this.mirror = new Mirror(this.store, join(dir, "vault"), this.blobs);
		this.store.on({
			update: (u, from) => {
				const item: WireUpdate = { s: u.seq, d: u.doc, u: toB64(u.data), o: u.origin };
				for (const ws of this.conns)
					if (ws.data.areas.has(u.area) && ws !== from)
						send(ws, { t: "updates", area: u.area, items: [item], last: u.seq, lastId: u.uid });
			},
			event: (event) => {
				if (event.step) Object.assign(event, this.store.stepState(event.step));
				const area = this.store.areaOf(event.doc) ?? PERSONAL;
				for (const ws of this.conns) if (ws.data.areas.has(area)) send(ws, { t: "event", event });
			},
			record: (r) => {
				if (r.file && this.blobs.needsWork(r)) this.blobs.schedule(r.id);
			},
			purge: (ids, area) => {
				for (const ws of this.conns)
					if (ws.data.areas.has(area)) send(ws, { t: "purged", area, ids });
			},
		});
		this.blobs.onStored = (hash) => {
			for (const ws of this.conns) if (ws.data.areas.size) send(ws, { t: "blob", hash });
		};
		this.blobs.scan();
		this.mirror.start();
	}

	close() {
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
		send(ws, { t: "welcome", server: store.serverId, area, seq: last.seq, format: FORMAT });
		const reset = !store.knowsCursor(area, msg.since, msg.sinceId); // server restored from an older backup; replica must merge everything
		const purged = store.purgedSince(area, reset ? 0 : msg.since);
		if (purged.length) send(ws, { t: "purged", area, ids: purged });
		const ids = store.docsSince(area, reset ? 0 : msg.since);
		if (ids.length === 0)
			send(ws, {
				t: "updates",
				area,
				items: [],
				last: last.seq,
				lastId: last.uid || undefined,
				initial: true,
				done: true,
				reset,
			});
		for (let i = 0; i < ids.length; i += SYNC_BATCH) {
			const items = ids.slice(i, i + SYNC_BATCH).map((d) => ({ d, u: toB64(store.stateOf(d)) }));
			const done = i + SYNC_BATCH >= ids.length;
			// Only the final batch carries the real position, so an interrupted first sync is retried.
			send(ws, {
				t: "updates",
				area,
				items,
				last: done ? last.seq : 0,
				lastId: done ? last.uid || undefined : undefined,
				initial: true,
				done,
				reset: reset && i === 0,
			});
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
	async handle(
		req: Request,
		rest: string,
		ctx: { user: Person; origin?: string; filesUrl?: string },
	): Promise<Response> {
		const url = new URL(req.url);
		const store = this.store;

		if (rest === "/api/activity") {
			const before = Number(url.searchParams.get("before") ?? 0) || undefined;
			const doc = url.searchParams.get("doc") ?? undefined;
			return json(
				store.events({ before, doc, limit: Number(url.searchParams.get("limit") ?? 60) }),
			);
		}

		// what an activity entry did to an item's text, from the kept versions
		if (rest === "/api/history") {
			store.flush();
			const t = store.eventText(Number(url.searchParams.get("event")));
			return t ? json<EventText>(t) : fail(404, "no versions for this entry");
		}

		if (rest === "/api/undo" && req.method === "POST") {
			if (!(req.headers.get("content-type") ?? "").includes("application/json"))
				return fail(415, "JSON required");
			const b = await body<{ step?: unknown; device?: unknown }>(req);
			if (typeof b?.step !== "string") return fail(400, "step required");
			try {
				return json(
					undoStep(
						store,
						b.step,
						personOrigin(ctx.user, typeof b.device === "string" ? b.device : undefined),
					),
				);
			} catch (e) {
				if (e instanceof UndoError) return fail(409, e.message);
				throw e;
			}
		}

		if (rest === "/api/purge" && req.method === "POST") {
			const b = await body<{ id?: unknown; all?: unknown }>(req);
			if (typeof b?.id !== "string" && b?.all !== true)
				return fail(400, "id or all: true required");
			try {
				return json<PurgeResult>({
					purged: new Ops(store, this.blobs).purge(typeof b.id === "string" ? b.id : undefined),
				});
			} catch (e) {
				if (e instanceof OpError) return fail(404, e.message);
				throw e;
			}
		}

		if (rest.startsWith(BLOBS)) return this.blob(req, url, rest.slice(BLOBS.length));
		// a file's whole text, when its facts carry only the start (the app shows it on the file's page)
		if (rest.startsWith(TEXTS) && req.method === "GET") {
			const hash = rest.slice(TEXTS.length);
			if (!Blobs.valid(hash) || !existsSync(this.blobs.textPath(hash)))
				return fail(404, "no text kept for this content");
			return new Response(Bun.file(this.blobs.textPath(hash)), {
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"x-content-type-options": "nosniff",
					"content-security-policy": "sandbox",
					"cache-control": "private, max-age=31536000, immutable",
				},
			});
		}
		if (rest === "/api/files" || rest.startsWith("/api/files/"))
			return this.files(req, url, rest.slice("/api/files".length), {
				origin:
					ctx.origin ?? personOrigin(ctx.user, req.headers.get("x-orbis-device") ?? undefined),
				filesUrl: ctx.filesUrl,
			});
		return fail(404, "not found");
	}

	/** `filesUrl`: the file API, named to agents. */
	mcp(req: Request, person: Person, filesUrl?: string): Promise<Response> {
		return handleMcp(this.store, req, this.blobs, person, filesUrl);
	}

	/**
	 * The file API for scripts and agents (members, by app session or MCP token):
	 *   POST /api/files?name=<name>[&parent=<id or title>]   body: the content → 201 { id, name, hash, size, mime, url, step }
	 *   PUT  /api/files/<item id>                           body: the new content (same item, old one kept in its history)
	 *   GET  /api/files/<item id>                           the original, as a download with its name
	 * Uploads and replacements are one step each (activity, undo), written as `origin`.
	 */
	private async files(
		req: Request,
		url: URL,
		sub: string,
		ctx: { origin: string; filesUrl?: string },
	): Promise<Response> {
		const ops = new Ops(this.store, this.blobs, ctx.filesUrl);
		const id = sub.replace(/^\//, "");
		if (id && !/^[\w-]{1,64}$/.test(id)) return fail(404, "not found");
		const item = id ? this.store.records.get(id) : undefined;
		if (id && (item?.kind !== "file" || !item.file)) return fail(404, "no such file");

		if (req.method === "GET" || req.method === "HEAD") {
			if (!item) return fail(405, "POST a file, or GET /api/files/<file id>");
			const f = item.file!;
			if (!this.blobs.has(f.hash)) return fail(404, "content not on the server (yet)");
			return new Response(req.method === "HEAD" ? null : Bun.file(this.blobs.path(f.hash)), {
				headers: {
					...fileHeaders(f.mime, f.name, true),
					"cache-control": "private, no-cache",
					etag: `"${f.hash}"`,
					"x-orbis-hash": f.hash,
					...(req.method === "HEAD" ? { "content-length": String(f.size) } : {}),
				},
			});
		}
		if (
			(req.method === "POST" && id) ||
			(req.method === "PUT" && !id) ||
			(req.method !== "POST" && req.method !== "PUT")
		)
			return fail(405, "POST /api/files?name=… or PUT /api/files/<file id>");
		if (Number(req.headers.get("content-length") ?? 0) > MAX_BLOB)
			return fail(413, `too large (max ${MAX_BLOB / 1024 / 1024} MB)`);
		// check what can be checked before the content is read
		const name = url.searchParams.get("name") ?? "";
		const parent = url.searchParams.get("parent") ?? undefined;
		try {
			if (!id) {
				fileName(name);
				if (parent) ops.resolve(parent);
			} else if (item!.deleted)
				throw new OpError(`"${item!.title}" is in the trash. Restore it first.`);
		} catch (e) {
			if (e instanceof OpError) return fail(id ? 409 : 400, e.message);
			throw e;
		}
		const got = await this.blobs.putStream(req.body, MAX_BLOB);
		if (typeof got === "string") return fail(413, `too large (max ${MAX_BLOB / 1024 / 1024} MB)`);
		let out: Item | undefined;
		let previous: string | undefined;
		try {
			const said = ops.call(ctx.origin, () => {
				if (id) {
					const r = ops.replaceFile(id, got, ctx.origin);
					out = r.item;
					previous = r.previous;
					return previous ? "replaced" : "same content";
				}
				out = ops.addFile({ name, hash: got.hash, size: got.size, parent }, ctx.origin);
				return "created";
			});
			const f = out!.file!;
			const step = /\(step (s\w+)/.exec(said)?.[1];
			const body = {
				id: out!.id,
				name: f.name,
				hash: f.hash,
				size: f.size,
				mime: f.mime,
				url: ctx.filesUrl ? `${ctx.filesUrl}/${out!.id}` : `/api/files/${out!.id}`,
				step,
				...(id ? { replaced: !!previous, previous } : {}),
			};
			return json(body, id ? 200 : 201);
		} catch (e) {
			if (e instanceof OpError) return fail(id ? 409 : 400, e.message);
			throw e;
		}
	}

	private async blob(req: Request, url: URL, hash: string): Promise<Response> {
		const { blobs, store } = this;
		if (!Blobs.valid(hash)) return fail(400, "bad hash");
		if (req.method === "PUT") {
			if (Number(req.headers.get("content-length") ?? 0) > MAX_BLOB) return fail(413, "too large");
			const got = await blobs.putStream(req.body, MAX_BLOB, hash);
			if (got === "too large") return fail(413, "too large");
			return got === "hash mismatch" ? fail(400, "hash mismatch") : json({ ok: true });
		}
		// the probe header lets the app check without a console error
		if (!blobs.has(hash)) {
			if (req.headers.get("x-orbis-probe"))
				return new Response(null, { status: 204, headers: { "x-orbis-missing": "1" } });
			return fail(404, "not found");
		}
		if (url.searchParams.has("check")) return new Response(null, { status: 204 });
		const record =
			store.live().find((r) => r.file?.hash === hash) ??
			[...store.records.values()].find((r) => r.file?.hash === hash);
		const mime = record?.file?.mime ?? (await sniffImage(blobs.path(hash))); // derived versions have no record
		const headers = {
			"cache-control": "private, max-age=31536000, immutable",
			...fileHeaders(
				mime,
				url.searchParams.get("name") ?? record?.file?.name ?? hash,
				url.searchParams.has("download"),
			),
		};
		return new Response(Bun.file(blobs.path(hash)), { headers });
	}
}

function send(ws: ServerWebSocket<Conn>, msg: ServerMsg) {
	ws.send(JSON.stringify(msg));
}
