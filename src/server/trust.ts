// Who may tell the hub who is calling. `tailscale serve` adds the caller's identity as headers
// (tailscale-user-login/-name). Anyone who can reach the hub directly could send those headers
// too, so they count only if the connection comes from a trusted proxy:
//   - by default only loopback (127.0.0.1, ::1): tailscale serve on the same machine, or a
//     Tailscale sidecar container that shares the hub container's network;
//   - in a container behind tailscale serve on the host, the connection comes from the
//     container network's gateway: name it, exactly or as a range, in OBTION_TRUSTED_PROXIES
//     (comma-separated, e.g. "172.17.0.1" or "172.16.0.0/12").
// Everything else is the anonymous user "local" – never trusted, never an error.

export const DEFAULT_TRUSTED = "127.0.0.1,::1";

/** "::ffff:10.0.0.1" → "10.0.0.1"; lower case for IPv6. */
function normalize(ip: string): string {
  const s = ip.trim().toLowerCase();
  return s.startsWith("::ffff:") && s.includes(".") ? s.slice(7) : s;
}

function v4(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined;
    n = n * 256 + Number(p);
  }
  return n;
}

/** A test for peer addresses from a list of addresses and IPv4 ranges (CIDR). Bad entries are ignored. */
export function trustedProxies(spec: string = DEFAULT_TRUSTED): (ip: string | undefined | null) => boolean {
  const exact = new Set<string>();
  const ranges: { base: number; mask: number }[] = [];
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const [addr, bits] = entry.split("/");
    const n = v4(normalize(addr!));
    if (bits !== undefined && n !== undefined && /^\d{1,2}$/.test(bits) && Number(bits) <= 32) {
      const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
      ranges.push({ base: (n & mask) >>> 0, mask });
    } else if (bits === undefined) exact.add(normalize(addr!));
  }
  return (ip) => {
    if (!ip) return false;
    const a = normalize(ip);
    if (exact.has(a)) return true;
    const n = v4(a);
    return n !== undefined && ranges.some((r) => ((n & r.mask) >>> 0) === r.base);
  };
}
