import { CircleFadingArrowUp, Cloud, CloudOff, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { refresh, useAccounts } from "../accounts";
import { Tip } from "../components/ui/tooltip";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { applyUpdate, checkForUpdate, useUpdate } from "../update";
import { Button } from "./primitives";
import { useReplicas } from "./Spaces";
import { notify } from "./toasts";

/** One turn of the arrows (Tailwind's animate-spin): they always make whole ones before they go. */
const TURN = 1000;
/** How long the arrows turn after a click on "offline" if no connection comes back. */
const RECONNECT_WAIT = 5000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sync of all workspaces on this device (offline as soon as one is) and a new version. A click
 * reconnects, updates, or checks for a new version.
 */
export function StatusButton({ className }: { className?: string }) {
	const { t } = useT();
	const { spaces } = useAccounts();
	const update = useUpdate();
	const replicas = useReplicas(spaces.map((s) => s.id));
	const statuses = replicas.map((r) => r.status);
	const online = statuses.every((s) => s.online);
	const pending = statuses.reduce((n, s) => n + s.pending, 0);
	const synced = statuses.every((s) => s.synced);
	const [busy, setBusy] = useState<"checking" | "connecting" | null>(null);
	useEffect(() => void (online && busy === "connecting" && setBusy(null)), [online]);

	const reconnect = async () => {
		setBusy("connecting");
		for (const r of replicas) if (!r.status.online) r.connect();
		void refresh();
		await pause(RECONNECT_WAIT);
		setBusy((b) => (b === "connecting" ? null : b));
	};
	const lookForUpdate = async () => {
		setBusy("checking");
		const found = await checkForUpdate().catch(() => false);
		setBusy(null);
		if (!found) notify(t("app.upToDate"));
	};

	type Look = {
		key: string;
		icon: typeof Cloud;
		label: string;
		hint?: string;
		tone?: string;
		turn?: boolean;
		run?: () => void;
	};
	const turning = (label: string): Look => ({ key: "turn", icon: RefreshCw, label, turn: true });
	const look: Look =
		update === "applying"
			? turning(t("app.updating"))
			: !online
				? busy === "connecting"
					? turning(t("sync.reconnecting"))
					: {
							key: "offline",
							icon: CloudOff,
							label: pending ? t("sync.offline", { count: pending }) : t("sync.offlineNone"),
							hint: t("sync.clickReconnect"),
							tone: "text-warn",
							run: () => void reconnect(),
						}
				: update === "ready"
					? {
							key: "update",
							icon: CircleFadingArrowUp,
							label: t("app.newVersion"),
							hint: t("app.clickUpdate"),
							tone: "text-link",
							run: applyUpdate,
						}
					: update === "loading"
						? turning(t("app.updateLoading"))
						: busy === "checking"
							? turning(t("app.checking"))
							: pending
								? turning(t("sync.pending", { count: pending }))
								: !synced
									? turning(t("sync.catchingUp"))
									: {
											key: "ok",
											icon: Cloud,
											label: t("sync.ok"),
											hint: t("app.clickCheck"),
											run: () => void lookForUpdate(),
										};
	return (
		<Tip
			className="max-w-64"
			label={
				look.hint ? (
					<>
						<span className="block">{look.label}</span>
						<span className="block opacity-70">{look.hint}</span>
					</>
				) : (
					look.label
				)
			}
			side="top"
		>
			<Button
				aria-disabled={!look.run}
				aria-label={look.label}
				className={cn(
					"tap inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-hover",
					look.tone ?? "text-muted-foreground hover:text-fg",
					!look.run && "cursor-default",
					className,
				)}
				data-status={look.key}
				onClick={look.run}
				variant="plain"
			>
				<SwapIcon look={{ key: look.key, icon: look.icon, turn: look.turn }} />
			</Button>
		</Tip>
	);
}

type IconLook = { key: string; icon: typeof Cloud; turn?: boolean };
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A new icon waits until the old one has shrunk away (.icon-shrink), then grows in (.icon-grow). */
function SwapIcon({ look }: { look: IconLook }) {
	const [shown, setShown] = useState(look);
	const [leaving, setLeaving] = useState(false);
	const [changed, setChanged] = useState(false); // the first icon is just there, without growing in
	const latest = useRef(look);
	latest.current = look;
	// something asked to turn while the old icon went: it turns (once at least) even if done already
	const asked = useRef<IconLook | null>(null);
	if (look.turn && look.key !== shown.key) asked.current = look;
	// since when the shown icon turns: it goes only after whole turns, upright
	const turning = useRef(0);
	useEffect(
		() => void (turning.current = shown.turn ? performance.now() : 0),
		[shown.key, shown.turn],
	);
	useEffect(() => {
		if (look.key === shown.key) return setShown(look); // same icon (it may turn or not)
		if (still()) return setShown(look);
		const go = () => (setLeaving(true), setChanged(true));
		if (!turning.current) return go();
		const turned = performance.now() - turning.current;
		const timer = setTimeout(go, Math.max(1, Math.ceil(turned / TURN)) * TURN - turned);
		return () => clearTimeout(timer);
	}, [look.key, look.turn, shown.key]);
	const Icon = shown.icon;
	return (
		<span
			className={leaving ? "icon-shrink" : changed ? "icon-grow" : "inline-flex"}
			key={shown.key + (leaving ? ":out" : "")}
			onAnimationEnd={(e) => {
				if (!leaving || e.target !== e.currentTarget) return; // the turning icon inside has its own animation
				setLeaving(false);
				setShown(latest.current.turn ? latest.current : (asked.current ?? latest.current));
				asked.current = null;
			}}
		>
			<Icon className={cn(shown.turn && "animate-spin")} size={17} />
		</span>
	);
}
