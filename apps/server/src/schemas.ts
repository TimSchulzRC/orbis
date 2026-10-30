// What agents give the tools, once: the MCP server checks it with these schemas, the operations
// (ops.ts) take the types inferred from them.
import { z } from "zod";
import { PROP_KINDS, type ViewKind } from "@obtion/core/model";

/** The kinds of view of a type's page (core has the type ViewKind, but no list of them). */
export const VIEW_KINDS = ["table", "board", "list", "calendar", "timeline", "gallery", "triage", "tree"] as const satisfies readonly ViewKind[];

/** Property values by property name. */
const values = z.record(z.string(), z.any());

/** A view (tab) of a type's page: its own filter and look in query text. */
export const viewInput = z.object({
  name: z.string().optional(),
  view: z.enum(VIEW_KINDS).optional(),
  query: z.string().optional().describe('filter added to the type, plus sort:, group: (status|statusgroup|type|project|area|path|property), columns:, e.g. "status:active group:status sort:due columns:Status,area,Period,Progress"'),
  subgroup: z.string().optional().describe("boards: rows by this field (e.g. project)"),
  hide_empty_groups: z.boolean().optional(),
  hidden_groups: z.array(z.string()).optional().describe('groups to hide by name, e.g. ["Backlog", "Erledigt"]'),
  date: z.string().optional().describe("calendar/timeline: the date property"),
});
export type ViewInput = z.infer<typeof viewInput>;

export const propInput = z.object({
  name: z.string().optional(),
  kind: z.enum(PROP_KINDS).optional(),
  description: z.string().optional(),
  options: z.array(z.string()).optional().describe('for select/status: names; status options as "Name (todo|active|done)"'),
  multiple: z.boolean().optional(),
  target: z.string().optional().describe("relation target as a query, e.g. type:Person"),
  inverse: z.string().optional().describe("name shown on the target, e.g. Books"),
  symmetric: z.boolean().optional(),
  range: z.boolean().optional(),
  computed: z.string().optional().describe('"progress", "progress:Type" or "count:Type"'),
  hide_empty: z.boolean().optional().describe("pages show it only when it has a value (default: every property shows, empty as –)"),
});
export type PropInput = z.infer<typeof propInput>;

export const capInput = z.object({
  status: z.string().nullable().optional().describe("name of a status property"),
  due_date: z.string().nullable().optional().describe("name of a date property"),
  progress: z.union([z.boolean(), z.string()]).nullable().optional().describe("true, or a type name to count only that type"),
  updates: z.boolean().optional(),
  main_action: z.string().nullable().optional().describe('type name of the children "+" creates on its page'),
  template: z.string().nullable().optional(),
});
export type CapInput = z.infer<typeof capInput>;

export const createInput = z.object({
  title: z.string(),
  type: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(),
  parents: z.array(z.string()).optional(),
  pin: z.boolean().optional().describe("pin to the top of the sidebar (a place of its own)"),
  properties: values.optional(),
  free_properties: values.optional(),
});
export type CreateInput = z.infer<typeof createInput>;

export const updateInput = z.object({
  ref: z.string(),
  title: z.string().optional(),
  type: z.string().nullable().optional(),
  properties: values.optional(),
  free_properties: values.optional(),
  tags_add: z.array(z.string()).optional(),
  tags_remove: z.array(z.string()).optional(),
  refs_add: z.array(z.string()).optional(),
  refs_remove: z.array(z.string()).optional(),
  body: z.string().optional(),
  body_mode: z.enum(["replace", "append", "prepend"]).optional(),
  old_text: z.string().optional(),
  new_text: z.string().optional(),
});
export type UpdateInput = Omit<z.infer<typeof updateInput>, "ref">;

export const placeInput = z.object({ ref: z.string(), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional(), home: z.string().optional(), pin: z.boolean().optional() });
export type PlaceInput = Omit<z.infer<typeof placeInput>, "ref">;

export const suggestInput = z.object({ ref: z.string(), type: z.string().optional(), parents: z.array(z.string()).optional(), properties: values.optional(), note: z.string().optional() });
export type SuggestInput = Omit<z.infer<typeof suggestInput>, "ref">;

export const defineTypeInput = z.object({ name: z.string(), description: z.string().optional(), icon: z.string().optional(), color: z.string().optional(), properties: z.array(propInput).optional(), capabilities: capInput.optional() });
export type DefineTypeInput = z.infer<typeof defineTypeInput>;

export const updateTypeInput = z.object({
  type: z.string(),
  delete_preview: z.boolean().optional(),
  name: z.string().optional(),
  plural: z.string().optional(),
  views: z.array(viewInput).optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  add_properties: z.array(propInput).optional(),
  change_properties: z.array(propInput.extend({ property: z.string() })).optional(),
  remove_properties: z.array(z.string()).optional(),
  capabilities: capInput.optional(),
});
export type UpdateTypeInput = Omit<z.infer<typeof updateTypeInput>, "type" | "delete_preview">;

export const convertInput = z.object({ type: z.string(), direction: z.enum(["tag_to_type", "type_to_tag"]), tag: z.string().optional() });
export type ConvertInput = z.infer<typeof convertInput>;

export const attachInput = z.object({
  name: z.string().describe("file name with extension"),
  url: z.string().optional(),
  base64: z.string().optional(),
  parent: z.string().optional().describe("the one place of the file (a file has exactly one parent)"),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type AttachInput = z.infer<typeof attachInput>;
