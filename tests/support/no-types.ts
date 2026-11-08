// Deletes every type in OBTION_DATA the way the app does (values stay as free properties).
// For the browser smoke test: the app has to run with zero types. Never point it at data/.
import { resolve } from "node:path";
import { Store } from "@obtion/server/store";
import { workspaceDirs } from "./server";
import { storeWriter } from "@obtion/server/setup";
import { deleteType } from "@obtion/core/typeops";

const dir = process.env.OBTION_DATA;
if (!dir || resolve(dir) === resolve(import.meta.dir, "../../data")) throw new Error("set OBTION_DATA to a test directory");
const [ws] = workspaceDirs(dir);
if (!ws) throw new Error("no workspace in OBTION_DATA");
const store = new Store(ws);
const w = storeWriter(store, "system:test");
for (const id of [...store.index().types.keys()]) deleteType(w, store.index(), id, { mode: "remove" }, "test");
store.flush();
console.log(`types left: ${store.index().types.size}`);
