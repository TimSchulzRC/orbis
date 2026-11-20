import { expect, test } from "bun:test";
import { agentOrigin, originText, parseOrigin, personOrigin } from "@orbis/core/origin";

const tim = { id: "u1", name: "Tim" };

test("a person in the app: name, account and device; the device is kept, not shown", () => {
	const o = personOrigin(tim, "Mac-x3f9");
	expect(o).toBe("web:Tim;u=u1;d=Mac-x3f9");
	expect(parseOrigin(o)).toEqual({
		kind: "web",
		name: "Tim",
		person: { id: "u1", name: "Tim" },
		device: "Mac-x3f9",
	});
	expect(originText(o)).toBe("Tim");
});

test("an agent with the access of a person", () => {
	expect(parseOrigin(agentOrigin("claude-code", tim))).toEqual({
		kind: "agent",
		name: "claude-code",
		person: { id: "u1", name: "Tim" },
		device: undefined,
	});
	expect(originText(agentOrigin("claude-code", tim))).toBe("claude-code for Tim");
});

test("separators in a name cannot break the format", () => {
	expect(parseOrigin(personOrigin({ id: "u2", name: "A;n=B,C" }))).toMatchObject({
		person: { id: "u2", name: "A n B C" },
	});
});

test("a bare name and several origins read", () => {
	expect(parseOrigin("web:Tim")).toMatchObject({ person: { name: "Tim" }, device: undefined });
	expect(parseOrigin("agent:claude, web:Tim")).toMatchObject({ kind: "agent", name: "claude" });
	expect(originText("import:notion")).toBe("import:notion");
});
