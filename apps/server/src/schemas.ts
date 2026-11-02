// Tool input schemas: the MCP server validates with them, ops.ts uses the inferred types.
import { z } from "zod";
import { PROP_KINDS, VIEW_KINDS } from "@obtion/core/model";

const values = z.record(z.string(), z.any());

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
  kind: z
    .enum([...PROP_KINDS, "status", "multiselect"])
    .optional()
    .describe('A select is the type\'s status when capabilities.status names it; "status" and "multiselect" still work as shorthands'),
  description: z.string().optional(),
  options: z.array(z.string()).optional().describe('for select: names; options of the status as "Name (todo|active|done)", a paused one as "Name (active, paused)", a dropped one as "Name (done, dropped)"'),
  multiple: z.boolean().optional().describe("relation: several targets; select: several options"),
  default: z.string().nullable().optional().describe("select with one value: the option new entries get; it can then not be emptied (the status always has one). null: may be empty"),
  target: z.string().optional().describe("relation target as a query, e.g. type:Person"),
  inverse: z.string().optional().describe("name shown on the target, e.g. Books"),
  symmetric: z.boolean().optional(),
  range: z.boolean().optional(),
  computed: z.string().optional().describe('"progress", "progress:Type" or "count:Type"'),
  hide_empty: z.boolean().optional().describe("pages show it only when it has a value (default: every property shows, empty as –)"),
  blocks: z.boolean().optional().describe("relation or text: the item counts as blocked while it is set (a relation: while a linked item is open)"),
});
export type PropInput = z.infer<typeof propInput>;

export const capInput = z.object({
  status: z.string().nullable().optional().describe("name of a select property with one value: becomes the status (options get groups, a default)"),
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
  source: z.string().max(1000).optional().describe('where the item came from, set once by importers, e.g. "repo:eInvoice/04_Projects/A/STATUS.md"; get shows it, search finds it'),
});
export type CreateInput = z.infer<typeof createInput>;

export const updateInput = z.object({
  ref: z.string(),
  title: z.string().optional(),
  type: z.string().nullable().optional(),
  properties: values.optional(),
  free_properties_remove: z.array(z.string()).optional().describe("names of free properties to remove (values left over from a removed type or property; new ones cannot be added)"),
  tags_add: z.array(z.string()).optional(),
  tags_remove: z.array(z.string()).optional(),
  refs_add: z.array(z.string()).optional(),
  refs_remove: z.array(z.string()).optional(),
  body: z.string().optional().describe("with body_mode: replace (the default) needs base_version"),
  body_mode: z.enum(["replace", "append", "prepend"]).optional(),
  old_text: z.string().optional().describe("exact text in the body to change (must occur once); safe without base_version"),
  new_text: z.string().optional(),
  base_version: z.string().optional().describe("the version from get or from the last write's answer. Required to replace the whole body; checked with any change when given. Stale: nothing changes, the answer says what changed since"),
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
  url: z.string().optional().describe("public http(s) address the server downloads the file from"),
  base64: z.string().optional().describe("the content, base64 – only for small files; local files go over the HTTP upload"),
  replace: z.string().optional().describe("id or title of an existing file: put the new content into it instead of creating a file (same item, the old content stays in its history)"),
  parent: z.string().optional().describe("the one place of the file (a file has exactly one parent)"),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type AttachInput = z.infer<typeof attachInput>;
