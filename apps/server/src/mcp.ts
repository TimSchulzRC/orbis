// MCP endpoint (Streamable HTTP, stateless). Every agent – Claude Code, Claude Desktop,
// and other MCP clients – works through these tools. They know no type by name: the agent reads
// `schema` first and follows the types' descriptions and capabilities.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { todayISO } from "@obtion/core/model";
import { InputError } from "@obtion/core/input";
import { UndoError, redoStep, undoStep } from "./undo";
import { OpError, Ops, QUERY_HELP } from "./ops";
import { attachInput, convertInput, createInput, defineTypeInput, placeInput, suggestInput, updateInput, updateTypeInput } from "./schemas";
import type { Store } from "./store";
import type { Blobs } from "./blobs";

const INSTRUCTIONS = `Obtion is the user's personal system for knowledge and work: informations linked like Obsidian, projects and tasks like Notion, all in one graph. You are their interface: they tell you what happened, you record it; they ask, you answer from the data.

The model:
- Everything is an information (title, Markdown body, tags, refs) or a file. An information has at most one type. Types are data: call \`schema\` first – it lists every type with its description, properties (with options) and capabilities. Follow the descriptions. Never assume a type exists because of its name.
- "Part of" (place) builds the tree: an item can have several parents, one is its home. Any item with children is an overview – that is not a type. Links ([[Title]]) and refs are mentions; they connect without sorting. Relations are typed properties.
- Pinned items form the top of the sidebar (place with pin:true); pinning counts as a place.
- An information without a type, without a parent and not pinned is in the inbox (precisely: whatever the inbox query matches, see \`schema\`). Without a type but with a parent it is a note.
- Capabilities say what a type can do: a status with groups (todo/active/done), a due date ("Termin"), progress over descendants with a status, dated updates, a main action (which type "+" creates as a child).
- Every type has a page: the list of its entries with views as tabs (\`update_type\` views). Mixed lists are pages with query blocks. Query syntax: ${QUERY_HELP} In bodies, \`\`\`query <text>\`\`\` blocks are live lists.

Values are read tolerantly: a status as option name or group (open, active, done) in German or English, also synonyms like "in Arbeit" or "fertig"; dates as 2026-10-30, 30.10.2026, 10/30/2026, today/heute, tomorrow/morgen, a weekday or +3d; type names in singular or plural. "blocked" is not a status: use "Blockiert durch" or "Wartet auf". What can't be read is rejected with the reason – nothing is guessed.

How to work:
- For questions: \`query\` (structured) or \`search\` (full text), then \`get\` for details. Answer from the data and cite titles.
- When the user reports progress ("X: mapping done, review on Friday"): find the item, post \`add_update\` on the item whose type has updates (optionally with a status), tick off or change statuses with \`update\` (properties: {"Status": "…"}), create follow-ups with \`create\` using the type from the item's main action and parents=[the item], with the due date property if the type has one.
- New things: \`create\` with a type if one fits (read its description), otherwise without type (it lands in the inbox, which is fine). Use [[Title]] links to existing items (search first to reuse exact titles).
- The inbox: you do not sort it yourself. Use \`suggest\` to propose a type and place for inbox items; the user accepts with one click.
- Precise edits: \`update\` with old_text/new_text; property values by property name; options by name.
- New use cases need no code: \`define_type\` / \`update_type\` (properties, capabilities, views). Tag ↔ type conversions are previewed with \`convert\`; the user runs them in the app.
- Answers list one line per entry: title [id] · type · status · due · path · ⚠ blocked by / waiting for. A writing call is all or nothing: "Nothing changed" means no part of it was applied – fix the reason and call again. Read the Hints after a write (unresolved links, duplicate titles, open items below something done …).
- Link exactly with [[id|Label]], always for titles with # | [ ] ^. Never link an item to itself.
- Never delete unless asked; deletes go to the trash. Today is in \`schema\`. Reply in the language of the user's message.`;

