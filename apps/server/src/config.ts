import { resolve } from "node:path";

export const PORT = Number(process.env.PORT ?? 8480);
export const DATA = resolve(process.env.ORBIS_DATA ?? "data");

/** Upload limit for a file's content sent by a device. */
export const MAX_BLOB = 512 * 1024 * 1024;
/** Limit for a file an agent attaches (URL or base64). */
export const MAX_ATTACH = 50 * 1024 * 1024;
/** Limit for one sync WebSocket message, which may batch many updates. */
export const MAX_WS_MESSAGE = 64 * 1024 * 1024;
