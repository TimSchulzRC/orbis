// Screens re-render when a workspace's data change: each replica counts its changes (version).

import type { Index } from "@orbis/core/graph";
import { SETTINGS_ID } from "@orbis/core/model";
import type { Repo } from "@orbis/sync";
import { useCallback, useSyncExternalStore } from "react";
import { replica, useSession, type Workspace } from "./session";

const none = () => () => undefined;
const zero = () => 0;

/**
 * The workspace's replica; the screen follows its changes. undefined once the account no longer
 * has the workspace (deleted, or left) while a page of it is still open.
 */
export function useRepo(space: string): Repo | undefined {
	useSession(); // a sign-in or a workspace list from the server changes the replicas
	const repo = replica(space);
	useSyncExternalStore(repo?.subscribe ?? none, repo?.getVersion ?? zero);
	return repo;
}

const ids = new WeakMap<Repo, number>();
let nextId = 0;
function idOf(repo: Repo): number {
	let id = ids.get(repo);
	if (id === undefined) {
		id = nextId++;
		ids.set(repo, id);
	}
	return id;
}

export interface Space {
	info: Workspace;
	repo: Repo;
	/** undefined until the workspace's data are here (set up). */
	ix: Index | undefined;
}

/** Every workspace of every account with its replica. */
export function useSpaces(): Space[] {
	const session = useSession();
	const infos = session?.spaces ?? [];
	const repos = infos.map((s) => replica(s.id)!);
	const key = repos.map(idOf).join();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` names exactly these replicas
	const subscribe = useCallback(
		(l: () => void) => {
			const offs = repos.map((r) => r.subscribe(l));
			return () => {
				for (const off of offs) off();
			};
		},
		[key],
	);
	useSyncExternalStore(subscribe, () => repos.map((r) => r.version).join());
	return infos.map((info, i) => {
		const repo = repos[i]!;
		return { info, repo, ix: repo.get(SETTINGS_ID) ? repo.index() : undefined };
	});
}

/** The workspaces the pages show: the one chosen in the switcher, or all of them. */
export function useShownSpaces(): Space[] {
	const session = useSession();
	const spaces = useSpaces();
	return session?.shown ? spaces.filter((s) => s.info.id === session.shown) : spaces;
}
