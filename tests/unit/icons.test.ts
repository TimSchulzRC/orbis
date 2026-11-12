// Each release channel shows the logo in its colour: the server answers /icon.svg & co. from its folder.
import { expect, test } from "bun:test";
import { channelOf, iconPath } from "../../apps/server/src/icons";

test("the build version gives the channel", () => {
	expect(channelOf("dev")).toBe("dev");
	expect(channelOf("0.0.2-nightly.20261030.41")).toBe("nightly");
	expect(channelOf("0.0.2")).toBe("stable");
});

test("only the app icons go to the channel's folder", () => {
	expect(iconPath("/icon.svg", "0.0.2")).toBe("/icons/stable/icon.svg");
	expect(iconPath("/icon-dark.svg", "0.0.2-nightly.20261030.41")).toBe(
		"/icons/nightly/icon-dark.svg",
	);
	expect(iconPath("/apple-touch-icon.png", "dev")).toBe("/icons/dev/apple-touch-icon.png");
	expect(iconPath("/icon-512.png", "dev")).toBe("/icons/dev/icon-512.png");
	expect(iconPath("/assets/icon.svg", "dev")).toBe("/assets/icon.svg");
	expect(iconPath("/", "dev")).toBe("/");
});
