// The app's frame: signed out it shows only the sign-in, signed in the tabs with sheets above
// them (a new note, choosing a place, the settings, a new workspace, another server).

import { DarkTheme, DefaultTheme, SplashScreen, Stack, ThemeProvider } from "expo-router";
import { useEffect } from "react";
import { AppState, useColorScheme } from "react-native";
import { t } from "../lib/i18n";
import { refresh, useSession } from "../lib/session";

void SplashScreen.preventAutoHideAsync();

const ACCENT = { light: "#be780a", dark: "#f0b040" };

export default function RootLayout() {
	const session = useSession();
	const dark = useColorScheme() === "dark";
	useEffect(() => {
		SplashScreen.hide();
		void refresh();
		const sub = AppState.addEventListener("change", (state) => {
			if (state === "active") void refresh();
		});
		return () => sub.remove();
	}, []);
	const base = dark ? DarkTheme : DefaultTheme;
	const theme = { ...base, colors: { ...base.colors, primary: dark ? ACCENT.dark : ACCENT.light } };
	const sheet = {
		presentation: "formSheet",
		sheetGrabberVisible: true,
		headerShown: true,
		headerTransparent: true,
		headerShadowVisible: false,
	} as const;
	return (
		<ThemeProvider value={theme}>
			<Stack screenOptions={{ headerShown: false }}>
				<Stack.Protected guard={!!session}>
					<Stack.Screen name="(tabs)" />
					<Stack.Screen
						name="new"
						options={{ ...sheet, sheetAllowedDetents: [0.55, 1], title: t("tray.new") }}
					/>
					<Stack.Screen
						name="place"
						options={{ ...sheet, sheetAllowedDetents: [0.7, 1], title: t("triage.placeIn") }}
					/>
					<Stack.Screen
						name="settings"
						options={{ ...sheet, sheetAllowedDetents: [1], title: t("nav.settings") }}
					/>
					<Stack.Screen
						name="new-space"
						options={{ ...sheet, sheetAllowedDetents: [1], title: t("space.new") }}
					/>
					<Stack.Screen name="reauth" options={{ presentation: "modal" }} />
					<Stack.Screen name="connect" options={{ presentation: "modal" }} />
				</Stack.Protected>
				<Stack.Protected guard={!session}>
					<Stack.Screen name="sign-in" />
				</Stack.Protected>
			</Stack>
		</ThemeProvider>
	);
}
