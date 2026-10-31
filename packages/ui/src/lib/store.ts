import { useSyncExternalStore } from "react";

/** A value outside of React (one for the whole app) that components follow: `use()` re-renders on every `set`. */
export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  };
}
