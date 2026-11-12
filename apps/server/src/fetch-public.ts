// Downloads for `attach` with a url: only public addresses, also after every redirect, so an agent
// can't make the server read from itself or its network (SSRF). The address is checked in the
// lookup of the connection itself, so the one checked is the one connected to (no DNS rebinding).
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;

export class BlockedAddress extends Error {}
export class DownloadFailed extends Error {}

/** Loopback, private, link-local, CGNAT, multicast, reserved and the like: never fetched. */
export function privateAddress(ip: string): boolean {
	const v = isIP(ip);
	if (v === 4) {
		const [a, b] = ip.split(".").map(Number) as [number, number];
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) ||
			(a === 198 && (b === 18 || b === 19))
		);
	}
	if (v === 6) {
		const x = ip.toLowerCase().replace(/^\[|\]$/g, "");
		const mapped =
			/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x)?.[1] ??
			/^::(\d+\.\d+\.\d+\.\d+)$/.exec(x)?.[1];
		if (mapped) return privateAddress(mapped);
		const hex = /^(?:0{1,4}:){0,5}:?:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
		if (hex) {
			const [hi, lo] = [Number.parseInt(hex[1]!, 16), Number.parseInt(hex[2]!, 16)];
			return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
		}
		return (
			x === "::" ||
			x === "::1" ||
			/^f[cd]/.test(x) ||
			/^fe[89ab]/.test(x) ||
			/^ff/.test(x) ||
			/^64:ff9b:/.test(x) ||
			/^2001:0?db8:/.test(x)
		);
	}
	return true;
}

type Lookup = (host: string) => Promise<string[]>;
const dnsLookup: Lookup = async (host) =>
	(await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const refuse = (host: string) =>
	new BlockedAddress(`${host} is not a public address; the server fetches only public URLs.`);

/** The connection's own lookup: resolves once, refuses if any address is private, hands over the checked ones. */
function pinned(resolve: Lookup): LookupFunction {
	return (host, options, done) => {
		resolve(host)
			.catch(() => [])
			.then((addresses) => {
				if (!addresses.length) throw new BlockedAddress(`Can't resolve ${host}.`);
				if (addresses.some(privateAddress)) throw refuse(host);
				return addresses.map((address) => ({ address, family: isIP(address) }));
			})
			.then(
				(all) =>
					options.all
						? (done as (e: null, a: typeof all) => void)(null, all)
						: done(null, all[0]!.address, all[0]!.family),
				(e: NodeJS.ErrnoException) => done(e, ""),
			);
	};
}

function request(url: URL, resolve: Lookup, signal: AbortSignal): Promise<http.IncomingMessage> {
	if (!["http:", "https:"].includes(url.protocol)) throw new BlockedAddress("Only http(s) URLs.");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	// an address in the URL needs no lookup: checked here
	if (isIP(host) && privateAddress(host)) throw refuse(host);
	const mod = url.protocol === "https:" ? https : http;
	return new Promise((ok, fail) => {
		const req = mod.request(
			{
				protocol: url.protocol,
				hostname: host,
				port: url.port || undefined,
				path: url.pathname + url.search,
				method: "GET",
				lookup: pinned(resolve),
				signal,
				headers: { "accept-encoding": "identity" },
			},
			ok,
		);
		req.on("error", (e) =>
			fail(e instanceof BlockedAddress ? e : new DownloadFailed(`Download failed: ${e.message}`)),
		);
		req.end();
	});
}

/** GET a public URL, following redirects by hand (each one checked), at most `max` bytes. */
export async function fetchPublic(
	raw: string,
	opts: { max: number; timeoutMs: number; resolve?: Lookup },
): Promise<Uint8Array | "too large" | { status: number }> {
	const resolve = opts.resolve ?? dnsLookup;
	const signal = AbortSignal.timeout(opts.timeoutMs);
	let url = new URL(raw);
	for (let hop = 0; ; hop++) {
		const res = await request(url, resolve, signal);
		const status = res.statusCode ?? 0;
		const next = res.headers.location;
		if (status >= 300 && status < 400 && next) {
			res.destroy();
			if (hop >= MAX_REDIRECTS) throw new BlockedAddress("Too many redirects.");
			url = new URL(next, url);
			continue;
		}
		if (status < 200 || status >= 300) return (res.destroy(), { status });
		if (Number(res.headers["content-length"] ?? 0) > opts.max) return (res.destroy(), "too large");
		const chunks: Buffer[] = [];
		let size = 0;
		try {
			for await (const chunk of res as AsyncIterable<Buffer>) {
				if ((size += chunk.length) > opts.max) return (res.destroy(), "too large");
				chunks.push(chunk);
			}
		} catch (e) {
			throw new DownloadFailed(`Download failed: ${(e as Error).message}`);
		}
		return new Uint8Array(Buffer.concat(chunks));
	}
}
