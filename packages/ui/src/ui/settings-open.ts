// The settings open as a dialog over the page that is open (from the sidebar, the menu, the
// palette); "#/settings" leads there too. In the dialog, the app's settings or one workspace's
// (`space`; from its menu in the sidebar, the list in the app's, "#/w/<id>/settings"). Another
// address closes it (a link inside, Back).
import { useSyncExternalStore } from "react";

let open: { at: string; space: string | null } | null = null; // `at`: the address it was opened on
const listeners = new Set<() => void>();
const set = (next: typeof open) => ((open = next), listeners.forEach((f) => f()));

/** The app's settings (also from within a workspace's: back to them). Takes no argument: safe as an onClick. */
export const openSettings = () => set({ at: open?.at ?? location.hash, space: null });
/** The settings of workspace `id`, in the same dialog. */
export const openSpaceSettings = (id: string) => set({ at: open?.at ?? location.hash, space: id });
export const closeSettings = () => set(null);
addEventListener("hashchange", () => open !== null && location.hash !== open.at && closeSettings());

/** Whether the dialog is open (null: not), and with which workspace's settings (`space` null: the app's). */
export const settingsOpen = () => open;
export const useSettingsOpen = () => useSyncExternalStore((f) => (listeners.add(f), () => listeners.delete(f)), settingsOpen);
