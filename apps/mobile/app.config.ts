// The iPhone app. OBTION_IOS_BUNDLE_ID and OBTION_IOS_TEAM sign it with your own Apple team (a free
// Personal Team works too, see README.md).
import type { ExpoConfig } from "expo/config";

const bundleIdentifier = process.env.OBTION_IOS_BUNDLE_ID || "app.obtion.mobile";
const appleTeamId = process.env.OBTION_IOS_TEAM || undefined;

export default (): ExpoConfig => ({
	name: "Obtion",
	slug: "obtion",
	scheme: "obtion",
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
				"Obtion verbindet sich mit deinem Obtion-Server, auch im lokalen Netzwerk.",
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
