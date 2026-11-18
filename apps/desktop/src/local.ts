// The server on this device: the same program as on a NAS (apps/server), started by the app,
// headless (no web app), on 127.0.0.1 only, its data in the app's folder. Its one account is
// the app's own: made at the first start, signed in at every start. Local workspaces live here,
// so they work without a network; the window syncs with it like with any server.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { AccountInfo, ServerInfo, SignedIn, User } from "@obtion/core/api";

/** The account of the server on this device, as kept in the app's folder (never shown to the user). */
interface Saved {
	port?: number;
	email?: string;
	password?: string;
	token?: string;
}

export interface Local {
	url: string;
	token: string;
	user: User;
}

/** Preferred port of the server on this device: an MCP address that stays the same across starts. */
const FIRST_PORT = 48480;

function free(port: number): Promise<boolean> {
	return new Promise((res) => {
		const s = createServer();
		s.once("error", () => res(false));
		s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
	});
}

async function choosePort(saved?: number): Promise<number> {
	for (const p of [saved, FIRST_PORT, FIRST_PORT + 1, FIRST_PORT + 2].filter(
		(p): p is number => !!p,
	))
		if (await free(p)) return p;
	return new Promise((res) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => res(port));
		});
	});
}

/** The user's full name as the system knows it (macOS: "Tim Schulz"), else the login name. */
function fullName(): string {
	try {
		if (process.platform === "darwin")
			return execFileSync("id", ["-F"], { encoding: "utf8" }).trim();
		if (process.platform === "linux")
			return execFileSync("getent", ["passwd", userInfo().username], { encoding: "utf8" })
				.split(":")[4]!
				.split(",")[0]!
				.trim();
	} catch {
		// no full name on this system: the account takes the user name
	}
	return "";
}

/** A request to the server on this device: its status and JSON. */
type Answer<R> = { ok: boolean; status: number; data: R };

export class LocalServer {
	private proc: ChildProcess | null = null;
	private saved: Saved;
	private file: string;
	private stopping = false;
	url = "";
	local: Local | null = null;

	constructor(
		private dir: string,
		/** How to run the server: the compiled program, or bun with its source in development. */
		private command: { cmd: string; args: string[] },
		private env: Record<string, string>,
	) {
		mkdirSync(dir, { recursive: true });
		this.file = join(dir, "local.json");
		this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
	}

	private save() {
		writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
	}

	/** Start the server and sign its account in; resolves once both are done. */
	async start(lang: string): Promise<Local> {
		const port = await choosePort(this.saved.port);
		if (port !== this.saved.port) {
			this.saved.port = port;
			this.save();
		}
		this.url = `http://127.0.0.1:${port}`;
		this.spawn(port);
		await this.ready();
		this.local = await this.signIn(lang);
		return this.local;
	}

	private spawn(port: number) {
		mkdirSync(join(this.dir, "logs"), { recursive: true });
		const log = createWriteStream(join(this.dir, "logs", "server.log"), { flags: "a" });
		const proc = spawn(this.command.cmd, this.command.args, {
			env: {
				...process.env,
				...this.env,
				HOST: "127.0.0.1",
				PORT: String(port),
				OBTION_DATA: join(this.dir, "data"),
				OBTION_WEB_APP: "off",
				OBTION_SIGNUP: "off",
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		proc.stdout?.pipe(log);
		proc.stderr?.pipe(log);
		// it ended without being asked to: start it again (the window keeps its copy and catches up)
		proc.on("exit", (code) => {
			log.end();
			if (this.proc === proc && !this.stopping) {
				console.error(`[obtion] the server on this device ended (${code}); starting it again`);
				setTimeout(() => !this.stopping && this.spawn(port), 1000);
			}
		});
		this.proc = proc;
	}

	private async ready() {
		for (let i = 0; i < 300; i++) {
			if (
				await fetch(`${this.url}/api/info`).then(
					(r) => r.ok,
					() => false,
				)
			)
				return;
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(
			`The server on this device did not start (see ${join(this.dir, "logs", "server.log")}).`,
		);
	}

	private async call<R>(path: string, body?: unknown, token?: string): Promise<Answer<R>> {
		const res = await fetch(this.url + path, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as R };
	}

	/** The account's session: the one kept if it still counts, else a new sign-in (made at the first start). */
	async signIn(lang: string, fresh = false): Promise<Local> {
		if (this.saved.token && !fresh) {
			const me = await this.call<AccountInfo>("/api/account", undefined, this.saved.token);
			if (me.ok) return { url: this.url, token: this.saved.token, user: me.data.user };
		}
		const info = (await this.call<ServerInfo>("/api/info")).data;
		let res: Answer<SignedIn>;
		if (info.firstAccount || !this.saved.email) {
			// the first start (or its data were removed): the account is made, with a password nobody types
			this.saved.email = "me@obtion.local";
			this.saved.password = randomBytes(24).toString("base64url");
			res = await this.call<SignedIn>("/api/account/signup", {
				name: fullName() || userInfo().username,
				email: this.saved.email,
				password: this.saved.password,
				lang,
			});
		} else
			res = await this.call<SignedIn>("/api/auth/sign-in/email", {
				email: this.saved.email,
				password: this.saved.password,
			});
		if (!res.ok) throw new Error(`Could not sign in to the server on this device (${res.status}).`);
		this.saved.token = res.data.token;
		this.save();
		this.local = { url: this.url, token: res.data.token, user: res.data.user };
		return this.local;
	}

	stop() {
		this.stopping = true;
		this.proc?.kill();
	}
}
