/** Follows a drag until the pointer is let go: `move` on every move, `up` once at the end. */
export function startPointerDrag(move: (e: PointerEvent) => void, up: (e: PointerEvent) => void) {
  const end = (e: PointerEvent) => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", end);
    up(e);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", end);
}
