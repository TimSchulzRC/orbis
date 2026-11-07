// MCP endpoint (Streamable HTTP, stateless). Tools know no type by name: agents read `schema`
// first and follow the types' descriptions and capabilities.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { todayISO } from "@obtion/core/model";
import { InputError } from "@obtion/core/input";
import { UndoError, redoStep, undoStep } from "./undo";
import { LONG_TEXT, OpError, Ops, QUERY_HELP } from "./ops";
import { LANGS, type Lang, acceptLang } from "@obtion/core/i18n";
import { attachInput, convertInput, createInput, defineTypeInput, getInput, placeInput, suggestInput, updateInput, updateTypeInput } from "./schemas";
import type { Store } from "./store";
import type { Blobs } from "./blobs";
import { MAX_ATTACH } from "./config";
import { type Person, agentOrigin, parseOrigin } from "@obtion/core/origin";
import { workspaceRules } from "@obtion/core/rules";

const INSTRUCTIONS = `Obtion is the user's personal system for knowledge and work: informations linked like Obsidian, projects and tasks like Notion, all in one graph. You are their interface: they tell you what happened, you record it; they ask, you answer from the data.

The model:
- Everything is a note (title, Markdown body, tags, refs) or a file. A note has at most one type. Types are data: call \`schema\` first – it lists every type with its description, properties (with options) and capabilities. Follow the descriptions. Never assume a type exists because of its name.
- "Part of" (place) builds the tree: an item can have several parents, one is its home. Links ([[Title]]) and refs are mentions; they connect without sorting. Relations are typed properties.
- Pinned items form the top of the sidebar (place with pin:true); pinning counts as a place.
- An information without a type, without a parent and not pinned is in the inbox (precisely: whatever the inbox query matches, see \`schema\`). Without a type but with a parent it is a note.
- A type can have one property of kind "status": its options sit in the groups todo, active and done. Done counts as finished in progress, is never overdue and no longer blocks; active entries show on Today. Capabilities say what else a type can do: a due date ("Termin"), dated updates. Progress is a computed property ("progress" or "progress:Type"): the first one is the bar on the page. The app gives no type a special role: what a project or a task is comes from the types the user made.
- Every type has a page: the list of its entries with views as tabs (\`update_type\` views). Mixed lists are pages with query blocks. Query syntax: ${QUERY_HELP} In bodies, \`\`\`query <text>\`\`\` blocks are live lists.

Values are read tolerantly: a status as option name or group (open, active, done) in German or English, also synonyms like "in Arbeit" or "fertig"; dates as 2026-10-30, 30.10.2026, 10/30/2026, today/heute, tomorrow/morgen, a weekday or +3d, optionally with a time (2026-10-30 14:30); type names in singular or plural. "blocked" is not a status: set a property that holds it up (blocks: true in its type, e.g. "Blockiert durch" or "Wartet auf"). What can't be read is rejected with the reason – nothing is guessed.

How to work:
- At the start of a session: call \`activity\` with since = the cursor you got at the end of your last session (keep it in your notes), or an ISO time, and under = the project you work on. It shows what changed since then – especially what people changed by hand in the app (by: "people") – with property changes and text diffs. Use \`history\` for a whole text diff or an older version. Note the new cursor for next time.
- For questions: \`query\` (structured) or \`search\` (full text), then \`get\` for details. Answer from the data and cite titles.
- Long texts: \`get\` returns a body (or file text) over ${LONG_TEXT} characters as its outline (headings with offset and size). Read only the part you need with \`section\` ("Heading" or "Heading > Subheading") or \`offset\`/\`max_chars\`; follow "… _more" for the next page; \`full: true\` only when you need all of it. A search hit names its section ("§ …"): get that section.
- A new workspace without types: \`schema\` says not_set_up – call \`setup\` once (in the user's language), then read \`schema\` again.
- When the user reports progress ("X: mapping done, review on Friday"): find the item, post \`add_update\` on the item whose type has updates (optionally with a status), set statuses with \`update\` (properties: {"Status": "…"}), create follow-ups with \`create\` using the type of the existing entries below the item (usually the type its progress counts) and parents=[the item], with the due date property if the type has one.
- New things: \`create\` with a type if one fits (read its description), otherwise without type (it lands in the inbox, which is fine). Use [[Title]] links to existing items (search first to reuse exact titles).
- The inbox: you do not sort it yourself. Use \`suggest\` to propose a type and place for inbox items; the user accepts with one click.
- Precise edits: \`update\` with old_text/new_text; property values by property name; options by name.
- Others edit at the same time (the user in the app, other agents). Change bodies in place: old_text/new_text, or body with body_mode "append"/"prepend" – these keep what others wrote. Replacing a whole body needs base_version: the version \`get\` shows (writes answer with the new one). If the item changed since, nothing changes and the answer shows who changed what – get it again, merge, retry. Titles, properties, tags: the last write wins unless you pass base_version.
- New use cases need no code: \`define_type\` / \`update_type\` (properties, capabilities, views). Tag ↔ type conversions are previewed with \`convert\`; the user runs them in the app.
- Answers list one line per entry: title [id] · type · status · due · path · ⚠ blocked by / waiting for; after a write it ends with · version <hash> (its base_version from now on). A writing call is all or nothing: "Nothing changed" means no part of it was applied – fix the reason and call again. Read the Hints after a write (unresolved links, duplicate titles, open items below something done …).
- Link exactly with [[id|Label]], always for titles with # | [ ] ^. Never link an item to itself.
- Files: \`get\` on a file shows its facts, the extracted text (PDF incl. embedded invoice XML, Word, Excel, PowerPoint, text and code files, a ZIP's entries) and, where the server offers it, a download command. Every file type is accepted. Small things: \`attach\` with base64 or a public url. A file on your disk: upload it over HTTP (below) – don't push large files through base64. Always give a parent when you add a file: one without lands in the inbox, which you may not sort afterwards (only \`suggest\`).
- Never delete unless asked; deletes go to the trash. Delete for good (\`purge\`) only when the user explicitly asks. Today is in \`schema\`. Reply in the language of the user's message.

Rules for agents:
- The workspace and any item can carry rules for agents (Markdown). They are binding: an item's rules apply to it and to everything below it (over all its parents), the workspace's apply everywhere. Answers about items end with a "Rules for agents" block with the ones that apply; \`schema\` lists every item that has rules.
- Read the rules that apply before you act outside Obtion – in other systems, by e-mail or any message to people – and follow them. When a rule asks you to ask first, ask.
- The user may change them in the app at any time. The current text always wins over anything you remember from earlier sessions or other places.
- Change rules (update/create with agent_rules) only when the user asks you to.`;

