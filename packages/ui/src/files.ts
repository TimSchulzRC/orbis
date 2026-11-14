// File contents on this device, addressed by SHA-256 (the metadata syncs as documents).
// Previews and display versions are kept on every device so images show offline. Originals are
// either "online" (fetched when opened) or "local" (all kept here). Files added offline wait in an
// upload outbox.

import {
	type FileMeta,
	fileTypeOf,
	type Item,
	initItem,
	mimeOf,
	newId,
	setFileMeta,
} from "@obtion/core/model";
import { toB64 } from "@obtion/core/protocol";
import { type ArchiveFile, archivePaths, type ZipEntry, zipStore } from "@obtion/core/zip";
import type { Repo } from "@obtion/sync";
import { type IDBPDatabase, openDB } from "idb";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { SpaceLink } from "./browser";
import { ScopeContext } from "./scope";
import { KEYS } from "./ui/storage";

type FileMode = "online" | "local";
const MODE_KEY = KEYS.fileMode;

interface Upload {
	hash: string;
	name: string;
	derived?: boolean;
}

interface BlobStore {
	has(hash: string): Promise<boolean>;
	get(hash: string): Promise<Blob | undefined>;
	put(hash: string, blob: Blob): Promise<void>;
	delete(hash: string): Promise<void>;
	list(): Promise<{ hash: string; size: number }[]>;
}

async function opfsStore(name: string): Promise<BlobStore | null> {
	try {
		const root = await navigator.storage?.getDirectory?.();
		if (!root) return null;
		const dir = await root.getDirectoryHandle(name, { create: true });
		const probe = await dir.getFileHandle(".probe", { create: true });
		if (typeof probe.createWritable !== "function") return null;
		return {
			async has(h) {
				try {
					await dir.getFileHandle(h);
					return true;
				} catch {
					return false;
				}
			},
			async get(h) {
				try {
					return await (await dir.getFileHandle(h)).getFile();
				} catch {
					return;
				}
			},
			async put(h, blob) {
				const fh = await dir.getFileHandle(h, { create: true });
				const w = await fh.createWritable();
				await w.write(blob);
				await w.close();
			},
			async delete(h) {
				await dir.removeEntry(h).catch(() => {
					// already gone
				});
			},
			async list() {
				const out: { hash: string; size: number }[] = [];
				for await (const [name, handle] of dir.entries()) {
					if (name.startsWith(".")) continue;
					out.push({ hash: name, size: (await (handle as FileSystemFileHandle).getFile()).size });
				}
				return out;
			},
		};
	} catch {
		return null;
	}
}

function idbStore(db: IDBPDatabase): BlobStore {
	return {
		has: async (h) => (await db.getKey("blobs", h)) !== undefined,
		get: (h) => db.get("blobs", h),
		put: async (h, b) => void (await db.put("blobs", b, h)),
		delete: (h) => db.delete("blobs", h),
		list: async () => {
			const out: { hash: string; size: number }[] = [];
			let c = await db.transaction("blobs").store.openCursor();
			while (c) {
				out.push({ hash: String(c.key), size: (c.value as Blob).size });
				c = await c.continue();
			}
			return out;
		},
	};
}

