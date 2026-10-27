/** "10.0.0.1" as a number; undefined if it is no IPv4 address. */
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

// Which host names the server answers to (guard against DNS rebinding: a web page under the
// attacker's domain whose DNS later points at this server). Such an attack needs a name the
// attacker controls in public DNS, so everything else is safe to answer, whatever the port:
//   - IP addresses (LAN, tailnet, loopback);
//   - names without a dot (nas, localhost) and private suffixes (.local, .lan, .home.arpa,
//     .internal, MagicDNS's .ts.net) – none of them can be set up by an outsider;
//   - public names only when named: OBTION_PUBLIC_URL, OBTION_ALLOWED_HOSTS.
const PRIVATE_SUFFIX = /\.(local|lan|home\.arpa|internal|ts\.net)$/;

/** A test for the Host header: private names and addresses always, public ones from the list (host or host:port). */
export function allowedHosts(named: string[]): (host: string | null) => boolean {
  const list = new Set(named.map((h) => h.trim().toLowerCase()).filter(Boolean));
  return (host) => {
    if (!host) return false;
    const h = host.toLowerCase();
    if (list.has(h)) return true;
    const name = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.replace(/:\d+$/, "");
    if (list.has(name)) return true;
    if (name.includes(":") || v4(name) !== undefined) return true; // IPv6 or IPv4 address
    return !name.includes(".") || PRIVATE_SUFFIX.test(name);
  };
}