/** The instructions, with the workspace's rules for agents as they are now (the server is built per request). */
function instructions(ops: Ops): string {
  const ws = workspaceRules(ops.ix);
  if (!ws) return INSTRUCTIONS;
  const text = ws.text.length > 8000 ? `${ws.text.slice(0, 8000).trimEnd()}\n… (shortened – read it in full with schema)` : ws.text;
  return `${INSTRUCTIONS}\n\nRules for agents of this workspace (binding everywhere, as of now):\n${text}`;
}

/** The HTTP file API, for the instructions and the attach description. */
function filesHelp(url: string) {
  return `HTTP file API (token: the one this MCP connection uses, as $OBTION_TOKEN – never write the real token into answers or files):
- Upload a new file: curl -fsS -X POST -H "Authorization: Bearer $OBTION_TOKEN" --data-binary @report.pdf "${url}?name=report.pdf&parent=<id>" → JSON with id, hash, size. Always give parent (an id or exact title): without it the file lands in the inbox, and from there you can no longer place it yourself – only suggest a place, which the user has to accept.
- Replace the content of a file (same item, old version kept): curl -fsS -X PUT -H "Authorization: Bearer $OBTION_TOKEN" --data-binary @report.pdf ${url}/<file id>
- Download the original: curl -fsS -H "Authorization: Bearer $OBTION_TOKEN" -o report.pdf ${url}/<file id>
Uploads and replacements show up in the activity and can be undone with undo like a tool call.`;
}

