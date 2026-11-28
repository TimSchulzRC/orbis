// iOS system colours (they follow light and dark mode and the user's contrast setting) plus the
// app's own: the yellow accent and the type palette of packages/ui/src/theme.css.

import { type ColorValue, DynamicColorIOS, PlatformColor } from "react-native";

const dyn = (light: string, dark: string) => DynamicColorIOS({ light, dark });

export const C = {
	label: PlatformColor("label"),
	secondary: PlatformColor("secondaryLabel"),
	tertiary: PlatformColor("tertiaryLabel"),
	placeholder: PlatformColor("placeholderText"),
	separator: PlatformColor("separator"),
	background: PlatformColor("systemGroupedBackground"),
	card: PlatformColor("secondarySystemGroupedBackground"),
	plain: PlatformColor("systemBackground"),
	fill: PlatformColor("tertiarySystemFill"),
	link: PlatformColor("link"),
	red: PlatformColor("systemRed"),
	green: PlatformColor("systemGreen"),
	/** The app's yellow (--pal-amber), the tint of buttons, tabs and the inbox. */
	accent: dyn("#be780a", "#f0b040"),
	/** The inbox's yellow as text (--warn-text). */
	warn: dyn("#945b08", "#f0b040"),
	ok: dyn("#23905f", "#50c88c"),
	faint: dyn("#8a8a8a", "#8a8a8a"),
} satisfies Record<string, ColorValue>;

/** As the light and dark palettes in theme.css. */
const PALETTE: Record<string, [string, string]> = {
	blue: ["#2f6ae0", "#6e96ff"],
	violet: ["#8b4fd8", "#b58cf0"],
	green: ["#23905f", "#50c88c"],
	slate: ["#5c6b80", "#94a3b8"],
	teal: ["#0d828c", "#46c8d2"],
	pink: ["#c84078", "#f082af"],
	brown: ["#9a6b45", "#c79a73"],
	amber: ["#be780a", "#f0b040"],
	red: ["#d1453b", "#f06b60"],
	indigo: ["#4f55d8", "#9399ff"],
	olive: ["#6b7a1f", "#b4c35a"],
	gray: ["#706258", "#c4b6aa"],
};

const cache = new Map<string, ColorValue>();
/** A type colour by name ("blue"); unknown names are slate, as in the web app. */
export function pal(color?: string): ColorValue {
	const name = color && PALETTE[color] ? color : "slate";
	const known = cache.get(name);
	if (known) return known;
	const [light, dark] = PALETTE[name]!;
	const c = dyn(light, dark);
	cache.set(name, c);
	return c;
}

/** The light value of a palette colour, for places that need a plain string. */
export const palHex = (color?: string) => (PALETTE[color ?? ""] ?? PALETTE.slate!)[0];

export const RADIUS = 26;
export const GUTTER = 16;
