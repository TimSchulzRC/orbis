import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../scripts/obtion-dev");

function fixture(
	run: (f: {
		root: string;
		other: string;
		log: string;
		exec: (action: string, fail?: boolean) => ReturnType<typeof Bun.spawnSync>;
	}) => void,
) {
	const dir = mkdtempSync(join(tmpdir(), "obtion-dev-test-"));
	const root = join(dir, "main");
	const other = join(dir, "other worktree");
	const bin = join(dir, "bin");
	const log = join(dir, "calls");
	mkdirSync(bin);
	for (const tree of [root, other]) {
		mkdirSync(join(tree, "apps/server/src"), { recursive: true });
		mkdirSync(join(tree, "data"));
		writeFileSync(join(tree, "apps/server/src/index.ts"), "");
		writeFileSync(join(tree, "data/accounts.db"), "fixture");
	}
	const mock = (name: string, body: string) =>
		writeFileSync(join(bin, name), "#!/bin/bash\nset -eu\n" + body, { mode: 0o755 });
	mock(
		"git",
		'if [[ $1 == rev-parse ]]; then printf "%s\\n" "$ROOT"; else printf "worktree %s\\0\\0worktree %s\\0\\0" "$ROOT" "$OTHER"; fi\n',
	);
	mock(
		"systemctl",
		'echo "$*" >> "$LOG"\ncase "$2" in\nlist-units) echo "obtion-dev-aaaaaaaaaaaaaaaa-backend.service loaded active running"; echo "unrelated.service loaded active running";;\nstop) [[ ${FAIL:-} != yes ]];;\nis-active) exit 1;;\nesac\n',
	);
	mock(
		"tailscale",
		'echo "$*" >> "$LOG"\nif [[ $* == "serve status --json" ]]; then echo \'{"Web":{"host:18443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:19000"}}}}}\'; fi\n',
	);
	const state = join(dir, "state/obtion-dev");
	mkdirSync(state, { recursive: true });
	writeFileSync(join(state, "aaaaaaaaaaaaaaaa.ports"), "18443 19000 20000 host\n");
	writeFileSync(join(state, "bbbbbbbbbbbbbbbb.ports"), "18444 19001 20001 host\n");
	try {
		run({
			root,
			other,
			log,
			exec: (action, fail = false) =>
				Bun.spawnSync(["bash", script, action], {
					cwd: root,
					env: {
						...process.env,
						PATH: bin + ":" + process.env.PATH,
						XDG_STATE_HOME: join(dir, "state"),
						ROOT: root,
						OTHER: other,
						LOG: log,
						FAIL: fail ? "yes" : "",
					},
				}),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("stop-all stops managed units and removes only matching forwarding rules, preserving data", () =>
	fixture(({ exec, log, root, other }) => {
		const result = exec("stop-all");
		expect(result.exitCode).toBe(0);
		const calls = readFileSync(log, "utf8");
		expect(calls).toContain("--user stop obtion-dev-aaaaaaaaaaaaaaaa-backend.service");
		expect(calls).not.toContain("--user stop unrelated.service");
		expect(calls).toContain("serve --yes --https=18443 off");
		expect(calls).not.toContain("--https=18444 off");
		expect(existsSync(join(root, "data/accounts.db"))).toBe(true);
		expect(existsSync(join(other, "data/accounts.db"))).toBe(true);
	}));

test("reset-all clears data across worktrees, including paths with spaces", () =>
	fixture(({ exec, root, other }) => {
		expect(exec("reset-all").exitCode).toBe(0);
		expect(existsSync(join(root, "data"))).toBe(false);
		expect(existsSync(join(other, "data"))).toBe(false);
		expect(existsSync(join(root, "apps/server/src/index.ts"))).toBe(true);
		expect(exec("reset-all").exitCode).toBe(0);
	}));

test("reset-all preserves all data if stopping a service fails", () =>
	fixture(({ exec, root, other }) => {
		expect(exec("reset-all", true).exitCode).not.toBe(0);
		expect(existsSync(join(root, "data/accounts.db"))).toBe(true);
		expect(existsSync(join(other, "data/accounts.db"))).toBe(true);
	}));

test("reset-all refuses symlinked data before making changes", () =>
	fixture(({ exec, root, other, log }) => {
		rmSync(join(other, "data"), { recursive: true });
		symlinkSync(join(root, "data"), join(other, "data"));
		expect(exec("reset-all").exitCode).not.toBe(0);
		expect(existsSync(join(root, "data/accounts.db"))).toBe(true);
		expect(existsSync(log)).toBe(false);
	}));