export function agentName(req: Request): string {
  const explicit = req.headers.get("x-obtion-agent");
  if (explicit) return explicit;
  const ua = req.headers.get("user-agent") ?? "";
  if (/claude-code/i.test(ua)) return "claude-code";
  if (/claude/i.test(ua)) return "claude";
  return "mcp";
}

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 1) }] });
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

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

const userPrompt = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/** The items a tool answer is about: the rules for agents that apply to them end the answer. */
type Touched = Set<string>;

function buildMcpServer(store: Store, origin: string, blobs?: Blobs, lang: Lang = "de", filesUrl?: string) {
  const ops = new Ops(store, blobs, filesUrl);
  const agent = parseOrigin(origin).name;
  const server = new McpServer({ name: "obtion", version: "0.2.0" }, { instructions: filesUrl ? `${instructions(ops)}\n\n${filesHelp(filesUrl)}` : instructions(ops) });
  const ro = { readOnlyHint: true };
  /** A tool about items: what it touched gets its rules for agents appended (`full`: owners shown uncut). */
  const ruled =
    <A,>(fn: (a: A, touched: Touched, full: Touched) => unknown) =>
    async (a: A) => {
      const touched: Touched = new Set();
      const full: Touched = new Set();
      const res = await fn(a, touched, full);
      const block = ops.rulesBlock(touched, full);
      return block ? `${typeof res === "string" ? res : JSON.stringify(res, null, 1)}\n\n${block}` : res;
    };
  /** All or nothing, with hints and the rules for agents appended to the answer. */
  const write = <A,>(fn: (a: A, touched: Touched) => string | object) =>
    wrap(
      ruled((a: A, touched) =>
        ops.call(origin, () => {
          const r = fn(a, touched);
          return typeof r === "string" ? r : JSON.stringify(r, null, 1);
        }),
      ),
      true,
    );
  /** Mark items as touched and pass them on. */
  const mark = <T extends { id: string }>(touched: Touched, items: T[]): T[] => (items.forEach((i) => touched.add(i.id)), items);

  server.registerTool("schema", { title: "Schema", description: "All types with description, properties (options, groups) and capabilities, the views of each type's page, the inbox query and today's date. Read this first.", inputSchema: {}, annotations: ro }, wrap(() => ops.schema()));
  server.registerTool(
    "setup",
    {
      title: "Set up the workspace",
      description: "Only for a workspace that is not set up yet (schema says not_set_up): creates the default types (project, task, card) and the settings, as the app does. Refused once it is set up. language: de or en (default: the language of the request, else de).",
      inputSchema: { language: z.enum(LANGS as [Lang, ...Lang[]]).optional() },
    },
    write((a) => ops.setup(a.language ?? lang, origin)),
  );
  server.registerTool(
    "query",
    { title: "Query", description: "Run a query in text form (English or German keywords) or name a type (its list, as its first view shows it). context = the page the query is about (for under:this).", inputSchema: { query: z.string(), context: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }, annotations: ro },
    wrap(ruled((a, touched) => {
      const r = ops.query(a.query, a);
      mark(touched, r.items);
      const head = `${r.total} item(s)${r.list ? ` in "${r.list}"` : ""} · ${r.query}${r.missing_types ? ` · ⚠ deleted type(s): ${r.missing_types.join(", ")}` : ""}`;
      const more = r.total > r.items.length ? `\n… ${r.total - r.items.length} more (use limit)` : "";
      return `${head}\n${ops.lines(r.items, r.base)}${more}`;
    })),
  );
  server.registerTool(
    "get",
    {
      title: "Get",
      description: `One item with its version (a hash of its content, for base_version – not the numbered text versions of \`history\`), properties, place, children, links, backlinks, updates and body. Files include facts (name, mime, size, hash, download URL and curl command) and their extracted text. Pass version as base_version to update when you replace the body. A body (or file text) longer than ${LONG_TEXT} characters with headings comes as its outline (each heading with level, character offset and size) instead: then read the part you need with section (a heading or a path like "Status > Offene Punkte") or offset (+ max_chars), or everything with full: true. Long texts without headings come in pages; the answer says where the next page starts (… _more). outline: true adds the headings to any answer. Children come 60, updates 15 at a time (children_offset, updates_offset).`,
      inputSchema: getInput.shape,
      annotations: ro,
    },
    wrap(
      ruled((a, touched, full) => {
        const { ref, ...opts } = a;
        const out = ops.get(ref, opts);
        touched.add(out.id as string);
        full.add(out.id as string);
        for (const c of (out.children as { id: string }[] | undefined) ?? []) touched.add(c.id); // listed children bring their own
        return out;
      }),
    ),
  );
  server.registerTool(
    "search",
    {
      title: "Search",
      description: 'Full text over titles, tags, bodies, properties and the text of files (PDF, Office, text and code files, ZIP entries). Identifiers are found by their parts too ("4711" finds Beleg_4711_2026.pdf). Each hit has an excerpt around the match and, when the match is under a heading, "§ Heading > Subheading": read that part with get section.',
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() },
      annotations: ro,
    },
    wrap(
      ruled((a, touched) => {
        const hits = ops.search(a.query, a.limit);
        hits.forEach((h) => touched.add(h.item.id));
        return hits.length ? hits.map((h) => `- ${ops.line(h.item)}${h.heading ? ` · § ${h.heading}` : ""}${h.snippet ? ` — “${h.snippet}”` : ""}`).join("\n") : "Nothing found.";
      }),
    ),
  );
  server.registerTool("focus", { title: "Focus", description: "What's going on: overdue and upcoming (by each type's due date), active items with progress, inbox size, recent activity.", inputSchema: {}, annotations: ro }, wrap(ruled((_a, touched) => ops.focus(touched))));
  server.registerTool(
    "create",
    {
      title: "Create",
      description: "Create informations. type is a type name (see schema) or omitted; parents (titles/ids) place them; properties by name (only those of the type). Without type and parent the item lands in the inbox.",
      inputSchema: { items: z.array(createInput).min(1) },
    },
    write((a, touched) => `Created:\n${ops.written(mark(touched, a.items.map((x) => ops.create(x, origin))))}`),
  );
  server.registerTool(
    "update",
    {
      title: "Update",
      description: "Change one item: title, type (name or null), properties by name (null clears), free_properties_remove, tags, refs, body. Body: prefer old_text/new_text or body_mode append|prepend; replacing the whole body (body without body_mode, or replace) needs base_version from get, and a stale one is rejected with what changed since. Renaming rewrites [[links]]. The answer shows the new version.",
      inputSchema: updateInput.shape,
    },
    write((a, touched) => {
      const { ref, ...rest } = a;
      return `Updated:\n${ops.written(mark(touched, [ops.update(ref, rest, origin)]))}`;
    }),
  );
  server.registerTool(
    "set_status",
    { title: "Set status", description: "Set the status of several items at once: a status group (done, active, open) or an option name, in German or English. All or nothing.", inputSchema: { refs: z.array(z.string()).min(1), status: z.string() } },
    write((a, touched) => `Status set:\n${ops.written(mark(touched, ops.setStatusGroup(a.refs, a.status, origin)))}`),
  );
  server.registerTool(
    "place",
    { title: "Place", description: '"Part of": add or remove parents, set the home, pin to or unpin from the top of the sidebar (pinned counts as a place). Prevents cycles. A file has exactly one parent: to move it, add the new one and remove the old one.', inputSchema: placeInput.shape },
    write((a, touched) => {
      const r = ops.place(a.ref, a, origin);
      touched.add(r.now.id);
      return `Placed:\n${ops.lines([r.now])}${r.part_of.length > 1 ? `\nPart of: ${r.part_of.join(", ")}` : ""}${r.in_inbox ? "\nIt is in the inbox now (no type, no place)." : ""}`;
    }),
  );
  server.registerTool(
    "add_update",
    { title: "Add update", description: "Dated progress note on an item whose type has updates, optionally changing its status at the same time.", inputSchema: { ref: z.string(), text: z.string(), status: z.string().optional() } },
    write((a, touched) => `Update posted:\n${ops.written(mark(touched, [ops.addUpdate(a.ref, a.text, a.status, agent, origin)]))}`),
  );
  server.registerTool(
    "suggest",
    { title: "Suggest", description: "Propose a type, places and property values for an inbox item. Nothing changes until the user accepts it in the app.", inputSchema: suggestInput.shape },
    write((a, touched) => ops.suggest(a.ref, a, agent, origin, touched)),
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
    {
      title: "Attach file",
      description: `Create a file from a public URL or base64 (small files only; max ${MAX_ATTACH / 1024 / 1024} MB) below a parent, optionally with tags. Any file type. Always give parent: without it the file lands in the inbox, and agents can't place inbox items afterwards (only suggest). replace: put the new content into an existing file instead. ${filesUrl ? `A file on your disk goes over HTTP, not base64: curl -fsS -X POST -H "Authorization: Bearer $OBTION_TOKEN" --data-binary @file.xsd "${filesUrl}?name=file.xsd&parent=<id>" (PUT ${filesUrl}/<file id> replaces a content). $OBTION_TOKEN is the token of this MCP connection.` : ""}`.trim(),
      inputSchema: attachInput.shape,
    },
    wrap(ruled((a, touched) => ops.attach(a, origin, touched)), true),
  );
  server.registerTool(
    "delete",
    {
      title: "Move to trash",
      description: 'Move an item to the trash (restorable). Only when the user asks. If items hang only below it, say what happens to them: children "trash" (deleted with it, restored with it) or "inbox" (kept, without this place). Items with another parent are never touched. Not for types: see update_type delete_preview.',
      inputSchema: { ref: z.string(), children: z.enum(["trash", "inbox"]).optional() },
      annotations: { destructiveHint: true },
    },
    write((a, touched) => {
      const r = ops.remove(a.ref, a.children, origin);
      touched.add(r.item.id);
      return `Moved "${r.item.title}" to the trash${r.only ? ` with ${r.only} item(s) below it` : ""}.`;
    }),
  );
  server.registerTool("restore", { title: "Restore", description: "Restore an item from the trash by id or title, together with what was deleted with it.", inputSchema: { ref: z.string() } }, write((a, touched) => {
    const r = ops.restore(a.ref, origin);
    touched.add(r.item.id);
    return `Restored "${r.item.title}"${r.back ? ` with ${r.back} item(s) below it` : ""}.`;
  }));
  server.registerTool(
    "purge",
    {
      title: "Delete for good",
      description: "Delete an item that is in the trash for good, with what was deleted with it, its history and its file contents (cannot be undone or restored). empty_trash: true deletes everything in the trash. Only when the user explicitly asks for it.",
      inputSchema: { ref: z.string().optional(), empty_trash: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    wrap((a: { ref?: string; empty_trash?: boolean }) => {
      if (!a.ref && !a.empty_trash) throw new OpError("Give ref (an item in the trash) or empty_trash: true.");
      const title = a.ref && store.records.get(a.ref)?.title;
      const n = ops.purge(a.empty_trash ? undefined : a.ref).length;
      return a.empty_trash ? `Emptied the trash: deleted ${n} item(s) for good.` : `Deleted "${title ?? a.ref}"${n > 1 ? ` with ${n - 1} item(s) below it` : ""} for good.`;
    }, true),
  );
  server.registerTool(
    "undo",
    {
      title: "Undo",
      description: "Take back one step (one tool call or one user action) with everything it did, across items. Fields changed again later keep their newer value; items the step created go to the trash. Without step: your own last step. redo: true brings an undone step back.",
      inputSchema: { step: z.string().optional(), redo: z.boolean().optional() },
    },
    wrap(ruled((a, touched) => {
      const step = a.step ?? ops.lastStep(origin, !!a.redo);
      const r = (a.redo ? redoStep : undoStep)(store, step, origin);
      const ix = store.index();
      const items = mark(touched, [...r.changed, ...r.trashed].map((id) => ix.get(id) ?? store.records.get(id)).filter((i): i is NonNullable<typeof i> => !!i));
      const titleOf = (id: string) => `"${store.records.get(id)?.title}"`;
      for (const k of r.kept) touched.add(k.doc);
      const keptFields = [...new Set(r.kept.map((k) => `${titleOf(k.doc)} ${k.field.replace(/^\w+[.:]?\w*:/, "")}`))];
      const kept = r.kept.length ? `\nKept newer values (changed again after that step): ${keptFields.join(", ")}` : "";
      const trashed = r.trashed.length ? `\nTo the trash (created in that step): ${r.trashed.map(titleOf).join(", ")}` : "";
      const done = `${a.redo ? "Redone" : "Undone"} step ${r.undid}`;
      const list = items.length ? `:\n${ops.lines(items.filter((i) => !i.deleted))}` : " – nothing to change.";
      const back = `(step ${r.step} – ${a.redo ? "undo" : "redo"} with undo${a.redo ? "" : " redo: true"})`;
      return `${done}${list}${trashed}${kept}\n${back}`;
    }), true),
  );
  server.registerTool(
    "activity",
    {
      title: "Activity",
      description:
        'What changed and who changed it (a person in the app, an agent working for one, an import): property changes with names and from → to, posted updates, and text changes as diffs (long ones cut – the history tool shows all). With since (the cursor from your last call, an entry id or an ISO time) you get only what changed after it, oldest first, and a new cursor. under = an item and everything below it ("part of"); ref = just one item; by = "people", "agents", "others" (anyone but you), or a name ("Tim", "claude-code"); several with commas.',
      inputSchema: {
        since: z.string().optional().describe("the cursor from your last activity call, an entry id, or an ISO time (2026-11-01T08:00)"),
        days: z.number().optional().describe("without since: how many days back (default 7)"),
        under: z.string().optional().describe("an item (title or id): it and everything below it"),
        ref: z.string().optional().describe("only this item"),
        by: z.string().optional().describe('"people", "agents", "others", "imports" or a name; several with commas'),
        limit: z.number().int().min(1).max(200).optional(),
        diff: z.boolean().optional().describe("text changes as diffs (default true)"),
      },
      annotations: ro,
    },
    wrap(ruled((a, touched) => ops.activity(a, origin, touched))),
  );
  server.registerTool(
    "history",
    {
      title: "History",
      description:
        "The kept versions of an item's text (every editing session is one version, with time and who). Without more: the list. version = one version's full text. from (0 = empty) and to (default: the text now) = a unified diff between two versions. To go back to a version, update the body with its text.",
      inputSchema: { ref: z.string(), version: z.number().int().min(1).optional(), from: z.number().int().min(0).optional(), to: z.number().int().min(1).optional() },
      annotations: ro,
    },
    wrap(ruled((a, touched) => ops.history(a.ref, a, touched))),
  );

  server.registerPrompt("process_inbox", { title: "Process the inbox", description: "Go through the inbox and suggest a type and a place for each item." }, () =>
    userPrompt(`Go through my inbox (today is ${todayISO()}).
1. Read the types and their descriptions with schema, then the inbox with query "inbox".
2. For each item (oldest first): get it, look at what it mentions and links, and search for similar items and likely places (items with entries below, projects).
3. Suggest a type and/or a place with suggest – only where it is clear. Leave unclear items alone and say why. Don't place, type or delete anything yourself; I accept suggestions in the app.
4. End with a short list: item → suggestion, and the items you left alone.`),
  );
  server.registerPrompt("weekly_review", { title: "Weekly review", description: "Done in 7 days, overdue, blocked, running entries without updates, inbox." }, () =>
    userPrompt(`Run my weekly review (today is ${todayISO()}). Use these queries and summarise each part in a few lines, citing titles:
1. Done in the last 7 days: query "done>-7d".
2. Overdue: query "status:open due<today".
3. Blocked: query "blocked status:open" – for each, what it waits for.
4. Running entries (focus → active) without an update for 14 days: get them, compare the last update with today.
5. Inbox: query "inbox" – how many, how old is the oldest.
Then ask what I want to change. Don't change anything before I answer.`),
  );
  return server;
}

/** `filesUrl`: the workspace's HTTP file API (…/w/<id>/api/files), named in answers and instructions. */
export async function handleMcp(store: Store, req: Request, blobs: Blobs | undefined, person: Person, filesUrl?: string): Promise<Response> {
  store.flush();
  const server = buildMcpServer(store, agentOrigin(agentName(req), person), blobs, acceptLang(req.headers.get("accept-language")), filesUrl);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    setTimeout(() => server.close().catch(() => {}), 0);
  }
}
