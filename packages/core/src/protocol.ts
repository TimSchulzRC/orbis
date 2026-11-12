// Sync protocol between replicas and the server.
//
// The server keeps a log of Yjs updates with sequence numbers. A replica says `hello` with the last
// sequence it saw and that row's id (`sinceId`) and receives everything newer. If the server no
// longer has that row (folded into a newer one after two weeks, or restored from an older backup,
// even if others pushed it past the old number since), it answers with `reset` and the replica
// uploads its full state. Offline changes sit in a local outbox until acked. Yjs updates are
// idempotent and commutative, so re-sending is safe.
//
// Everything runs per area.

export interface WireUpdate {
	s?: number; // server sequence (server -> client)
	d: string; // doc id
	u: string; // base64 Yjs update
	o?: string; // origin (who made the change)
}

/** k: outbox key (acks name it); s: the step (user action) it belongs to. */
export interface PushItem {
	k: string;
	d: string;
	u: string;
	s?: string;
}

export type ClientMsg =
	| { t: "hello"; area: string; since: number; sinceId?: string; device?: string }
	| { t: "push"; area: string; items: PushItem[] }
	| { t: "ping" };

export type ServerMsg =
	| { t: "welcome"; server: string; area: string; seq: number; format: number } // server: the server id
	| { t: "denied"; area: string } // an area this device may not sync
	| {
			t: "updates";
			area: string;
			items: WireUpdate[];
			last: number;
			lastId?: string;
			initial?: boolean;
			done?: boolean;
			reset?: boolean;
	  }
	| { t: "ack"; area: string; keys: string[]; last: number; lastId?: string }
	| { t: "event"; event: ActivityEvent }
	| { t: "blob"; hash: string } // a file content arrived on the server
	| { t: "purged"; area: string; ids: string[] } // documents deleted for good: drop them, never send them again
	| { t: "pong" };

export interface FieldChange {
	field: string;
	from?: unknown;
	to?: unknown;
	/** a body change whose text versions are kept: GET /api/history?event=<id> shows the diff */
	diff?: boolean;
	/** "update": the update's id; `to` its text when written, `from` when deleted */
	id?: string;
}

export interface ActivityEvent {
	id: number;
	ts: number;
	doc: string;
	title: string;
	type: string;
	kind: "created" | "updated" | "deleted" | "restored";
	origin: string;
	changes: FieldChange[];
	/** One user action or tool call; undone together. */
	step?: string;
	undoes?: string;
	/** The step undoes an undo. */
	redo?: boolean;
}

// String.fromCharCode(...bytes) overflows the argument limit on large arrays
const B64_CHUNK = 0x8000;

export function toB64(u: Uint8Array): string {
	let s = "";
	for (let i = 0; i < u.length; i += B64_CHUNK)
		s += String.fromCharCode(...u.subarray(i, i + B64_CHUNK));
	return btoa(s);
}
export function fromB64(s: string): Uint8Array {
	const bin = atob(s);
	const u = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
	return u;
}
