// The app uses the shared packages straight from their source (packages/core, packages/sync), like
// the web app does. Everything they import from npm resolves from this app's node_modules, so
// there is one copy of yjs & co. even when the repository's own install exists beside it.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const packages = path.resolve(__dirname, "../../packages");
const core = path.join(packages, "core");
const entry = path.join(__dirname, "index.ts");

config.watchFolders = [core, path.join(packages, "sync")];
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")];

/** @type {import("metro-resolver").CustomResolver} */
config.resolver.resolveRequest = (context, name, platform) => {
	if (name === "@orbis/sync")
		return { type: "sourceFile", filePath: path.join(packages, "sync/src/repo.ts") };
	if (name.startsWith("@orbis/core/")) {
		const rest = name.slice("@orbis/core/".length);
		const filePath = rest.startsWith("locales/")
			? path.join(core, rest)
			: path.join(core, "src", `${rest}.ts`);
		return { type: "sourceFile", filePath };
	}
	// lib0 (Yjs) asks for isomorphic-webcrypto under React Native: the app's own random source instead
	if (name === "lib0/webcrypto")
		return { type: "sourceFile", filePath: path.join(__dirname, "src/shims/webcrypto.ts") };
	const bare = !name.startsWith(".") && !name.startsWith("/");
	if (bare && context.originModulePath.startsWith(packages + path.sep))
		return context.resolveRequest({ ...context, originModulePath: entry }, name, platform);
	return context.resolveRequest(context, name, platform);
};

module.exports = config;
