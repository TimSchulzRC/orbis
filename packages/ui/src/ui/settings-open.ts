// The app's settings open as a dialog over the page that is open (from the sidebar, the menu, the
// palette); "#/settings" leads there too. Another address closes them (a workspace's settings
// from the list in them, Back).
import { useSyncExternalStore } from "react";

let open: string | null = null; // the address they were opened on
const listeners = new Set<() => void>();
const set = (at: string | null) => ((open = at), listeners.forEach((f) => f()));

export const openSettings = () => set(location.hash);
export const closeSettings = () => set(null);
addEventListener("hashchange", () => open !== null && location.hash !== open && closeSettings());

export const useSettingsOpen = () => useSyncExternalStore((f) => (listeners.add(f), () => listeners.delete(f)), () => open !== null);
