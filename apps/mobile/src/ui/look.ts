// How an item looks: its SF Symbol, colour and kind, the iPhone counterpart of the web app's
// item-look.tsx. Type icons are stored as Lucide names (core/palette.ts) and mapped here.

import type { Index } from "@orbis/core/graph";
import { type Item, META_TYPE, type TypeSchema } from "@orbis/core/model";
import { isInInbox } from "@orbis/core/placement";
import type { ColorValue } from "react-native";
import type { SFSymbol } from "sf-symbols-typescript";
import { t } from "../lib/i18n";
import { C, pal } from "./theme";

const SYMBOLS: Record<string, SFSymbol> = {
	"sticky-note": "note.text",
	map: "map",
	"folder-kanban": "folder",
	"circle-check": "checkmark.circle",
	book: "book",
	user: "person",
	"pen-line": "pencil.line",
	"graduation-cap": "graduationcap",
	"building-2": "building.2",
	"file-text": "doc.text",
	star: "star",
	heart: "heart",
	lightbulb: "lightbulb",
	calendar: "calendar",
	flag: "flag",
	bookmark: "bookmark",
	briefcase: "briefcase",
	house: "house",
	music: "music.note",
	film: "film",
	globe: "globe",
	code: "chevron.left.forwardslash.chevron.right",
	coffee: "cup.and.saucer",
	camera: "camera",
	users: "person.2",
	target: "target",
	layers: "square.3.layers.3d",
	box: "shippingbox",
	leaf: "leaf",
	rocket: "paperplane",
	"message-circle": "message",
	link: "link",
	inbox: "tray",
	image: "photo",
	paperclip: "paperclip",
	"list-todo": "checklist",
	archive: "archivebox",
	circle: "circle",
};

const FILE_SYMBOLS: Record<string, SFSymbol> = {
	image: "photo",
	pdf: "doc.richtext",
	audio: "waveform",
	video: "film",
	document: "doc",
	other: "doc",
};

export const typeSymbol = (schema?: TypeSchema): SFSymbol =>
	(schema && SYMBOLS[schema.icon]) || "circle";

export interface Look {
	symbol: SFSymbol;
	color: ColorValue;
	/** "Task", "Note", "In the inbox" … */
	kind: string;
}

export function lookOf(item: Item, ix: Index): Look {
	if (item.kind === "file")
		return {
			symbol: FILE_SYMBOLS[item.file?.filetype ?? "other"] ?? "doc",
			color: C.faint,
			kind: t("kind.file"),
		};
	if (item.type === META_TYPE && item.schema)
		return { symbol: typeSymbol(item.schema), color: pal(item.schema.color), kind: t("kind.type") };
	const schema = ix.schemaOf(item);
	if (schema) return { symbol: typeSymbol(schema), color: pal(schema.color), kind: schema.name };
	if (isInInbox(item, ix)) return { symbol: "tray", color: C.accent, kind: t("kind.inbox") };
	return { symbol: "doc.text", color: C.faint, kind: t("kind.note") };
}