function agentName(req: Request): string {
  const explicit = req.headers.get("x-obtion-agent");
  if (explicit) return explicit;
  const ua = req.headers.get("user-agent") ?? "";
  if (/claude-code/i.test(ua)) return "claude-code";
  if (/claude/i.test(ua)) return "claude";
  return "mcp";
}

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 1) }] });
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** `writes`: the tool changes data – an error then says that nothing was changed. */
function wrap<A>(fn: (args: A) => unknown, writes = false) {
  return async (args: A) => {
    try {
      const res = await fn(args);
      return typeof res === "string" ? text(res) : json(res);
    } catch (e) {
      if (e instanceof OpError || e instanceof InputError || e instanceof UndoError) return { ...text(writes ? `Nothing changed. ${e.message}` : e.message), isError: true };
      console.error("[mcp] tool error", e);
      return { ...text(`Internal error: ${(e as Error).message}`), isError: true };
    }
  };
}

function buildMcpServer(store: Store, agent: string, blobs?: Blobs) {
  const ops = new Ops(store, blobs);
  const origin = `agent:${agent}`;
  const server = new McpServer({ name: "obtion", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  const ro = { readOnlyHint: true };
  /** A writing tool: all or nothing, with hints appended to the answer. */
  const write = <A,>(fn: (a: A) => string | object) => wrap((a: A) => ops.call(origin, () => { const r = fn(a); return typeof r === "string" ? r : JSON.stringify(r, null, 1); }), true);

  server.registerTool("schema", { title: "Schema", description: "All types with description, properties (options, groups) and capabilities, the views of each type's page, the inbox query and today's date. Read this first.", inputSchema: {}, annotations: ro }, wrap(() => ops.schema()));
  server.registerTool(
    "query",
    { title: "Query", description: "Run a query in text form (English or German keywords) or name a type (its list, as its first view shows it). context = the page the query is about (for under:this).", inputSchema: { query: z.string(), context: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }, annotations: ro },
    wrap((a) => {
      const r = ops.query(a.query, a);
      const head = `${r.total} item(s)${r.list ? ` in "${r.list}"` : ""} · ${r.query}${r.missing_types ? ` · ⚠ deleted type(s): ${r.missing_types.join(", ")}` : ""}`;
      const more = r.total > r.items.length ? `\n… ${r.total - r.items.length} more (use limit)` : "";
      return `${head}\n${ops.lines(r.items, r.base)}${more}`;
    }),
  );
  server.registerTool("get", { title: "Get", description: "One item with its properties, place, children, links, backlinks, updates and body. Files include facts and extracted text.", inputSchema: { ref: z.string(), include_body: z.boolean().optional() }, annotations: ro }, wrap((a) => ops.get(a.ref, a.include_body ?? true)));
  server.registerTool("search", { title: "Search", description: "Full text over titles, tags, bodies, properties and PDF text.", inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() }, annotations: ro }, wrap((a) => {
    const hits = ops.search(a.query, a.limit);
    return hits.length ? hits.map((h) => `- ${ops.line(h.item)}${h.snippet ? ` — “${h.snippet}”` : ""}`).join("\n") : "Nothing found.";
  }));
  server.registerTool("focus", { title: "Focus", description: "What's going on: overdue and upcoming (by each type's due date), active items with progress, inbox size, recent activity.", inputSchema: {}, annotations: ro }, wrap(() => ops.focus()));
  server.registerTool(
    "create",
    {
      title: "Create",
      description: "Create informations. type is a type name (see schema) or omitted; parents (titles/ids) place them; properties by name; free_properties are properties without a type. Without type and parent the item lands in the inbox.",
      inputSchema: { items: z.array(createInput).min(1) },
    },
    write((a) => `Created:\n${ops.lines(a.items.map((x) => ops.create(x, origin)))}`),
  );
  server.registerTool(
    "update",
    {
      title: "Update",
      description: "Change one item: title, type (name or null), properties by name (null clears), free_properties, tags, refs, body (old_text/new_text for precise edits, or body + body_mode replace|append|prepend). Renaming rewrites [[links]].",
      inputSchema: updateInput.shape,
    },
    write((a) => {
      const { ref, ...rest } = a;
      return `Updated:\n${ops.lines([ops.update(ref, rest, origin)])}`;
    }),
  );
  server.registerTool(
    "set_status",
    { title: "Set status", description: "Set the status of several items at once: a status group (done, active, open) or an option name, in German or English. All or nothing.", inputSchema: { refs: z.array(z.string()).min(1), status: z.string() } },
    write((a) => `Status set:\n${ops.lines(ops.setStatusGroup(a.refs, a.status, origin))}`),
  );
  server.registerTool(
    "place",
    { title: "Place", description: '"Part of": add or remove parents, set the home, pin to or unpin from the top of the sidebar (pinned counts as a place). Prevents cycles. A file has exactly one parent: to move it, add the new one and remove the old one.', inputSchema: placeInput.shape },
    write((a) => {
      const r = ops.place(a.ref, a, origin);
      return `Placed:\n${ops.lines([r.now])}${r.part_of.length > 1 ? `\nPart of: ${r.part_of.join(", ")}` : ""}${r.in_inbox ? "\nIt is in the inbox now (no type, no place)." : ""}`;
    }),
  );
  server.registerTool(
    "add_update",
    { title: "Add update", description: "Dated progress note on an item whose type has updates, optionally changing its status at the same time.", inputSchema: { ref: z.string(), text: z.string(), status: z.string().optional() } },
    write((a) => `Update posted:\n${ops.lines([ops.addUpdate(a.ref, a.text, a.status, agent, origin)])}`),
  );
  server.registerTool(
    "suggest",
    { title: "Suggest", description: "Propose a type, places and property values for an inbox item. Nothing changes until the user accepts it in the app.", inputSchema: suggestInput.shape },
    write((a) => ops.suggest(a.ref, a, agent, origin)),
  );
  server.registerTool(
    "define_type",
    { title: "Define type", description: "Create a type with properties and capabilities. It gets its page (the list of its entries) in the sidebar.", inputSchema: defineTypeInput.shape },
    write((a) => ops.defineType(a, origin)),
  );
  server.registerTool(
    "update_type",
    {
      title: "Update type",
      description: "Change a type: name, plural (the name of its list), description, add/change/remove properties (values are never deleted), capabilities, the views of its page (`views` replaces all tabs; a tab with the same name keeps its place). Shows up in Activity. delete_preview: what deleting the type would affect – deleting itself is confirmed in the app.",
      inputSchema: updateTypeInput.shape,
    },
    write((a) => (a.delete_preview ? ops.deletePreview(a.type) : ops.updateType(a.type, a, origin))),
  );
  server.registerTool(
    "convert",
    { title: "Convert (preview)", description: "Preview turning a tag into a type or a type into a tag. Only a preview – the user runs it in the app.", inputSchema: convertInput.shape, annotations: ro },
    wrap((a) => ops.convertPreview(a)),
  );
  server.registerTool(
    "attach",
    { title: "Attach file", description: "Create a file from a URL or base64, optionally below a parent and with tags.", inputSchema: attachInput.shape },
    wrap(async (a) => `Attached:\n${ops.lines([await ops.attach(a, origin)])}`, true),
  );
  server.registerTool(
    "delete",
    {
      title: "Move to trash",
      description: 'Move an item to the trash (restorable). Only when the user asks. If items hang only below it, say what happens to them: children "trash" (deleted with it, restored with it) or "inbox" (kept, without this place). Items with another parent are never touched. Not for types: see update_type delete_preview.',
      inputSchema: { ref: z.string(), children: z.enum(["trash", "inbox"]).optional() },
      annotations: { destructiveHint: true },
    },
    write((a) => {
      const r = ops.remove(a.ref, a.children, origin);
      return `Moved "${r.item.title}" to the trash${r.only ? ` with ${r.only} item(s) below it` : ""}.`;
    }),
  );
  server.registerTool("restore", { title: "Restore", description: "Restore an item from the trash by id or title, together with what was deleted with it.", inputSchema: { ref: z.string() } }, write((a) => {
    const r = ops.restore(a.ref, origin);
    return `Restored "${r.item.title}"${r.back ? ` with ${r.back} item(s) below it` : ""}.`;
  }));
  server.registerTool(
    "undo",
    {
      title: "Undo",
      description: "Take back one step (one tool call or one user action) with everything it did, across items. Fields changed again later keep their newer value; items the step created go to the trash. Without step: your own last step. redo: true brings an undone step back.",
      inputSchema: { step: z.string().optional(), redo: z.boolean().optional() },
    },
    wrap((a) => {
      const step = a.step ?? ops.lastStep(origin, !!a.redo);
      const r = (a.redo ? redoStep : undoStep)(store, step, origin);
      const ix = store.index();
      const items = [...r.changed, ...r.trashed].map((id) => ix.get(id) ?? store.records.get(id)).filter((i): i is NonNullable<typeof i> => !!i);
      const kept = r.kept.length ? `\nKept newer values (changed again after that step): ${[...new Set(r.kept.map((k) => `"${store.records.get(k.doc)?.title}" ${k.field.replace(/^\w+[.:]?\w*:/, "")}`))].join(", ")}` : "";
      const trashed = r.trashed.length ? `\nTo the trash (created in that step): ${r.trashed.map((id) => `"${store.records.get(id)?.title}"`).join(", ")}` : "";
      return `${a.redo ? "Redone" : "Undone"} step ${r.undid}${items.length ? `:\n${ops.lines(items.filter((i) => !i.deleted))}` : " – nothing to change."}${trashed}${kept}\n(step ${r.step} – ${a.redo ? "undo" : "redo"} with undo${a.redo ? "" : " redo: true"})`;
    }, true),
  );
  server.registerTool(
    "activity",
    { title: "Activity", description: "What changed recently and who changed it (device, agent, import).", inputSchema: { days: z.number().optional(), ref: z.string().optional(), limit: z.number().int().max(200).optional() }, annotations: ro },
    wrap((a) => ops.activity(a)),
  );

  server.registerPrompt("process_inbox", { title: "Process the inbox", description: "Go through the inbox and suggest a type and a place for each item." }, () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Go through my inbox (today is ${todayISO()}).
1. Read the types and their descriptions with schema, then the inbox with query "inbox".
2. For each item (oldest first): get it, look at what it mentions and links, and search for similar items and likely places (overviews, projects).
3. Suggest a type and/or a place with suggest – only where it is clear. Leave unclear items alone and say why. Don't place, type or delete anything yourself; I accept suggestions in the app.
4. End with a short list: item → suggestion, and the items you left alone.`,
        },
      },
    ],
  }));
  server.registerPrompt("weekly_review", { title: "Weekly review", description: "Done in 7 days, overdue, blocked, projects without updates, inbox." }, () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Run my weekly review (today is ${todayISO()}). Use these queries and summarise each part in a few lines, citing titles:
1. Done in the last 7 days: query "done>-7d".
2. Overdue: query "status:open due<today".
3. Blocked: query "blocked status:open" – for each, what it waits for.
4. Active projects without an update for 14 days: focus and get, compare the last update with today.
5. Inbox: query "inbox" – how many, how old is the oldest.
Then ask what I want to change. Don't change anything before I answer.`,
        },
      },
    ],
  }));
  return server;
}

export async function handleMcp(store: Store, req: Request, blobs?: Blobs): Promise<Response> {
  store.flush();
  const server = buildMcpServer(store, agentName(req), blobs);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    setTimeout(() => server.close().catch(() => {}), 0);
  }
}
