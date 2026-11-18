// Each tab is a native stack: its first page with a large title, entry and type pages pushed on
// top of it (shared by all four tabs, so the tab bar stays and "back" returns where you were).

import { Stack } from "expo-router";
import { TabContext } from "../../../ui/item";

const FIRST: Record<string, string> = {
	"(home)": "index",
	"(inbox)": "inbox",
	"(browse)": "browse",
	"(search)": "search",
};

export const unstable_settings = {
	anchor: "index",
	inbox: { anchor: "inbox" },
	browse: { anchor: "browse" },
	search: { anchor: "search" },
};

export default function TabStack({ segment }: { segment: string }) {
	return (
		<TabContext.Provider value={segment}>
			<Stack
				screenOptions={{
					headerTransparent: true,
					headerShadowVisible: false,
					headerLargeTitleShadowVisible: false,
					headerBackButtonDisplayMode: "minimal",
					headerLargeStyle: { backgroundColor: "transparent" },
				}}
			>
				<Stack.Screen name={FIRST[segment] ?? "index"} options={{ headerLargeTitle: true }} />
				<Stack.Screen name="type/[space]/[id]" options={{ headerLargeTitle: true }} />
				<Stack.Screen name="item/[space]/[id]" options={{ title: "" }} />
			</Stack>
		</TabContext.Provider>
	);
}