export async function sha256(blob: Blob): Promise<string> {
	const data = await blob.arrayBuffer();
	// crypto.subtle exists only in secure contexts; over plain http://<address> use a JS fallback
	const buf = crypto.subtle
		? await crypto.subtle.digest("SHA-256", data)
		: (await import("@noble/hashes/sha2.js")).sha256(new Uint8Array(data));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DISPLAY_WIDTH = 1600;
const THUMB_WIDTH = 320;
const PREVIEW_TYPE = "image/webp";
const PREVIEW_QUALITY = 0.8;
const MAX_DOWNLOADS = 3;
/** A file younger than this whose content the server lacks is probably still uploading. */
const UPLOAD_GRACE_MS = 60 * 60_000;
/** Types a blob: URL may carry: they show, never run as part of the app (no HTML, no SVG). */
const VIEWED = /^(application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+)$/;

/** Hands a `blob:` URL to the browser as a file to save, and lets go of it afterwards. */
function saveAs(url: string, name: string) {
	Object.assign(document.createElement("a"), { href: url, download: name }).click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function scaled(
	file: Blob,
	width: number,
): Promise<{ blob: Blob; w: number; h: number } | undefined> {
	try {
		const bmp = await createImageBitmap(file);
		const factor = Math.min(1, width / bmp.width);
		const w = Math.max(1, Math.round(bmp.width * factor));
		const h = Math.max(1, Math.round(bmp.height * factor));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
		const blob = await new Promise<Blob | null>((res) =>
			canvas.toBlob(res, PREVIEW_TYPE, PREVIEW_QUALITY),
		);
		const out = { blob: blob!, w: bmp.width, h: bmp.height };
		bmp.close();
		return blob ? out : undefined;
	} catch {
		return undefined;
	}
}

async function pdfPreview(blob: Blob): Promise<{ blob: Blob; pages: number } | undefined> {
	try {
		const pdfjs = await import("pdfjs-dist");
		const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
		pdfjs.GlobalWorkerOptions.workerSrc = worker;
		// JBIG2/JPEG 2000 decoders, copied to /pdfjs/wasm/ by the build
		const task = pdfjs.getDocument({
			data: new Uint8Array(await blob.arrayBuffer()),
			wasmUrl: "/pdfjs/wasm/",
		});
		const doc = await task.promise;
		const page = await doc.getPage(1);
		const scale = THUMB_WIDTH / page.getViewport({ scale: 1 }).width;
		const viewport = page.getViewport({ scale });
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(viewport.width);
		canvas.height = Math.round(viewport.height);
		await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
		const out = await new Promise<Blob | null>((res) =>
			canvas.toBlob(res, PREVIEW_TYPE, PREVIEW_QUALITY),
		);
		const pages = doc.numPages;
		await task.destroy();
		return out ? { blob: out, pages } : undefined;
	} catch (e) {
		console.warn("pdf preview failed", e);
		return undefined;
	}
}

interface FileStatus {
	mode: FileMode;
	originals: number; // files whose original is on this device
	total: number;
	bytes: number;
	uploading: number;
	downloading: number;
}

export class DeviceFiles {
	mode: FileMode = (localStorage.getItem(MODE_KEY) as FileMode) || "online";
	status: FileStatus = {
		mode: this.mode,
		originals: 0,
		total: 0,
		bytes: 0,
		uploading: 0,
		downloading: 0,
	};
	private db!: IDBPDatabase;
	private store!: BlobStore;
	private ready: Promise<void>;
	private urls = new Map<string, string>();
	private loading = new Map<string, Promise<string | undefined>>();
	private local = new Set<string>();
	private missing = new Set<string>(); // not on the server (yet)
	private fresh = new Set<string>(); // stored this session: may belong to a file not written yet, so collect() spares it
	private collected = false;

	/** Asks the server without downloading. */
	async check(hash: string): Promise<void> {
		if (this.local.has(hash) || this.missing.has(hash)) return;
		const res = await fetch(`${this.link.base}/api/blobs/${hash}?check=1`, {
			headers: { "x-obtion-probe": "1", ...this.auth },
		}).catch(() => null);
		if (res?.headers.get("x-obtion-missing")) {
			this.missing.add(hash);
			this.emit();
		}
	}

	isMissing(hash?: string): boolean {
		return !!hash && this.missing.has(hash) && !this.local.has(hash);
	}
	private queue: string[] = [];
	private active = 0;
	private listeners = new Set<() => void>();
	private version = 0;
	private syncTimer: ReturnType<typeof setTimeout> | null = null;
	private uploading = false;

	constructor(
		private repo: Repo,
		private link: SpaceLink,
	) {
		this.ready = this.open();
	}

	private get auth() {
		return { authorization: `Bearer ${this.link.token}` };
	}

	private async open() {
		this.db = await openDB(this.link.storage.files, 1, {
			blocking: () => {
				this.db.close();
			},
			upgrade(db) {
				db.createObjectStore("blobs");
				db.createObjectStore("uploads", { keyPath: "hash" });
			},
		});
		this.store = (await opfsStore(this.link.storage.blobs)) ?? idbStore(this.db);
		for (const b of await this.store.list()) this.local.add(b.hash);
		this.repo.subscribe(() => this.scheduleSync());
		// contents only purged items used go once the records are gone, also ones stored this session or not uploaded yet
		this.repo.onPurge(async (items) => {
			const used = new Set([...this.repo.records.values()].flatMap(contentsOf));
			for (const h of items.flatMap(contentsOf)) {
				if (used.has(h)) continue;
				this.fresh.delete(h);
				await this.db.delete("uploads", h);
			}
			await this.collect();
		});
		this.repo.onBlob((hash) => {
			if (this.missing.delete(hash)) this.emit();
			this.scheduleSync(50);
		});
		this.scheduleSync(500);
	}

	subscribe = (l: () => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};
	getVersion = () => this.version;
	private emit() {
		this.version++;
		for (const l of this.listeners) l();
	}

	setMode(m: FileMode) {
		this.mode = m;
		localStorage.setItem(MODE_KEY, m);
		// drops queued originals too; the next sync queues the previews again
		if (m === "online") this.queue.length = 0;
		this.scheduleSync(10);
		this.emit();
	}

	url(hash: string, opts: { keep?: boolean } = {}): Promise<string | undefined> {
		const cached = this.urls.get(hash);
		if (cached) return Promise.resolve(cached);
		let loading = this.loading.get(hash);
		if (!loading) {
			loading = this.loadUrl(hash, opts).finally(() => this.loading.delete(hash));
			this.loading.set(hash, loading);
		}
		return loading;
	}

	private async loadUrl(hash: string, opts: { keep?: boolean }): Promise<string | undefined> {
		await this.ready;
		let blob = this.local.has(hash) ? await this.store.get(hash) : undefined;
		if (!blob) {
			blob = await this.fetchVerified(hash);
			if (blob && (opts.keep || this.mode === "local")) {
				await this.save(hash, blob);
				// the mode may have switched to "online" while writing
				if (!opts.keep && this.mode !== "local" && !keptOnline(this.repo).has(hash))
					await this.drop(hash);
			}
		}
		if (!blob) return undefined;
		// stored contents carry no type; images are recognised without one, SVGs are not
		// an SVG as a data: URL: opened on its own (a new tab) it has no origin, while a blob: URL would
		// run its scripts as part of the app
		const svg =
			!blob.type && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(await blob.slice(0, 256).text());
		const url = svg
			? `data:image/svg+xml;base64,${toB64(new Uint8Array(await blob.arrayBuffer()))}`
			: URL.createObjectURL(blob);
		this.urls.set(hash, url);
		return url;
	}

	/** A file's whole text; its facts carry only the start of a long one. Undefined offline. */
	async wholeText(hash: string): Promise<string | undefined> {
		const res = await fetch(`${this.link.base}/api/texts/${hash}`, { headers: this.auth }).catch(
			() => null,
		);
		return res?.ok ? res.text() : undefined;
	}

	/**
	 * The content as a `blob:` URL with its type (the PDF viewer needs one): from this device, else
	 * loaded whole from the server with the token in the header. No URL reaches the server's
	 * contents without a token. The caller revokes it.
	 */
	async viewUrl(hash: string, mime: string): Promise<string | undefined> {
		await this.ready;
		const blob =
			(this.local.has(hash) ? await this.store.get(hash) : undefined) ??
			(await this.fetchVerified(hash));
		return blob
			? URL.createObjectURL(
					new Blob([blob], { type: VIEWED.test(mime) ? mime : "application/octet-stream" }),
				)
			: undefined;
	}

	/** Saves the content under its name, loaded like viewUrl. False when it can't be had (offline). */
	async download(hash: string, name: string, mime: string): Promise<boolean> {
		const url = await this.viewUrl(hash, mime);
		if (!url) return false;
		saveAs(url, name);
		return true;
	}

	/**
	 * Saves several files as one ZIP called `zipName`, a single file as itself. Contents come from
	 * this device or the server, like `download`. Answers how many were saved and the names of
	 * those whose content could not be had; with none saved, nothing is written.
	 */
	async downloadAll(
		files: ArchiveFile[],
		zipName: string,
	): Promise<{ saved: number; missing: string[] }> {
		const metas = files.map((f) => f.item.file!);
		if (files.length === 1) {
			const [f] = metas as [FileMeta];
			const ok = await this.download(f.hash, f.name, f.mime);
			return ok ? { saved: 1, missing: [] } : { saved: 0, missing: [f.name] };
		}
		const paths = archivePaths(files);
		const entries: (ZipEntry | undefined)[] = files.map(() => undefined);
		let next = 0;
		const worker = async () => {
			while (next < files.length) {
				const n = next++;
				const blob = await this.content(metas[n]!.hash);
				if (blob)
					entries[n] = {
						path: paths[n]!,
						data: new Uint8Array(await blob.arrayBuffer()),
						modified: files[n]!.item.updated,
					};
			}
		};
		await Promise.all(Array.from({ length: MAX_DOWNLOADS }, worker));
		const found = entries.filter((e) => !!e);
		const missing = metas.filter((_, n) => !entries[n]).map((f) => f.name);
		if (!found.length) return { saved: 0, missing };
		const zip = new Blob(zipStore(found) as BlobPart[], { type: "application/zip" });
		saveAs(URL.createObjectURL(zip), zipName);
		return { saved: found.length, missing };
	}

	missingKey(created: number): "file.uploading" | "file.missing" {
		return Date.now() - created < UPLOAD_GRACE_MS ? "file.uploading" : "file.missing";
	}

	hasLocal(hash: string) {
		return this.local.has(hash);
	}

	async isLocal(hash: string) {
		await this.ready;
		return this.local.has(hash);
	}

	private async fetchVerified(hash: string): Promise<Blob | undefined> {
		try {
			const res = await fetch(`${this.link.base}/api/blobs/${hash}`, {
				headers: { "x-obtion-probe": "1", ...this.auth },
			});
			if (res.status === 404 || res.headers.get("x-obtion-missing")) {
				this.missing.add(hash);
				this.emit();
				return undefined;
			}
			if (!res.ok) return undefined;
			const blob = await res.blob();
			if ((await sha256(blob)) !== hash) return undefined;
			return blob;
		} catch {
			return undefined;
		}
	}

	/** Writes and deletes of one content, one after the other. */
	private pending = new Map<string, Promise<void>>();
	private inTurn(hash: string, fn: () => Promise<void>): Promise<void> {
		const next = (this.pending.get(hash) ?? Promise.resolve()).then(fn, fn);
		const settled = next.catch(() => {
			// the caller gets the error from `next`; the queue only waits for it
		});
		this.pending.set(hash, settled);
		void settled.then(() => this.pending.get(hash) === settled && this.pending.delete(hash));
		return next;
	}

	/**
	 * Writes a content once: writing the same file again (a download finishing after the device made
	 * it, two loads at once) breaks the object URLs already shown for it (ERR_FILE_NOT_FOUND).
	 */
	private async save(hash: string, blob: Blob) {
		await this.inTurn(hash, async () => {
			if (this.local.has(hash)) return;
			await this.store.put(hash, blob);
			this.local.add(hash);
		});
		this.fresh.add(hash);
	}

	async content(hash: string): Promise<Blob | undefined> {
		await this.ready;
		return (
			(this.local.has(hash) ? await this.store.get(hash) : undefined) ??
			(await this.fetchVerified(hash))
		);
	}

	/** For moves between workspaces: kept here and uploaded like a new file. */
	async adopt(hash: string, blob: Blob, name: string, derived: boolean) {
		await this.ready;
		await this.save(hash, blob);
		await this.enqueueUpload({ hash, name, derived: derived || undefined });
		this.scheduleSync(10);
	}

	async add(
		file: File | Blob,
		name: string,
		opts: { parent?: string } = {},
	): Promise<{ id: string; name: string }> {
		await this.ready;
		const hash = await sha256(file);
		const ix = this.repo.index();
		const same = ix.live.find((r) => r.file?.hash === hash);
		if (same) return { id: same.id, name: same.file!.name };
		// Pasted images are all called "image.png": keep names unique so [[links]] stay unambiguous.
		let unique = name;
		for (let n = 2; ix.live.some((r) => r.file?.name.toLowerCase() === unique.toLowerCase()); n++)
			unique = name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
		const meta = await this.prepare(file, unique, hash);
		const id = newId();
		this.repo.change(id, (doc) => {
			initItem(doc, {
				kind: "file",
				title: unique,
				parents: opts.parent ? [opts.parent] : [],
				createdBy: this.repo.origin,
			});
			setFileMeta(doc, meta);
		});
		this.scheduleSync(10);
		return { id, name: unique };
	}

	async prepare(file: File | Blob, name: string, knownHash?: string): Promise<FileMeta> {
		await this.ready;
		const hash = knownHash ?? (await sha256(file));
		const mime = file.type || mimeOf(name);
		const meta: FileMeta = { hash, name, mime, filetype: fileTypeOf(name, mime), size: file.size };
		await this.save(hash, file);
		await this.enqueueUpload({ hash, name });
		if (meta.filetype === "image" && !/svg/.test(mime)) {
			const display = await scaled(file, DISPLAY_WIDTH);
			const thumb = await scaled(file, THUMB_WIDTH);
			if (display) {
				meta.width = display.w;
				meta.height = display.h;
				meta.display = await this.addDerived(display.blob);
			}
			if (thumb) meta.thumb = await this.addDerived(thumb.blob);
		}
		this.scheduleSync(10);
		return meta;
	}

	/** An image in a drawing: stored and uploaded like a file's content, without a file of its own. */
	async addContent(blob: Blob, name: string): Promise<string> {
		await this.ready;
		const hash = await sha256(blob);
		await this.save(hash, blob);
		await this.enqueueUpload({ hash, name });
		this.scheduleSync(10);
		return hash;
	}

	private async addDerived(blob: Blob): Promise<string> {
		const h = await sha256(blob);
		await this.save(h, blob);
		await this.enqueueUpload({ hash: h, name: "preview.webp", derived: true });
		return h;
	}

	private async enqueueUpload(u: Upload) {
		await this.db.put("uploads", u);
	}

	scheduleSync(ms = 1500) {
		if (this.syncTimer) return;
		this.syncTimer = setTimeout(() => {
			this.syncTimer = null;
			this.sync().catch((e) => console.warn("file sync failed", e));
		}, ms);
	}

	private async sync() {
		await this.ready;
		const files = this.liveFiles();
		if (this.repo.status.online) await this.uploadAll();
		const want: string[] = [];
		for (const f of files) {
			const m = f.file!;
			for (const h of [m.thumb, m.display]) if (h && !this.local.has(h)) want.push(h);
			if (this.mode === "local" && !this.local.has(m.hash)) want.push(m.hash);
		}
		// images in drawings stay on the device like the previews, so drawings show offline
		for (const r of this.repo.live())
			for (const h of r.drawing?.files ?? []) if (!this.local.has(h)) want.push(h);
		if (this.repo.status.online)
			for (const h of want) if (!this.queue.includes(h) && !this.missing.has(h)) this.queue.push(h);
		this.pump();
		if (this.repo.status.online)
			this.makePdfPreviews(files).catch(() => {
				// previews are retried on the next sync
			});
		if (this.repo.status.synced && !this.collected) {
			this.collected = true;
			await this.collect();
		}
		this.updateStatus(files);
	}

	private liveFiles(): Item[] {
		return this.repo.live().filter((r) => r.kind === "file" && r.file?.hash);
	}

	private async pendingUploads(): Promise<Set<string>> {
		return new Set(((await this.db.getAll("uploads")) as Upload[]).map((u) => u.hash));
	}

	/**
	 * Once per session, after catching up with the server, so records from other devices are known
	 * before anything is deleted. Spares pending uploads and contents stored this session.
	 */
	private async collect() {
		const keep = new Set([...this.repo.records.values()].flatMap(contentsOf));
		const pending = await this.pendingUploads();
		for (const h of [...this.local])
			if (!keep.has(h) && !pending.has(h) && !this.fresh.has(h)) await this.drop(h);
	}

	private updateStatus(files: Item[]) {
		let originals = 0;
		let bytes = 0;
		for (const f of files) {
			if (!this.local.has(f.file!.hash)) continue;
			originals++;
			bytes += f.file!.size;
		}
		this.status = {
			mode: this.mode,
			originals,
			total: files.length,
			bytes,
			uploading: this.status.uploading,
			downloading: this.queue.length + this.active,
		};
		this.emit();
	}

	private pump() {
		while (this.active < MAX_DOWNLOADS && this.queue.length) {
			const h = this.queue.shift()!;
			this.active++;
			this.fetchVerified(h)
				.then(async (blob) => {
					// the mode may switch to "online" during the fetch or the write
					const wanted = () => this.mode === "local" || keptOnline(this.repo).has(h);
					if (blob && wanted()) await this.save(h, blob);
					// made on this device meanwhile (a new file whose record comes after its contents): kept,
					// like collect() keeps it; dropping it would break the picture already shown
					if (this.local.has(h) && !wanted() && !this.fresh.has(h)) await this.drop(h);
				})
				.finally(() => {
					this.active--;
					// per download, so the progress in the settings moves along
					this.updateStatus(this.liveFiles());
					this.pump();
				});
		}
	}

	private async uploadAll() {
		if (this.uploading) return;
		this.uploading = true;
		try {
			const items = (await this.db.getAll("uploads")) as Upload[];
			this.status.uploading = items.length;
			for (const u of items) {
				const blob = await this.store.get(u.hash);
				if (!blob) {
					await this.db.delete("uploads", u.hash);
					continue;
				}
				const q = new URLSearchParams({ name: u.name });
				if (u.derived) q.set("derived", "1");
				const res = await fetch(`${this.link.base}/api/blobs/${u.hash}?${q}`, {
					method: "PUT",
					body: blob,
					headers: this.auth,
				}).catch(() => null);
				if (!res) break; // offline again
				const rejectedForGood =
					res.status === 400 || res.status === 413 || res.status === 415 || res.status === 422;
				if (res.ok || rejectedForGood) {
					await this.db.delete("uploads", u.hash);
					this.status.uploading--;
					// SVGs have no display version, so their original must stay
					if (res.ok && !u.derived && this.mode === "online" && !shownItself(this.repo).has(u.hash))
						await this.drop(u.hash);
				}
			}
		} finally {
			this.uploading = false;
		}
	}

	private pdfDone = new Set<string>();
	private async makePdfPreviews(files: Item[]) {
		for (const f of files) {
			const m = f.file!;
			if (m.filetype !== "pdf" || m.thumb || this.pdfDone.has(f.id)) continue;
			this.pdfDone.add(f.id);
			const url = await this.url(m.hash);
			if (!url) continue;
			const prev = await pdfPreview(await (await fetch(url)).blob());
			if (!prev) continue;
			// Upload before referencing it, so other devices never point at a preview that never arrives.
			const thumb = await sha256(prev.blob);
			await this.save(thumb, prev.blob);
			const res = await fetch(`${this.link.base}/api/blobs/${thumb}?name=preview.webp&derived=1`, {
				method: "PUT",
				body: prev.blob,
				headers: this.auth,
			}).catch(() => null);
			if (!res?.ok) {
				this.pdfDone.delete(f.id); // try again next time
				continue;
			}
			this.repo.change(f.id, (doc) => setFileMeta(doc, { thumb, pages: m.pages ?? prev.pages }));
		}
	}

	async dropOriginals() {
		const keep = keptOnline(this.repo);
		const pending = await this.pendingUploads();
		for (const h of [...this.local]) {
			if (keep.has(h) || pending.has(h)) continue;
			await this.drop(h);
		}
		this.scheduleSync(10);
	}

	/** Also forgets the object URL, which stops working once the content is gone. */
	private async drop(hash: string) {
		await this.inTurn(hash, async () => {
			await this.store.delete(hash);
			this.local.delete(hash);
			this.urls.delete(hash);
		});
	}
}

/** The contents an item points to on a device: a file's original and previews, a drawing's images. */
function contentsOf(r: Item): string[] {
	return [r.file?.hash, r.file?.display, r.file?.thumb, ...(r.drawing?.files ?? [])].filter(
		(h): h is string => !!h,
	);
}

function keptOnline(repo: Repo): Set<string> {
	const keep = shownItself(repo);
	for (const r of repo.live())
		if (r.file) for (const h of [r.file.thumb, r.file.display]) if (h) keep.add(h);
	return keep;
}

/** Images without a display version (SVGs) show their original, and so do images in drawings. */
function shownItself(repo: Repo): Set<string> {
	return new Set(
		repo
			.live()
			.flatMap((r) =>
				r.file?.filetype === "image" && !r.file.display ? [r.file.hash] : (r.drawing?.files ?? []),
			),
	);
}

export let files: DeviceFiles;
export function setFiles(f: DeviceFiles) {
	files = f;
}

export function useBlobUrl(hash?: string, keep = false): string | undefined {
	const f = useContext(ScopeContext)?.files ?? files;
	const [url, setUrl] = useState<string | undefined>();
	useSyncExternalStore(f.subscribe, f.getVersion);
	// a content saved on this device meanwhile gets a local URL
	const local = f.hasLocal(hash ?? "");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `local` is the trigger to load the URL again
	useEffect(() => {
		let alive = true;
		setUrl(undefined);
		if (hash) f.url(hash, { keep }).then((u) => alive && setUrl(u));
		return () => {
			alive = false;
		};
	}, [f, hash, keep, local]);
	return url;
}
