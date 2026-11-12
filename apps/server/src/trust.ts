function ipv4ToNumber(ip: string): number | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	let n = 0;
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined;
		n = n * 256 + Number(p);
	}
	return n;
}

// Host check against DNS rebinding. The attack needs a name the attacker controls in public DNS,
// so IP addresses, dotless names and private suffixes (incl. MagicDNS .ts.net) are safe on any
// port. Public names must be listed (OBTION_PUBLIC_URL, OBTION_ALLOWED_HOSTS).
const PRIVATE_SUFFIX = /\.(local|lan|home\.arpa|internal|ts\.net)$/;

/** `named` entries may be host or host:port. */
export function allowedHosts(named: string[]): (host: string | null) => boolean {
	const list = new Set(named.map((h) => h.trim().toLowerCase()).filter(Boolean));
	return (host) => {
		if (!host) return false;
		const h = host.toLowerCase();
		if (list.has(h)) return true;
		const name = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.replace(/:\d+$/, "");
		if (list.has(name)) return true;
		if (name.includes(":") || ipv4ToNumber(name) !== undefined) return true;
		return !name.includes(".") || PRIVATE_SUFFIX.test(name);
	};
}
