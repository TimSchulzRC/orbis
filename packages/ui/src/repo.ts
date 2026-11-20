// The open workspace's replica. Switching workspaces repoints it and re-renders the app.
import type { Repo } from "@orbis/sync";

export let repo: Repo;
export function setRepo(r: Repo) {
	repo = r;
}
