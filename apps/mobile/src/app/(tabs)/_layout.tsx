// The native tab bar (Liquid Glass on iOS 26): Home, the inbox with its count, Browse and Search,
// which iOS shows as its own round button and turns into the search field.

import { inbox } from "@obtion/core/placement";
import { NativeTabs } from "expo-router/native-tabs";
import { useSpaces } from "../../lib/hooks";
import { t } from "../../lib/i18n";
import { C } from "../../ui/theme";

export default function TabsLayout() {
	const spaces = useSpaces();
	const waiting = spaces.reduce((n, s) => n + (s.ix ? inbox(s.ix).length : 0), 0);
	return (
		<NativeTabs minimizeBehavior="onScrollDown" tintColor={C.accent}>
			<NativeTabs.Trigger name="(home)">
				<NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} />
				<NativeTabs.Trigger.Label>{t("nav.home")}</NativeTabs.Trigger.Label>
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(inbox)">
				<NativeTabs.Trigger.Icon sf={{ default: "tray", selected: "tray.fill" }} />
				<NativeTabs.Trigger.Label>{t("nav.inbox")}</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Badge hidden={waiting === 0}>
					{String(waiting)}
				</NativeTabs.Trigger.Badge>
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(browse)">
				<NativeTabs.Trigger.Icon
					sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }}
				/>
				<NativeTabs.Trigger.Label>{t("mobile.browse")}</NativeTabs.Trigger.Label>
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(search)" role="search">
				<NativeTabs.Trigger.Icon sf="magnifyingglass" />
				<NativeTabs.Trigger.Label>{t("nav.search")}</NativeTabs.Trigger.Label>
			</NativeTabs.Trigger>
		</NativeTabs>
	);
}
