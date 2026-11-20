// The iPhone app. ORBIS_IOS_BUNDLE_ID and ORBIS_IOS_TEAM sign it with your own Apple team (a free
// Personal Team works too, see README.md).
import type { ExpoConfig } from "expo/config";

const bundleIdentifier = process.env.ORBIS_IOS_BUNDLE_ID || "app.orbis.mobile";
const appleTeamId = process.env.ORBIS_IOS_TEAM || undefined;

export default (): ExpoConfig => ({
	name: "Orbis",
	slug: "orbis",
	scheme: "orbis",
	version: "0.0.1",
	orientation: "portrait",
	userInterfaceStyle: "automatic",
	icon: "./assets/icon.png",
	ios: {
		bundleIdentifier,
		appleTeamId,
		supportsTablet: false,
		icon: { light: "./assets/icon.png", dark: "./assets/icon-dark.png" },
		infoPlist: {
			// the app speaks German and English: without these iOS runs it in English on a German
			// iPhone, and the system's own parts (date pickers, menus, VoiceOver) stay English
			CFBundleDevelopmentRegion: "en",
			CFBundleLocalizations: ["en", "de"],
			// self-hosted servers often run on plain http in the home network
			NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
			NSLocalNetworkUsageDescription:
				"Orbis verbindet sich mit deinem Orbis-Server, auch im lokalen Netzwerk.",
			ITSAppUsesNonExemptEncryption: false,
		},
	},
	plugins: [
		"expo-router",
		"expo-sqlite",
		"expo-secure-store",
		"expo-localization",
		[
			"expo-splash-screen",
			{
				image: "./assets/splash.png",
				imageWidth: 112,
				backgroundColor: "#F7F6F3",
				dark: { image: "./assets/splash-dark.png", backgroundColor: "#121212" },
			},
		],
	],
	experiments: { typedRoutes: true },
});
