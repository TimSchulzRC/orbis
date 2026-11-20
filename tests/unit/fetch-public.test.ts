// Downloads for attach with a url (fetch-public.ts): only public addresses, the checked one is the one connected to.
import { afterAll, expect, test } from "bun:test";
import { BlockedAddress, fetchPublic, privateAddress } from "@orbis/server/fetch-public";

const inside = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response("internal-secret"),
});
afterAll(() => inside.stop(true));
const url = `http://localhost:${inside.port}/`;

test("private, loopback, link-local and mapped addresses count as private", () => {
	for (const ip of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"192.168.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"::",
		"fd00::1",
		"fe80::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"64:ff9b::a00:1",
	])
		expect(privateAddress(ip)).toBe(true);
	for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])
		expect(privateAddress(ip)).toBe(false);
});

test("a name that resolves to a private address is refused", async () => {
	await expect(
		fetchPublic(url, { max: 100, timeoutMs: 2000, resolve: async () => ["127.0.0.1"] }),
	).rejects.toBeInstanceOf(BlockedAddress);
	await expect(
		fetchPublic(url, {
			max: 100,
			timeoutMs: 2000,
			resolve: async () => ["203.0.113.7", "127.0.0.1"],
		}),
	).rejects.toBeInstanceOf(BlockedAddress);
	await expect(
		fetchPublic(`http://127.0.0.1:${inside.port}/`, { max: 100, timeoutMs: 2000 }),
	).rejects.toBeInstanceOf(BlockedAddress);
});

test("the connection goes to the checked address, never to one resolved again (DNS rebinding)", async () => {
	let lookups = 0;
	// checked as public; the system's resolver would say 127.0.0.1 for localhost
	const out = await fetchPublic(url, {
		max: 100,
		timeoutMs: 800,
		resolve: () => {
			lookups++;
			return Promise.resolve(["203.0.113.7"]);
		},
	}).catch((e: Error) => e);
	expect(out).toBeInstanceOf(Error);
	expect(String(out)).not.toContain("internal-secret");
	expect(lookups).toBe(1);
});
