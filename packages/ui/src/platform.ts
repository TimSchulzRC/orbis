// Where the app runs. In a browser it belongs to one server: the one that served it, or the one it
// was built for (VITE_OBTION_SERVER, for a web app served by another host). In the desktop app
// (apps/desktop) it belongs to the server running on this device – its local workspaces work
// without a network – and can connect to further servers.
import type { User } from "@obtion/core/api";

/** What the desktop app's preload hands the page (apps/desktop/src/preload.ts). */
export interface DesktopBridge {
	/** "darwin", "win32", "linux" */
	os: string;
	/** The server on this device: its address and its one account, signed in. */
	local: { url: string; token: string; user: User };
	/** A new session on the server on this device, when its token stopped counting. */
	renewLocal(): Promise<{ token: string; user: User }>;
}

declare global {
	interface Window {
		obtionDesktop?: DesktopBridge;
	}
}

export const desktop: DesktopBridge | undefined =
	typeof window !== "undefined" ? window.obtionDesktop : undefined;

/** The address of the app's own server ("" never: in a browser at least the page's origin). */
export const homeUrl = (): string =>
	desktop
		? desktop.local.url
		: (import.meta.env.VITE_OBTION_SERVER || location.origin).replace(/\/$/, "");

/** Further servers can be added: only in the desktop app (a web page stays with its server). */
export const canConnect = !!desktop;
