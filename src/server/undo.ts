// Undo per step. A step is one user action or one tool call (its id sits on every log row it
// wrote, across documents). Undo takes back field by field what the step changed:
//   before = the document from the log rows before the step, after = before + the step's rows.
//   A field the step changed goes back to its "before" value – unless it was changed again
//   later, then the newer value stays. A document the step created goes to the trash.
// The undo is itself a step (steps.undoes), so undoing it again is "Wiederholen".
import * as Y from "yjs";
import type { Store } from "./store";
import { replaceBody } from "../shared/model";

export class UndoError extends Error {}

export interface UndoResult {
  step: string; // the new step that did the undo
  undid: string; // the step that was taken back
  changed: string[]; // documents changed back
  trashed: string[]; // documents the step had created
  kept: { doc: string; field: string }[]; // changed again later: newer value kept
}

type Fields = Map<string, unknown>;

/** Every field of a document as "area:key" → JSON-comparable value. */
function fields(doc: Y.Doc): Fields {
  const out: Fields = new Map();
  const put = (k: string, v: unknown) => {
    if (v !== undefined) out.set(k, v instanceof Y.AbstractType ? v.toJSON() : v);
  };
  for (const [k, v] of doc.getMap<any>("meta").entries()) if (k !== "updated") put("meta:" + k, v);
  for (const name of ["parents", "props", "extra", "tags", "refs", "views", "file", "op", "settings", "query", "view", "tabs", "pin"])
    for (const [k, v] of doc.getMap<any>(name).entries()) put(`${name}:${k}`, v);
  for (const [prop, set] of doc.getMap<any>("rels").entries()) if (set instanceof Y.Map) for (const t of set.keys()) put(`rels:${prop}:${t}`, true);
  const body = doc.getText("body").toString();
  if (body) out.set("body", body);
  for (const u of doc.getArray<any>("updates").toArray()) put("updates:" + u.id, u);
  const schema = doc.getMap<any>("schema");
  for (const [k, v] of schema.entries()) {
    if (k === "properties" && v instanceof Y.Map) for (const [pid, p] of v.entries()) put("schema.prop:" + pid, p);
    else if (k === "capabilities" && v instanceof Y.Map) for (const [c, cv] of v.entries()) put("schema.cap:" + c, cv);
    else put("schema:" + k, v);
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function toY(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const m = new Y.Map<unknown>();
    for (const [k, x] of Object.entries(v)) m.set(k, x);
    return m;
  }
  return v;
}

/** Write one field back (undefined = remove). */
function writeField(doc: Y.Doc, key: string, value: unknown) {
  if (key === "body") return replaceBody(doc, (value as string) ?? "");
  const [area, ...rest] = key.split(":");
  const k = rest.join(":");
  if (area === "rels") {
    const [prop, target] = [rest[0]!, rest.slice(1).join(":")];
    const rels = doc.getMap<any>("rels");
    let set = rels.get(prop);
    if (value === undefined) return set instanceof Y.Map && set.delete(target);
    if (!(set instanceof Y.Map)) rels.set(prop, (set = new Y.Map()));
    return set.set(target, true);
  }
  if (area === "updates") {
    const arr = doc.getArray<any>("updates");
    const i = arr.toArray().findIndex((u) => u.id === k);
    if (value === undefined) return i >= 0 && arr.delete(i, 1);
    if (i < 0) arr.push([value]);
    return;
  }
  if (area === "schema.prop" || area === "schema.cap") {
    const schema = doc.getMap<any>("schema");
    const name = area === "schema.prop" ? "properties" : "capabilities";
    let m = schema.get(name);
    if (!(m instanceof Y.Map)) schema.set(name, (m = new Y.Map()));
    return value === undefined ? m.delete(k) : m.set(k, area === "schema.prop" ? toY(value) : value);
  }
  const map = doc.getMap<any>(area === "schema" ? "schema" : area!);
  if (value === undefined) map.delete(k);
  else map.set(k, area === "tabs" ? toY(value) : value); // a tab is a map of its own
}

function replay(rows: { data: Uint8Array }[], id: string): Y.Doc {
  const d = new Y.Doc({ guid: id, gc: false });
  for (const r of rows) Y.applyUpdate(d, r.data);
  return d;
}

/** Take back a step. Throws UndoError if it is unknown or already undone. */
export function undoStep(store: Store, stepId: string, actor: string): UndoResult {
  store.flush();
  const docs = store.db.query("SELECT DISTINCT doc FROM updates WHERE step = ?").all(stepId) as { doc: string }[];
  if (!docs.length) throw new UndoError(`Unknown step "${stepId}".`);
  if (store.activeUndo(stepId)) throw new UndoError(`Step "${stepId}" is already undone.`);
  const res: UndoResult = { step: "", undid: stepId, changed: [], trashed: [], kept: [] };
  res.step = store.step(
    actor,
    (newStep) =>
      store.atomic(() => {
        for (const { doc: id } of docs) {
          const rows = store.db.query("SELECT seq, data, step FROM updates WHERE doc = ? ORDER BY seq").all(id) as { seq: number; data: Uint8Array; step: string | null }[];
          const first = rows.find((r) => r.step === stepId)!.seq;
          const beforeRows = rows.filter((r) => r.seq < first);
          const before = fields(replay(beforeRows, id));
          const after = fields(replay([...beforeRows, ...rows.filter((r) => r.step === stepId)], id));
          const current = fields(store.getDoc(id));
          if (!before.has("meta:kind")) {
            // created in this step: to the trash (unless it is there already)
            if (current.get("meta:deleted") !== true) {
              store.change(id, actor, (doc) => doc.getMap<any>("meta").set("deleted", true));
              res.trashed.push(id);
            }
            continue;
          }
          const back: [string, unknown][] = [];
          for (const key of new Set([...before.keys(), ...after.keys()])) {
            if (same(before.get(key), after.get(key))) continue; // the step did not touch it
            if (!same(current.get(key), after.get(key))) {
              res.kept.push({ doc: id, field: key });
              continue;
            }
            back.push([key, before.get(key)]);
          }
          if (!back.length) continue;
          store.change(id, actor, (doc) => {
            for (const [k, v] of back) writeField(doc, k, v);
            doc.getMap<any>("meta").set("updated", Date.now());
          });
          res.changed.push(id);
        }
        return newStep;
      }),
    { undoes: stepId },
  );
  store.flush();
  return res;
}

/** Redo = undo the undo that currently takes the step back. */
export function redoStep(store: Store, stepId: string, actor: string): UndoResult {
  const u = store.activeUndo(stepId);
  if (!u) throw new UndoError(`Step "${stepId}" is not undone.`);
  return undoStep(store, u, actor);
}
