// One log for all workspaces, with its own workspace choice independent of the sidebar's.

import type { ActivityEvent } from "@obtion/core/protocol";
import { useState } from "react";
import { accountOf, spaceCall, useAccounts } from "../accounts";
import { useDocumentTitle, useOnChange } from "../hooks";
import { useT } from "../i18n";
import { groupBySteps, mergeEvents, StepGroup } from "../ui/ActivityFeed";
import { byMe, who } from "../ui/actor";
import { Button, Empty, Seg } from "../ui/primitives";
import { SpaceFilter, SpaceScope, useReplicas } from "../ui/Spaces";

/** Rows fetched per page of the log. */
const PAGE = 60;

type Placed = ActivityEvent & { space: string };

interface Fetched {
	events: ActivityEvent[];
	more: boolean;
	error: boolean;
}

export function Activity() {
	const { t } = useT();
	const { spaces } = useAccounts();
	// "you" is the account on the event's server
	const me = (space: string) => accountOf(spaces.find((s) => s.id === space)?.server)?.user;
	useDocumentTitle(t("nav.activity"));
	// null: all
	const [only, setOnly] = useState<string[] | null>(null);
	const ids = spaces.map((s) => s.id).filter((id) => !only || only.includes(id));
	const repos = useReplicas(ids);
	const [fetched, setFetched] = useState<Record<string, Fetched>>({});
	const [filter, setFilter] = useState<"all" | "agent" | "you">("all");
	const load = (space: string, before?: number) =>
		spaceCall<ActivityEvent[]>(
			space,
			`/api/activity?limit=${PAGE}${before ? `&before=${before}` : ""}`,
		).then(
			(list) =>
				setFetched((f) => ({
					...f,
					[space]: {
						events: before ? [...(f[space]?.events ?? []), ...list] : list,
						more: list.length === PAGE,
						error: false,
					},
				})),
			// a page that failed is still to fetch: "more" stays and tries the same one again
			() =>
				setFetched((f) => ({
					...f,
					[space]: { events: f[space]?.events ?? [], more: !!before, error: true },
				})),
		);
	const online = repos.map((r) => r.status.online).join();
	useOnChange(`${ids.join()} ${online}`, () => {
		for (const id of ids) void load(id);
	});
	// per workspace the fetched rows, then the live events that came since
	const logs = ids.map((id, n) => {
		const loaded = fetched[id];
		const events = mergeEvents(loaded?.events ?? [], repos[n]!.events);
		return { id, loaded, events };
	});
	// a workspace with more to fetch is complete only down to its oldest row: older rows of the others wait
	const cutoff = Math.max(
		0,
		...logs
			.filter((l) => l.loaded?.more)
			.map((l) => Math.min(...l.loaded!.events.map((e) => e.ts))),
	);
	const all: Placed[] = logs
		.flatMap((l) => l.events.map((e) => ({ ...e, space: l.id })))
		.filter((e) => e.ts >= cutoff)
		.filter((e) => {
			if (filter === "all") return true;
			const actor = who(e.origin, t);
			return filter === "agent" ? actor.agent : byMe(actor, me(e.space));
		})
		.sort((a, b) => b.ts - a.ts || b.id - a.id);
	const nameOf = (id: string) =>
		spaces.length > 1 ? spaces.find((s) => s.id === id)?.name : undefined;
	const nothing = logs.every((l) => l.loaded?.error && !l.events.length);
	return (
		<div className="page-read">
			<h1 className="page-title">{t("nav.activity")}</h1>
			<p className="mb-5 text-sm text-muted-foreground">{t("activity.intro")}</p>
			{/* one row: which workspaces on the left, who on the right (on a phone below, at the left) */}
			<div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
				<SpaceFilter className="m-0 min-w-0 px-0 md:m-0" onChange={setOnly} value={only} />
				<div className="sm:ml-auto">
					<Seg
						label={t("activity.filterLabel")}
						onChange={setFilter}
						options={(["all", "agent", "you"] as const).map((f) => ({
							value: f,
							label: t(`activity.filter.${f}`),
						}))}
						value={filter}
					/>
				</div>
			</div>
			{nothing ? (
				<Empty title={t("activity.offlineTitle")}>{t("activity.offline")}</Empty>
			) : (
				<ul className="space-y-4">
					{groupBySteps(all).map((g) => (
						<li className="flex gap-2.5 text-[15px]" key={`${g[0]!.space}:${g[0]!.id}`}>
							<SpaceScope id={g[0]!.space}>
								<StepGroup events={g} space={g[0]!.space} spaceName={nameOf(g[0]!.space)} />
							</SpaceScope>
						</li>
					))}
				</ul>
			)}
			{logs.some((l) => l.loaded?.more) && (
				<Button
					className="mt-6 text-sm text-muted-foreground hover:text-fg"
					onClick={() => {
						for (const l of logs)
							if (l.loaded?.more) void load(l.id, Math.min(...l.loaded.events.map((e) => e.id)));
					}}
					variant="plain"
				>
					{t("activity.more")}
				</Button>
			)}
		</div>
	);
}
