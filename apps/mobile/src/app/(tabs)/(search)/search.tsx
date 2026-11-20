// Full-text search over the workspaces the switcher shows, on this phone (offline too). Before typing it lists what
// was edited last.

import { fmtRelative } from "@orbis/core/i18n";
import { snippet } from "@orbis/core/search";
import { recentlyChanged } from "@orbis/core/today";
import { Stack } from "expo-router";
import { useState } from "react";
import { useShownSpaces } from "../../../lib/hooks";
import { lang, t } from "../../../lib/i18n";
import { ItemRow, placeOf } from "../../../ui/item";
import { Empty, Screen, Section } from "../../../ui/list";
import { lookOf } from "../../../ui/look";
import { SpaceSwitcher } from "../../../ui/spaces";

const LIMIT = 40;
const RECENT = 15;

export default function Search() {
	const spaces = useShownSpaces();
	const [q, setQ] = useState("");
	const query = q.trim();
	const several = spaces.length > 1;
	const hits = query
		? spaces.flatMap((space) =>
				space.ix ? space.repo.search(query, LIMIT).map((item) => ({ space, item })) : [],
			)
		: spaces
				.flatMap((space) =>
					space.ix ? recentlyChanged(space.ix, RECENT).map((item) => ({ space, item })) : [],
				)
				.sort((a, b) => b.item.updated - a.item.updated)
				.slice(0, RECENT);
	return (
		<>
			<Stack.Screen options={{ title: t("nav.search") }} />
			<SpaceSwitcher />
			{/* the bar stays while searching, with the switcher at its left */}
			<Stack.SearchBar
				autoCapitalize="none"
				hideNavigationBar={false}
				hideWhenScrolling={false}
				onCancelButtonPress={() => setQ("")}
				onChangeText={(e) => setQ(e.nativeEvent.text)}
				placeholder={t("nav.searchPlaceholder")}
			/>
			<Screen>
				{query && !hits.length && <Empty symbol="magnifyingglass" title={t("mobile.noResults")} />}
				<Section prominent title={query ? undefined : t("today.recentTitle")}>
					{hits.map(({ space, item }) => {
						const ix = space.ix!;
						const where = [lookOf(item, ix).kind, placeOf(item, ix), several ? space.info.name : ""]
							.filter(Boolean)
							.join(" · ");
						const text = query ? snippet(item.body, query, 90).replace(/\s+/g, " ").trim() : "";
						return (
							<ItemRow
								detail={query ? undefined : fmtRelative(lang, item.updated)}
								item={item}
								ix={ix}
								key={`${space.info.id}/${item.id}`}
								repo={space.repo}
								space={space.info.id}
								status={false}
								subtitle={[where, text].filter(Boolean).join("\n")}
							/>
						);
					})}
				</Section>
			</Screen>
		</>
	);
}
