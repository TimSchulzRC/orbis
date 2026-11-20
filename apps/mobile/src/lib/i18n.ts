// The app speaks the phone's language when Orbis has it (German or English), else English. iOS
// restarts an app when its language changes, so it is read once.

import { type Lang, makeT, type T } from "@orbis/core/i18n";
import { displayTitle, type Item } from "@orbis/core/model";
import { getLocales } from "expo-localization";

export const lang: Lang =
	getLocales().find((l) => l.languageCode === "de" || l.languageCode === "en")?.languageCode ===
	"de"
		? "de"
		: "en";
export const t: T = makeT(lang);

export function useT() {
	return { t, lang };
}

/** As in the web app: a file goes by its name, a drawing by its kind, an empty title is "Untitled". */
export function titleOf(item: Pick<Item, "title" | "file" | "kind">): string {
	if (item.kind === "drawing") return t("kind.drawing");
	return displayTitle(item) || t("untitled");
}
