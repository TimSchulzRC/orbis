// Deletes every type in ORBIS_DATA the way the app does (values stay as free properties).
// For the browser smoke test: the app has to run with zero types. Never point it at data/.
import { resolve } from "node:path";
import { deleteType } from "@orbis/core/typeops";
import { storeWriter } from "@orbis/server/setup";
import { Store } from "@orbis/server/store";
import { workspaceDirs } from "./server";

const dir = process.env.ORBIS_DATA;
if (!dir || resolve(dir) === resolve(import.meta.dir, "../../data"))
	throw new Error("set ORBIS_DATA to a test directory");
const [ws] = workspaceDirs(dir);
if (!ws) throw new Error("no workspace in ORBIS_DATA");
const store = new Store(ws);
const w = storeWriter(store, "system:test");
for (const id of [...store.index().types.keys()])
	deleteType(w, store.index(), id, { mode: "remove" }, "test");
store.flush();
console.log(`types left: ${store.index().types.size}`);
