// The iPhone app's plain logic (apps/mobile/src/lib): what it makes of a typed server address and
// which checkbox a tap ticks.
import { expect, test } from "bun:test";
import { serverUrl } from "../../apps/mobile/src/lib/api";
import { toggleTask } from "../../apps/mobile/src/lib/text";

test("a server address: https unless http is typed, only scheme and host, from a link too", () => {
	expect(serverUrl("notes.example.org")).toBe("https://notes.example.org");
	expect(serverUrl(" Notes.Example.org/ ")).toBe("https://notes.example.org");
	expect(serverUrl("http://192.168.1.20:8480")).toBe("http://192.168.1.20:8480");
	expect(serverUrl("https://notes.example.org/#/join/abc")).toBe("https://notes.example.org");
	expect(serverUrl("")).toBe("");
});

test("a tap ticks the n-th checkbox as the page shows them, not one in a code block", () => {
	const body = [
		"- [ ] milk",
		"```",
		"- [ ] not a task",
		"```",
		"1. [x] bread",
		"> - [ ] quoted",
	].join("\n");
	expect(toggleTask(body, 0).split("\n")[0]).toBe("- [x] milk");
	expect(toggleTask(body, 1).split("\n")[4]).toBe("1. [ ] bread");
	expect(toggleTask(body, 2).split("\n")[5]).toBe("> - [x] quoted");
	expect(toggleTask(body, 1).split("\n")[2]).toBe("- [ ] not a task");
	expect(toggleTask(body, 3)).toBe(body);
});
