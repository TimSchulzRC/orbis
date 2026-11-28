// HTTP calls to an Orbis server. The app sends no Origin header and no cookies (credentials
// "omit"): the server treats such a request like one from its own page, so any server works
// without being told about the app. The account's token goes in the Authorization header.

import type { ErrorBody } from "@orbis/core/api";

export class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
	}
}

const TIMEOUT_MS = 20_000;

/** "notes.example.org" → "https://notes.example.org"; an invite or page link → its server. */
export function serverUrl(input: string): string {
	let s = input.trim();
	if (!s) return "";
	if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
	const m = s.match(/^(https?):\/\/([^/?#]+)/i);
	return m ? `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}` : "";
}

export async function call<R>(
	server: string,
	path: string,
	opts: { body?: unknown; method?: string; token?: string } = {},
): Promise<R> {
	const { body, token } = opts;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(server + path, {
			method: opts.method ?? (body === undefined ? "GET" : "POST"),
			credentials: "omit",
			headers: {
				accept: "application/json",
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
		});
		const data: unknown = await res.json().catch(() => ({}));
		if (!res.ok)
			throw new ApiError(
				(data as Partial<ErrorBody> | null)?.error ?? (res.statusText || `HTTP ${res.status}`),
				res.status,
			);
		return data as R;
	} finally {
		clearTimeout(timer);
	}
}

/** Offline or no answer: no status. */
export const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : undefined);

/** "https://notes.example.org" → "notes.example.org", how the app names a server. */
export const hostOf = (server: string) => server.replace(/^https?:\/\//, "");
