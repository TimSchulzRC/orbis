// The replica every component reads and writes: the workspace open in the app. Switching the
// workspace (accounts.ts) points `repo` at another replica and renders the app anew.
import type { Repo } from "@obtion/sync";

export let repo: Repo;
export function setRepo(r: Repo) {
  repo = r;
}
