import { useSyncExternalStore } from "react";

/** An app-wide value outside React; `use()` re-renders on every `set`. */
export function createStore<T>(initial: T) {
	let value = initial;
	const listeners = new Set<() => void>();
	const subscribe = (l: () => void) => {
		listeners.add(l);
		return () => void listeners.delete(l);
	};
	return {
		get: () => value,
		set(next: T) {
			value = next;
			for (const l of listeners) l();
		},
		use: () => useSyncExternalStore(subscribe, () => value),
	};
}
