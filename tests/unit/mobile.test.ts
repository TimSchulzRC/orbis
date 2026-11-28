// The iPhone app's plain logic (apps/mobile/src/lib): what it makes of a typed server address and
// which checkbox a tap ticks.
import { expect, test } from "bun:test";
import { initItem } from "@orbis/core/model";
import * as Y from "yjs";
import { serverUrl } from "../../apps/mobile/src/lib/api";
import { toggleTask, writeBody } from "../../apps/mobile/src/lib/text";

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
	// a line that is not the item the page showed there stays
	expect(toggleTask(body, 0, "- [ ] bread")).toBe(body);
	expect(toggleTask(body, 0, "- [ ] milk").split("\n")[0]).toBe("- [x] milk");
	// a code fence inside a quote hides its lines too
	expect(toggleTask("> ```\n> - [ ] code\n> ```\n- [ ] real", 0, "- [ ] real")).toBe(
		"> ```\n> - [ ] code\n> ```\n- [x] real",
	);
});

test("nested checkboxes count in the order of the text, as the page numbers them", () => {
	const body = "- [ ] a\n  - [ ] a1\n- [ ] b";
	expect(toggleTask(body, 1, "- [ ] a1")).toBe("- [ ] a\n  - [x] a1\n- [ ] b");
	expect(toggleTask(body, 2, "- [ ] b")).toBe("- [ ] a\n  - [ ] a1\n- [x] b");
});

test("writing a page's text moves its changed time, as typing in the web app does", () => {
	const doc = new Y.Doc();
	initItem(doc, { title: "Alt", body: "vorher", created: 1000 });
	const repo = { change: (_id: string, fn: (d: Y.Doc) => void) => doc.transact(() => fn(doc)) };
	writeBody(repo, "x", "nachher");
	expect(doc.getText("body").toString()).toBe("nachher");
	expect(doc.getMap("meta").get("updated")).toBeGreaterThan(1000);
});
