// Screens re-render when a workspace's data change: each replica counts its changes (version).

import type { WorkspaceInfo } from "@obtion/core/api";
import type { Index } from "@obtion/core/graph";
import { SETTINGS_ID } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { useCallback, useSyncExternalStore } from "react";
import { replica, useSession } from "./session";

/** The workspace's replica; the screen follows its changes. */
export function useRepo(space: string): Repo {
	useSession(); // a new sign-in replaces the replicas
	const repo = replica(space);
	useSyncExternalStore(repo.subscribe, repo.getVersion);
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
	info: WorkspaceInfo;
	repo: Repo;
	/** undefined until the workspace's data are here (set up). */
	ix: Index | undefined;
}

/** Every workspace of the account with its replica, for pages across workspaces. */
export function useSpaces(): Space[] {
	const session = useSession();
	const infos = session?.spaces ?? [];
	const repos = infos.map((s) => replica(s.id));
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
