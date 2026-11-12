// Device file storage against a server faked in fetch, with the browser's real storage.

import { initItem, newId, setFileMeta } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { afterEach, expect, test, vi } from "vitest";
import type { SpaceLink } from "../../packages/ui/src/browser";
import { DeviceFiles, sha256 } from "../../packages/ui/src/files";
import { workspace } from "./workspace";

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.removeItem("obtion.fileMode");
});

/** The server's contents; a download whose hash is in `held` waits until it is released. */
function server() {
	const blobs = new Map<string, Blob>();
	const held = new Map<string, () => void>();
	const gates = new Map<string, Promise<void>>();
	const asked: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const hash = url.pathname.split("/").pop()!;
		if (init?.method === "PUT") return Response.json({ ok: true });
		if (url.searchParams.has("check")) return new Response(null, { status: 204 });
		asked.push(hash);
		await gates.get(hash);
		const blob = blobs.get(hash);
		return blob
			? new Response(blob)
			: new Response(null, { status: 204, headers: { "x-obtion-missing": "1" } });
	});
	return {
		asked,
		async add(text: string) {
			const blob = new Blob([text]);
			const hash = await sha256(blob);
			blobs.set(hash, blob);
			return { hash, size: blob.size };
		},
		hold(hash: string) {
			gates.set(hash, new Promise((r) => held.set(hash, r)));
		},
		release(hash: string) {
			held.get(hash)?.();
			gates.delete(hash);
		},
	};
}

let n = 0;
/** Device files of `repo`, as if online and caught up with the server; `name` reuses a store. */
function deviceFiles(repo: Repo, name = `t${++n}-${Date.now()}`) {
	repo.status.online = true;
	repo.status.synced = true;
	const link = {
		base: "http://server.test",
		token: "t",
		person: { id: "u-test", name: "Test" },
		storage: { files: `files-${name}`, blobs: `blobs-${name}` },
	} as unknown as SpaceLink;
	return { files: new DeviceFiles(repo, link), name };
}

function addFile(repo: Repo, name: string, f: { hash: string; size: number }) {
	const id = newId();
	repo.change(id, (doc) => {
		initItem(doc, { kind: "file", title: name, parents: [], createdBy: repo.origin });
		setFileMeta(doc, {
			hash: f.hash,
			name,
			mime: "application/pdf",
			filetype: "pdf",
			size: f.size,
			pages: 1,
		});
	});
	return id;
}

test("everything local: every original comes, the count moves with each download", async () => {
	const srv = server();
	const repo = await workspace(false);
	const a = await srv.add("first");
	const b = await srv.add("second");
	addFile(repo, "a.pdf", a);
	addFile(repo, "b.pdf", b);
	srv.hold(b.hash);
	localStorage.setItem("obtion.fileMode", "local");
	const { files } = deviceFiles(repo);
	await expect.poll(() => files.status.originals, { timeout: 5000 }).toBe(1);
	expect(files.status.downloading).toBe(1);
	srv.release(b.hash);
	await expect.poll(() => files.status.originals, { timeout: 5000 }).toBe(2);
	expect(files.status.downloading).toBe(0);
	expect(files.hasLocal(a.hash) && files.hasLocal(b.hash)).toBe(true);
});

test("switching to online only while downloading: the original arriving then is not kept", async () => {
	const srv = server();
	const repo = await workspace(false);
	const a = await srv.add("big original");
	addFile(repo, "a.pdf", a);
	srv.hold(a.hash);
	const { files } = deviceFiles(repo);
	files.setMode("local");
	await expect.poll(() => srv.asked.includes(a.hash), { timeout: 5000 }).toBe(true);
	files.setMode("online");
	await files.dropOriginals();
	srv.release(a.hash);
	await expect.poll(() => files.status.downloading, { timeout: 5000 }).toBe(0);
	await new Promise((r) => setTimeout(r, 100));
	expect(files.hasLocal(a.hash)).toBe(false);
	expect(files.status.originals).toBe(0);
});

