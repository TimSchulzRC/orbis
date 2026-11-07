// The open drawing's way to take a library in, kept apart from Drawing.tsx so the lazily loaded
// editor can register it without importing the module that loads it.

type TakeLibrary = (blob: Blob) => Promise<void>;
let liveLibrary: TakeLibrary | null = null;

/** The open drawing takes a library itself (it shows it at once); returns the way to let go. */
export function setLiveLibrary(fn: TakeLibrary) {
	liveLibrary = fn;
	return () => {
		if (liveLibrary === fn) liveLibrary = null;
	};
}

/** The open drawing's library taker, if a drawing is open. */
export const getLiveLibrary = () => liveLibrary;
