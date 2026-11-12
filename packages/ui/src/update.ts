// App update state, fed by the web app's service worker.
import { useSyncExternalStore } from "react";

/** "ready": loaded, waiting to take over; "applying": local changes go out, then one reload. */
export type UpdateState = "none" | "loading" | "ready" | "applying";

let state: UpdateState = "none";
let apply: () => void = () => {
	// nothing to apply until an update is ready
};
let check: () => Promise<boolean> = async () => false;
const listeners = new Set<() => void>();

export function setUpdate(next: UpdateState, run?: () => void) {
	state = next;
	if (run) apply = run;
	for (const f of listeners) f();
}

/** `fn` resolves true when it found one. Without a service worker nothing is ever found. */
export function setUpdateCheck(fn: () => Promise<boolean>) {
	check = fn;
}

export const applyUpdate = () => apply();
export const checkForUpdate = () => check();
export const useUpdate = () =>
	useSyncExternalStore(
		(f) => {
			listeners.add(f);
			return () => listeners.delete(f);
		},
		() => state,
	);