test("a replaced original is removed from this device in the next session", async () => {
	const srv = server();
	const repo = await workspace(false);
	const old = await srv.add("version 1");
	const next = await srv.add("version 2");
	const id = addFile(repo, "a.pdf", old);
	localStorage.setItem("obtion.fileMode", "local");
	const first = deviceFiles(repo);
	await expect.poll(() => first.files.hasLocal(old.hash), { timeout: 5000 }).toBe(true);
	repo.change(id, (doc) =>
		setFileMeta(doc, {
			hash: next.hash,
			size: next.size,
			history: [{ hash: old.hash, at: Date.now() }],
		}),
	);
	await expect.poll(() => first.files.hasLocal(next.hash), { timeout: 5000 }).toBe(true);
	// the same storage again, as after a reload
	const second = deviceFiles(repo, first.name).files;
	await expect.poll(() => second.hasLocal(next.hash), { timeout: 5000 }).toBe(true);
	await expect.poll(() => second.hasLocal(old.hash), { timeout: 5000 }).toBe(false);
	expect(second.status.originals).toBe(1);
});

test("a content stored in this session and not yet in a file stays", async () => {
	server();
	const repo = await workspace(false);
	localStorage.setItem("obtion.fileMode", "local");
	const { files } = deviceFiles(repo);
	// stored, uploaded, but its document is not written yet (as a PDF preview is)
	await files.adopt("0".repeat(64), new Blob(["x"]), "x.pdf", false);
	await new Promise((r) => setTimeout(r, 800));
	expect(files.hasLocal("0".repeat(64))).toBe(true);
});

test("switching to online only while a downloaded original is being written: it is not kept", async () => {
	const srv = server();
	const repo = await workspace(false);
	const a = await srv.add("big original");
	addFile(repo, "a.pdf", a);
	const { files } = deviceFiles(repo);
	// hold the write of the original on this device
	const inner = files as unknown as {
		ready: Promise<void>;
		store: { put(h: string, b: Blob): Promise<void> };
	};
	await inner.ready;
	const store = inner.store;
	let release!: () => void;
	const writing = new Promise<void>((r) => (release = r));
	let started = false;
	const put = store.put.bind(store);
	store.put = async (h, b) => {
		if (h === a.hash) (started = true), await writing;
		return put(h, b);
	};
	files.setMode("local");
	await expect.poll(() => started, { timeout: 5000 }).toBe(true);
	files.setMode("online");
	await files.dropOriginals();
	release();
	await expect.poll(() => files.status.downloading, { timeout: 5000 }).toBe(0);
	await new Promise((r) => setTimeout(r, 100));
	expect(files.hasLocal(a.hash)).toBe(false);
});

test("an original opened while everything is local, switched to online only while it is written: not kept", async () => {
	const srv = server();
	const repo = await workspace(false);
	const a = await srv.add("opened original");
	addFile(repo, "a.pdf", a);
	const { files } = deviceFiles(repo);
	const inner = files as unknown as {
		ready: Promise<void>;
		store: { put(h: string, b: Blob): Promise<void> };
	};
	await inner.ready;
	let release!: () => void;
	const writing = new Promise<void>((r) => (release = r));
	let started = false;
	const put = inner.store.put.bind(inner.store);
	inner.store.put = async (h, b) => {
		if (h === a.hash) (started = true), await writing;
		return put(h, b);
	};
	files.mode = "local"; // as setMode, without starting downloads
	const opened = files.url(a.hash);
	await expect.poll(() => started, { timeout: 5000 }).toBe(true);
	files.setMode("online");
	await files.dropOriginals();
	release();
	expect(await opened).toBeTruthy();
	expect(files.hasLocal(a.hash)).toBe(false);
});

test("contents from the server: loaded with the token in the header, shown from URLs that never reach the server", async () => {
	const read = globalThis.fetch.bind(globalThis); // the real one, for blob: URLs
	const srv = server();
	const repo = await workspace(false);
	const { files } = deviceFiles(repo);
	const pdf = await srv.add("%PDF-1.4 content");
	const svg = await srv.add(
		'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
	);
	const last = () => vi.mocked(fetch).mock.calls.at(-1)!;

	const view = (await files.viewUrl(pdf.hash, "application/pdf"))!;
	expect(view).toMatch(/^blob:/);
	expect(String(last()[0])).toBe(`http://server.test/api/blobs/${pdf.hash}`);
	expect((last()[1]?.headers as Record<string, string>).authorization).toBe("Bearer t");
	expect((await (await read(view)).blob()).type).toBe("application/pdf");
	// a type that could run in the app's origin never goes on a blob: URL
	const html = (await files.viewUrl(pdf.hash, "text/html"))!;
	expect((await (await read(html)).blob()).type).toBe("application/octet-stream");
	// an SVG as data: (no origin when opened on its own), not as blob:
	expect(await files.url(svg.hash)).toMatch(/^data:image\/svg\+xml;base64,/);
});
