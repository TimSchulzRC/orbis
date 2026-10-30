// What the server and the CLI share: where they listen, where the data live, how large things get.
import { resolve } from "node:path";

export const PORT = Number(process.env.PORT ?? 8480);
export const DATA = resolve(process.env.OBTION_DATA ?? "data");

/** A file's content, uploaded by a device. */
export const MAX_BLOB = 512 * 1024 * 1024;
/** A file an agent attaches (attach tool: from a URL or base64). */
export const MAX_ATTACH = 50 * 1024 * 1024;
/** One message on the sync WebSocket (a push of many updates). */
export const MAX_WS_MESSAGE = 64 * 1024 * 1024;
