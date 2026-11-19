// The app's name with the stage of its build, like T3 Code: a stable release still says "(Alpha)"
// while Obtion is one. The version comes from the server (/api/info, OBTION_BUILD_VERSION).

/**
 * The stage every stable release carries in its name. Changed by hand when Obtion leaves it;
 * .github/scripts/resolve-release.sh puts the same word into the title of the GitHub release.
 */
export const STABLE_STAGE = "Alpha";

/** "Dev" for a dev build, "Nightly" for 0.0.2-nightly.20261030.1, STABLE_STAGE for 0.0.2. */
export function appStage(version: string): string {
	if (!version || version === "dev") return "Dev";
	if (version.includes("-nightly.")) return "Nightly";
	return STABLE_STAGE;
}

/** "Obtion (Alpha)" */
export const appName = (version: string) => `Obtion (${appStage(version)})`;
