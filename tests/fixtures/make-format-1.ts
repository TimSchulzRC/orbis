// Made once, on 27.10.2026, to freeze data of format 1 (tests/format.test.ts). Do not run again
// for this format; a new format gets its own fixture.
import * as Y from "yjs";
import { MemRepo } from "../helpers";
import { runSetup } from "@obtion/core/setup";
import { exampleFiles, fileFacts, writeExamples } from "@obtion/core/examples";
import { sha256 } from "@obtion/hub/blobs";
import { toB64 } from "@obtion/core/protocol";

const m = new MemRepo();
runSetup(m.writer, "de");
writeExamples(m.writer, "de", Object.fromEntries(exampleFiles("de").map((f) => [f.key, fileFacts(f, sha256(f.bytes))])), Date.UTC(2026, 9, 27, 12));
const docs = Object.fromEntries([...m.docs].map(([id, d]) => [id, toB64(Y.encodeStateAsUpdate(d))]));
await Bun.write(`${import.meta.dir}/format-1.json`, JSON.stringify({ format: 1, written: "2026-10-27", docs }, null, 1) + "\n");
