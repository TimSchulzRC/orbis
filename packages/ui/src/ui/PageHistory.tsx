// "Verlauf" in the side panel: every change to this one page from the server's activity log, as the
// activity page shows them, with the live ones. A text change can go back to the text before it.

import type { Item } from "@obtion/core/model";
import type { ActivityEvent } from "@obtion/core/protocol";
import { useMemo, useRef, useState } from "react";
import { accountOf, spaceById, spaceCall, useAccounts } from "../accounts";
import { useOnChange, useRepo } from "../hooks";
import { useT } from "../i18n";
import { groupBySteps, mergeEvents, StepGroup } from "./ActivityFeed";
import { Button } from "./primitives";

/** Rows fetched at a time. */
const PAGE = 50;

/** `failed`: the request that failed, to ask again (from the top, or below an id). */
type Got = {
	key: string;
	events: ActivityEvent[];
	more: boolean;
	error: boolean;
	busy: boolean;
	failed?: { before?: number };
};

/** The newest rows of the last pages seen: switching back shows them at once. */
const firstPages = new Map<string, ActivityEvent[]>();
const KEEP = 20;

function remember(key: string, list: ActivityEvent[]) {
	firstPages.delete(key);
	firstPages.set(key, list);
	if (firstPages.size > KEEP) firstPages.delete(firstPages.keys().next().value!);
}

const start = (key: string): Got => {
	const cached = firstPages.get(key);
	return { key, events: cached ?? [], more: cached?.length === PAGE, error: false, busy: !cached };
};

/** `space`: the workspace on the server. */
export function PageHistory({ item, space }: { item: Item; space: string }) {
	const { t } = useT();
	const r = useRepo();
	useAccounts();
	// the account on the workspace's server
	const me = accountOf(spaceById(space)?.server)?.user;
	// whose log: another account on this device never sees the rows kept for this one
	const key = `${me?.id}/${space}/${item.id}`;
	const [got, setGot] = useState<Got>(() => start(key));
	// only the latest request counts: an answer for the page before, or an older one, is dropped
	const asked = useRef(0);

	const load = (before?: number) => {
		const n = ++asked.current;
		setGot((g) => ({ ...(g.key === key ? g : start(key)), busy: true, error: false }));
		spaceCall<ActivityEvent[]>(
			space,
			`/api/activity?doc=${encodeURIComponent(item.id)}&limit=${PAGE}${before ? `&before=${before}` : ""}`,
		).then(
			(list) => {
				if (n !== asked.current) return;
				if (!before) remember(key, list);
				setGot((g) => {
					const kept = g.key === key ? g.events : [];
					if (before)
						return {
							key,
							events: [...kept, ...list],
							more: list.length === PAGE,
							error: false,
							busy: false,
						};
					// fetched from the top again (back online): the rows already there stay only when the new
					// ones reach them; otherwise there could be a gap between, so they start over
					const reach =
						!kept.length || list.length < PAGE || list.some((e) => e.id === kept[0]!.id);
					if (!reach) return { key, events: list, more: true, error: false, busy: false };
					const ids = new Set(list.map((e) => e.id));
					const older = kept.filter((e) => !ids.has(e.id));
					return {
						key,
						events: [...list, ...older],
						more: older.length ? g.more : list.length === PAGE,
						error: false,
						busy: false,
					};
				});
			},
			() =>
				n === asked.current &&
				setGot((g) => ({
					...(g.key === key ? g : start(key)),
					error: true,
					busy: false,
					failed: { before },
				})),
		);
	};
	// again when the page changes, and when back online (going offline changes nothing there)
	useOnChange(`${key} ${r.status.online}`, () => {
		if (r.status.online || got.key !== key || !got.events.length) load();
	});

	// the fetched rows and the live ones that came since, of this page only
	const fetched = got.key === key ? got.events : [];
	const events = useMemo(
		() =>
			mergeEvents(fetched, r.events)
				.filter((e) => e.doc === item.id)
				.sort((a, b) => b.ts - a.ts || b.id - a.id),
		[fetched, r.events, item.id],
	);
	const steps = useMemo(() => groupBySteps(events), [events]);

	// what an error means: offline, or the server did not answer as it should
	const failed = t(r.status.online ? "updates.failed" : "updates.offline");
	const retry = () => (
		<Button
			className="tap-y underline hover:text-fg"
			onClick={() => load(got.failed?.before)}
			variant="plain"
		>
			{t("updates.retry")}
		</Button>
	);

	if (!events.length)
		return (
			<div className="pt-1 text-sm text-muted-foreground">
				<p role="status">
					{got.busy || got.key !== key
						? t("history.loading")
						: got.error
							? failed
							: t("updates.noChanges")}
				</p>
				{got.error && !got.busy && <div className="mt-2">{retry()}</div>}
			</div>
		);

	const oldest = fetched.length ? Math.min(...fetched.map((e) => e.id)) : undefined;
	return (
		<div>
			<ul className="space-y-4">
				{steps.map((step) => (
					// keyed by its oldest entry: a step keeps its row (and an open comparison) when more of it comes in
					<li className="flex gap-2.5 text-[15px]" key={step.at(-1)!.id}>
						<StepGroup events={step} here={item.id} space={space} />
					</li>
				))}
			</ul>
			<div className="mt-4 flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
				<p role="status">
					{got.error ? `${failed} ${t("updates.partly")}` : got.busy ? t("history.loading") : ""}
				</p>
				{got.error && !got.busy && retry()}
				{got.more && !got.error && !got.busy && oldest !== undefined && (
					<Button className="tap-y hover:text-fg" onClick={() => load(oldest)} variant="plain">
						{t("updates.olderChanges")}
					</Button>
				)}
			</div>
		</div>
	);
}
