// A step is one user action or tool call; its id sits on every log row it wrote. Undo resets each
// field the step changed to its value before the step, unless it changed again later. Documents
// the step created go to the trash. The undo is a step itself, so redo undoes the undo.
import * as Y from "yjs";
import type { Store } from "./store";
import { sameValue } from "@obtion/core/equal";
import { type UpdateEntry, DOC_MAPS, DOC_TEXTS, type DocText, metaMap, replaceText, touch } from "@obtion/core/model";
import type { UndoResult } from "@obtion/core/api";

export class UndoError extends Error {}

type Fields = Map<string, unknown>;

// flattened key by key further down
const NESTED = new Set<string>(["meta", "rels", "schema"]);

/** Keys are "area:key", values JSON-comparable. */
function fields(doc: Y.Doc): Fields {
  const out: Fields = new Map();
  const put = (k: string, v: unknown) => {
    if (v !== undefined) out.set(k, v instanceof Y.AbstractType ? v.toJSON() : v);
  };
  for (const [k, v] of metaMap(doc).entries()) if (k !== "updated") put("meta:" + k, v);
  for (const name of DOC_MAPS) if (!NESTED.has(name)) for (const [k, v] of doc.getMap<unknown>(name).entries()) put(`${name}:${k}`, v);
  for (const [prop, set] of doc.getMap<unknown>("rels").entries()) if (set instanceof Y.Map) for (const t of set.keys()) put(`rels:${prop}:${t}`, true);
  for (const name of DOC_TEXTS) {
    const text = doc.getText(name).toString();
    if (text) out.set(name, text);
  }
  for (const u of doc.getArray<UpdateEntry>("updates").toArray()) put("updates:" + u.id, u);
  for (const [k, v] of doc.getMap<unknown>("schema").entries()) {
    if (k === "properties" && v instanceof Y.Map) for (const [pid, p] of v.entries()) put("schema.prop:" + pid, p);
    else if (k === "capabilities" && v instanceof Y.Map) for (const [c, cv] of v.entries()) put("schema.cap:" + c, cv);
    else put("schema:" + k, v);
  }
  return out;
}

function toY(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const map = new Y.Map<unknown>();
    for (const [k, x] of Object.entries(v)) map.set(k, x);
    return map;
  }
  return v;
}

/** undefined removes the field. */
function writeField(doc: Y.Doc, key: string, value: unknown) {
  if ((DOC_TEXTS as readonly string[]).includes(key)) return replaceText(doc, key as DocText, (value as string) ?? "");
  const [area, ...rest] = key.split(":");
  const k = rest.join(":");
  if (area === "rels") {
    const [prop, target] = [rest[0]!, rest.slice(1).join(":")];
    const rels = doc.getMap<unknown>("rels");
    const set = rels.get(prop);
    if (value === undefined) return set instanceof Y.Map && set.delete(target);
    if (set instanceof Y.Map) return set.set(target, true);
    const fresh = new Y.Map<unknown>();
    rels.set(prop, fresh);
    return fresh.set(target, true);
  }
  if (area === "updates") {
    const arr = doc.getArray<UpdateEntry>("updates");
    const i = arr.toArray().findIndex((u: UpdateEntry) => u.id === k);
    if (value === undefined) return i >= 0 && arr.delete(i, 1);
    if (i < 0) arr.push([value as UpdateEntry]);
    return;
  }
  if (area === "schema.prop" || area === "schema.cap") {
    const schema = doc.getMap<unknown>("schema");
    const name = area === "schema.prop" ? "properties" : "capabilities";
    const found = schema.get(name);
    const map: Y.Map<unknown> = found instanceof Y.Map ? found : new Y.Map<unknown>();
    if (map !== found) schema.set(name, map);
    return value === undefined ? map.delete(k) : map.set(k, area === "schema.prop" ? toY(value) : value);
  }
  const map = doc.getMap<unknown>(area!);
  if (value === undefined) map.delete(k);
  else map.set(k, area === "tabs" ? toY(value) : value); // a tab is a map of its own
}

/** Takes back what `stepId` did to one document and notes it in `res`. */
function undoInDoc(store: Store, id: string, stepId: string, actor: string, res: UndoResult) {
  // the log reaches back LOG_WINDOW_MS at most (Store.compact), and rows after the step don't matter
  const rows = store.db.query("SELECT seq, data, step FROM updates WHERE doc = ?1 AND seq <= (SELECT MAX(seq) FROM updates WHERE doc = ?1 AND step = ?2) ORDER BY seq").all(id, stepId) as { seq: number; data: Uint8Array; step: string | null }[];
  const first = rows.find((r) => r.step === stepId)!.seq;
  // one replay: the rows before the step, then the step's own (other steps' rows in between stay out)
  const doc = new Y.Doc({ guid: id, gc: false });
  for (const r of rows) if (r.seq < first) Y.applyUpdate(doc, r.data);
  const before = fields(doc);
  for (const r of rows) if (r.step === stepId) Y.applyUpdate(doc, r.data);
  const after = fields(doc);
  const current = fields(store.getDoc(id));
  const createdByStep = !before.has("meta:kind");
  if (createdByStep) {
    if (current.get("meta:deleted") !== true) {
      store.change(id, actor, (doc) => metaMap(doc).set("deleted", true));
      res.trashed.push(id);
    }
    return;
  }
  const back: [string, unknown][] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const stepChanged = !sameValue(before.get(key), after.get(key));
    if (!stepChanged) continue;
    const changedSince = !sameValue(current.get(key), after.get(key));
    if (changedSince) {
      res.kept.push({ doc: id, field: key });
      continue;
    }
    back.push([key, before.get(key)]);
  }
  if (!back.length) return;
  store.change(id, actor, (doc) => {
    for (const [k, v] of back) writeField(doc, k, v);
    touch(doc);
  });
  res.changed.push(id);
}

export function undoStep(store: Store, stepId: string, actor: string): UndoResult {
  store.flush();
  const docs = store.db.query("SELECT DISTINCT doc FROM updates WHERE step = ?").all(stepId) as { doc: string }[];
  if (!docs.length) throw new UndoError(`Unknown step "${stepId}", or too old to undo.`);
  if (store.activeUndo(stepId)) throw new UndoError(`Step "${stepId}" is already undone.`);
  const res: UndoResult = { step: "", undid: stepId, changed: [], trashed: [], kept: [] };
  res.step = store.step(
    actor,
    (newStep) =>
      store.atomic(() => {
        for (const { doc: id } of docs) undoInDoc(store, id, stepId, actor, res);
        return newStep;
      }),
    { undoes: stepId },
  );
  store.flush();
  return res;
}

export function redoStep(store: Store, stepId: string, actor: string): UndoResult {
  const undo = store.activeUndo(stepId);
  if (!undo) throw new UndoError(`Step "${stepId}" is not undone.`);
  return undoStep(store, undo, actor);
}
