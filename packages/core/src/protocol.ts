// Sync protocol between replicas (browser, later desktop/mobile) and the hub.
//
// The hub keeps an append-only log of Yjs updates, each with a sequence number.
// A replica remembers the last sequence it has seen. On connect it says `hello`
// with that number and the id of the log row there (`sinceId`) and receives everything
// newer. If the hub no longer has that row – it was restored from an older backup, even if
// other devices have pushed it past the old number since – it answers with `reset`, and
// the replica uploads its full state. Its own offline changes sit
// in a local outbox and are pushed until acknowledged. Yjs updates are
// idempotent and commutative, so re-sending or re-receiving is always safe.
//
// All of it runs per area (see PERSONAL in model.ts): a replica says hello for each area it
// holds, and every message names its area. Messages without one (apps from before areas) mean
// the personal area.

export interface WireUpdate {
  s?: number; // hub sequence (server -> client)
  d: string; // doc id
  u: string; // base64 Yjs update
  o?: string; // origin (who made the change)
}

export type ClientMsg =
  | { t: "hello"; area?: string; since: number; sinceId?: string; client: string; device?: string }
  | { t: "push"; area?: string; items: { k: string; d: string; u: string; s?: string }[] } // s: the step (user action) it belongs to
  | { t: "ping" };

export type ServerMsg =
  | { t: "welcome"; hub: string; area: string; seq: number; format: number }
  | { t: "denied"; area: string } // an area this device may not sync
  | { t: "updates"; area: string; items: WireUpdate[]; last: number; lastId?: string; initial?: boolean; done?: boolean; reset?: boolean }
  | { t: "ack"; area: string; keys: string[]; last: number; lastId?: string }
  | { t: "event"; event: ActivityEvent }
  | { t: "blob"; hash: string } // a file content arrived on the hub
  | { t: "pong" };

export interface FieldChange {
  field: string;
  from?: unknown;
  to?: unknown;
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
  /** One user action or tool call; undone together (see undo.ts). */
  step?: string;
  /** This step undoes another step. */
  undoes?: string;
  /** This step is undone right now. */
  undone?: boolean;
  /** This step undoes an undo: it is a redo. */
  redo?: boolean;
}

export function toB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
