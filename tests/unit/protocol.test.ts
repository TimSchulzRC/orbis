import { test, expect } from "bun:test";
import { parseClientMsg } from "@obtion/server/workspace";

test("sync messages are checked once at the socket: valid ones pass, unknown keys drop", () => {
  expect(parseClientMsg(JSON.stringify({ t: "hello", since: 0, client: "a" }))).toEqual({ t: "hello", since: 0 });
  expect(parseClientMsg(JSON.stringify({ t: "push", area: "personal", items: [{ k: "k1", d: "n1", u: "AA==", s: "s1", a: "personal" }] }))).toEqual({
    t: "push",
    area: "personal",
    items: [{ k: "k1", d: "n1", u: "AA==", s: "s1" }],
  });
  expect(parseClientMsg('{"t":"ping"}')).toEqual({ t: "ping" });
});

test.each(["not json", "null", '{"t":"nope"}', '{"t":"hello"}', '{"t":"push","items":[{"k":"k1"}]}', '{"t":"push","area":7,"items":[]}'])("%p is dropped", (raw) => {
  expect(parseClientMsg(raw)).toBeNull();
});
