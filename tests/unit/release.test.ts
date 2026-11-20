import { expect, test } from "bun:test";
import { appName, appStage, STABLE_STAGE } from "@orbis/core/release";

test("a stable release still carries its stage in the name", () => {
	expect(STABLE_STAGE).toBe("Alpha");
	expect(appStage("0.0.2")).toBe("Alpha");
	expect(appName("0.1.0")).toBe("Orbis (Alpha)");
});

test("nightly and dev builds say so instead", () => {
	expect(appName("0.0.2-nightly.20261030.1")).toBe("Orbis (Nightly)");
	expect(appName("dev")).toBe("Orbis (Dev)");
	expect(appName("")).toBe("Orbis (Dev)");
});
