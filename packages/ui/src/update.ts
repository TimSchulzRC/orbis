// App update state, fed by the web app's service worker.
import { useSyncExternalStore } from "react";

/** "ready": loaded, waiting to take over; "applying": local changes go out, then one reload. */
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

/** `fn` resolves true when it found one. Without a service worker nothing is ever found. */
export const setUpdateCheck = (fn: () => Promise<boolean>) => void (check = fn);

export const applyUpdate = () => apply();
export const checkForUpdate = () => check();
export const useUpdate = () =>
	useSyncExternalStore(
		(f) => (listeners.add(f), () => listeners.delete(f)),
		() => state,
	);
