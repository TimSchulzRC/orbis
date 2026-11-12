// A workspace in memory for component tests: the replica the interface reads and writes, set up
// in German with the examples, never connected to a server.

import { writeExamples } from "@obtion/core/examples";
import { runSetup } from "@obtion/core/setup";
import { type ReplicaStorage, Repo, type SyncSocket } from "@obtion/sync";
import { type DeviceFiles, setFiles } from "../../packages/ui/src/files";
import { setRepo } from "../../packages/ui/src/repo";

const storage: ReplicaStorage = {
	open: async () => {},
	load: async () => ({ rows: [], outbox: [] }),
	compact: async () => {},
	write: async () => {},
	outbox: async () => [],
	drop: async () => {},
	serverId: async () => undefined,
	destroy: async () => {},
};

/** No file contents on this "device": every file counts as missing, nothing is fetched. */
export const noFiles = new Proxy(
	{ subscribe: () => () => {}, getVersion: () => 0, isMissing: () => true } as Record<
		string,
		unknown
	>,
	{
		get: (t, k) => t[k as string] ?? (async () => undefined),
	},
) as unknown as DeviceFiles;

const offline = (): SyncSocket => ({
	readyState: 0,
	send() {},
	close() {},
	onopen: null,
	onmessage: null,
	onclose: null,
	onerror: null,
});

/** A fresh workspace, set as the one the interface works on. */
export async function workspace(examples = true) {
	const repo = new Repo({
		storage,
		device: "test",
		connect: offline,
		post: async () => null,
		askOtherServer: async () => null,
		confirmDiscard: async () => false,
		tooNew() {},
		reload() {},
	});
	await repo.init();
	runSetup(repo.writer, "de", repo.origin);
	if (examples) writeExamples(repo.writer, "de", {});
	setRepo(repo);
	setFiles(noFiles);
	return repo;
}
