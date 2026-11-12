import { expect, test } from "bun:test";
import { allowedHosts } from "@obtion/server/trust";

// addresses and private names on any port, public names only when configured
const ok = allowedHosts(["obtion.example.org", "notes.example.com:8443", ""]);

test.each([
	"192.168.1.10:8480",
	"100.101.102.103:9000",
	"127.0.0.1:8480",
	"[fd7a:115c::1]:8480",
	"[::1]:8480",
	"nas:8480",
	"localhost:5180",
	"nas.local:8480",
	"nas.fritz.lan",
	"nas.tail1234.ts.net",
	"nas.tail1234.ts.net:8480",
	"obtion.example.org",
	"Obtion.Example.org:443",
	"notes.example.com:8443",
])("host %p is allowed", (h) => expect(ok(h)).toBe(true));

test.each([
	"evil.example.net",
	"evil.example.net:8480",
	"notes.example.com:8480",
	"ts.net.evil.example",
	"",
	null,
])("host %p is refused", (h) => expect(ok(h)).toBe(false));
