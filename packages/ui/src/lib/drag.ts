/**
 * Where a row takes what is dropped on it: its upper part before it, its lower part after it, the
 * narrow middle into it. So between two rows there is more room than on one.
 */
export type DropZone = "before" | "inside" | "after";
export function dropZone(y: number, height: number): DropZone {
	if (y < height * 0.36) return "before";
	if (y > height * 0.64) return "after";
	return "inside";
}

export function startPointerDrag(move: (e: PointerEvent) => void, up: (e: PointerEvent) => void) {
	const end = (e: PointerEvent) => {
		removeEventListener("pointermove", move);
		removeEventListener("pointerup", end);
		up(e);
	};
	addEventListener("pointermove", move);
	addEventListener("pointerup", end);
}
