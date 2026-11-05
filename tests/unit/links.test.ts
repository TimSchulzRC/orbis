// Signed links to one content and the addresses attach may fetch.
import { expect, test } from "bun:test";
import { BlobLinks, LINK_SECONDS } from "@obtion/server/links";
import { BlockedAddress, fetchPublic, privateAddress } from "@obtion/server/fetch-public";

const hash = "a".repeat(64);

test("a signed link holds for its content, workspace and minutes only", () => {
  const links = new BlobLinks("geheim");
  const now = Date.UTC(2026, 10, 5, 12);
  const { s, expires } = links.sign("ws1", hash, "user-1", now);
  expect(expires - now).toBe(LINK_SECONDS * 1000);
  expect(links.verify(s, "ws1", hash, now)).toBe("user-1");
  expect(links.verify(s, "ws1", hash, now + (LINK_SECONDS - 1) * 1000)).toBe("user-1");
  expect(links.verify(s, "ws1", hash, now + LINK_SECONDS * 1000)).toBeUndefined();
  expect(links.verify(s, "ws2", hash, now)).toBeUndefined();
  expect(links.verify(s, "ws1", "b".repeat(64), now)).toBeUndefined();
  expect(new BlobLinks("anderes").verify(s, "ws1", hash, now)).toBeUndefined();
  expect(links.verify(s + ".x", "ws1", hash, now)).toBeUndefined();
  // a far expiry, even signed, is refused: no link lives longer than LINK_SECONDS
  const far = links.sign("ws1", hash, "user-1", now + 3600_000).s;
  expect(links.verify(far, "ws1", hash, now)).toBeUndefined();
});

test.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:a00:1", "not an ip"])("%s is not public", (ip) => {
  expect(privateAddress(ip)).toBe(true);
});

test.each(["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111"])("%s is public", (ip) => {
  expect(privateAddress(ip)).toBe(false);
});

test("a redirect to a private address is refused before it is fetched", async () => {
  const asked: string[] = [];
  const fake = (async (url: URL) => {
    asked.push(String(url));
    return new Response(null, { status: 302, headers: { location: "http://intern.example/geheim" } });
  }) as unknown as typeof fetch;
  const resolve = async (host: string) => (host === "intern.example" ? ["10.0.0.5"] : ["93.184.215.14"]);
  await expect(fetchPublic("https://public.example/datei", { max: 100, timeoutMs: 1000, resolve, fetch: fake })).rejects.toThrow(BlockedAddress);
  expect(asked).toEqual(["https://public.example/datei"]);
});

test("a public download stops at the limit", async () => {
  const fake = (async () => new Response(new Uint8Array(500))) as unknown as typeof fetch;
  const resolve = async () => ["93.184.215.14"];
  expect(await fetchPublic("https://public.example/x", { max: 100, timeoutMs: 1000, resolve, fetch: fake })).toBe("too large");
  expect(await fetchPublic("https://public.example/x", { max: 1000, timeoutMs: 1000, resolve, fetch: fake })).toBeInstanceOf(Uint8Array);
});
