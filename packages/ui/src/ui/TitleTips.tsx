// Native `title` tooltips use the system's colours (light on a dark page). While hovered, the title
// attribute is removed so the browser shows nothing, and shown in the app's own popover instead.
// Mouse only; touch has no hover.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TIP_CLASS } from "../components/ui/tooltip";

const DELAY = 500;
const GAP = 6;
/** Space kept free between the tooltip and the window's edges. */
const EDGE = 4;

export function TitleTips() {
	const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
	const box = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

	useEffect(() => {
		let el: HTMLElement | null = null;
		let text = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const restore = () => {
			clearTimeout(timer);
			// put the title back unless the page gave the element a new one meanwhile
			if (el && !el.hasAttribute("title")) el.setAttribute("title", text);
			el = null;
			setTip(null);
		};
		const over = (e: PointerEvent) => {
			if (e.pointerType !== "mouse") return;
			const target = (e.target as Element | null)?.closest?.<HTMLElement>("[title]");
			if (target === el) return;
			if (el?.contains(e.target as Node)) return; // within the element: an inner one without a title
			restore();
			if (!target) return;
			const title = target.getAttribute("title");
			if (!title?.trim()) return;
			el = target;
			text = title;
			target.removeAttribute("title");
			timer = setTimeout(
				() => el?.isConnected && setTip({ text, rect: el.getBoundingClientRect() }),
				DELAY,
			);
		};
		const out = (e: PointerEvent) => {
			if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) restore();
		};
		// a click, a key or scrolling: the tooltip goes (the title comes back on leaving)
		const hide = () => {
			clearTimeout(timer);
			setTip(null);
		};
		addEventListener("pointerover", over, true);
		addEventListener("pointerout", out, true);
		addEventListener("pointerdown", hide, true);
		addEventListener("keydown", hide, true);
		addEventListener("scroll", hide, true);
		addEventListener("blur", restore);
		return () => {
			restore();
			removeEventListener("pointerover", over, true);
			removeEventListener("pointerout", out, true);
			removeEventListener("pointerdown", hide, true);
			removeEventListener("keydown", hide, true);
			removeEventListener("scroll", hide, true);
			removeEventListener("blur", restore);
		};
	}, []);

	useLayoutEffect(() => {
		if (!tip || !box.current) return setPos(null);
		const { width, height } = box.current.getBoundingClientRect();
		const anchor = tip.rect;
		const below = anchor.bottom + GAP + height <= innerHeight - EDGE;
		const left = Math.min(
			Math.max(EDGE, anchor.left + anchor.width / 2 - width / 2),
			innerWidth - width - EDGE,
		);
		setPos({ left, top: below ? anchor.bottom + GAP : Math.max(EDGE, anchor.top - GAP - height) });
	}, [tip]);

	if (!tip) return null;
	return createPortal(
		<div
			className={`pointer-events-none fixed z-[100] max-w-72 whitespace-pre-line break-words ${TIP_CLASS}`}
			ref={box}
			role="tooltip"
			style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
		>
			{tip.text}
		</div>,
		document.body,
	);
}
