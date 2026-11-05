// Downloads for `attach` with a url: only public addresses, also after every redirect, so an agent
// can't make the server read from itself or its network (SSRF). Left open: a name whose address
// changes between this check and the download (DNS rebinding).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;

export class BlockedAddress extends Error {}

/** Loopback, private, link-local, CGNAT, multicast, reserved and the like: never fetched. */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const x = ip.toLowerCase().replace(/^\[|\]$/g, "");
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x)?.[1] ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(x)?.[1];
    if (mapped) return privateAddress(mapped);
    const hex = /^(?:0{1,4}:){0,5}:?:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
      return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || /^64:ff9b:/.test(x) || /^2001:0?db8:/.test(x);
  }
  return true;
}

type Lookup = (host: string) => Promise<string[]>;
const dnsLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

async function checkHost(url: URL, resolve: Lookup) {
  if (!["http:", "https:"].includes(url.protocol)) throw new BlockedAddress("Only http(s) URLs.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!addresses.length) throw new BlockedAddress(`Can't resolve ${host}.`);
  if (addresses.some(privateAddress)) throw new BlockedAddress(`${host} is not a public address; the server fetches only public URLs.`);
}

/** GET a public URL, following redirects by hand (each one checked), at most `max` bytes. */
export async function fetchPublic(raw: string, opts: { max: number; timeoutMs: number; resolve?: Lookup; fetch?: typeof fetch }): Promise<Uint8Array | "too large" | { status: number }> {
  const resolve = opts.resolve ?? dnsLookup;
  const get = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = new URL(raw);
  for (let hop = 0; ; hop++) {
    await checkHost(url, resolve);
    const res = await get(url, { redirect: "manual", signal });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new BlockedAddress("Too many redirects.");
      url = new URL(next, url);
      continue;
    }
    if (!res.ok) return { status: res.status };
    if (Number(res.headers.get("content-length") ?? 0) > opts.max) return (await res.body?.cancel(), "too large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      if ((size += chunk.length) > opts.max) return "too large";
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
}
