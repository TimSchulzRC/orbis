// A new version of the app (the web app's service worker finds it, apps/web/src/update.ts): the
// status button (ui/StatusButton.tsx) shows it loading, then "Aktualisieren"; it can also look for one.
import { useSyncExternalStore } from "react";

/** "loading": found, its files load; "ready": loaded, waiting to take over; "applying": local changes go out, then one reload. */
export type UpdateState = "none" | "loading" | "ready" | "applying";

let state: UpdateState = "none";
let apply: () => void = () => {};
let check: () => Promise<boolean> = async () => false;
const listeners = new Set<() => void>();

export function setUpdate(next: UpdateState, run?: () => void) {
  state = next;
  if (run) apply = run;
  listeners.forEach((f) => f());
}

/** How to look for a new version (resolves true when one was found). Without a service worker: never. */
export const setUpdateCheck = (fn: () => Promise<boolean>) => void (check = fn);

export const applyUpdate = () => apply();
export const checkForUpdate = () => check();
export const useUpdate = () => useSyncExternalStore((f) => (listeners.add(f), () => listeners.delete(f)), () => state);
