// "Rules for agents": Markdown on an item (its `rules` text) or on the workspace (the settings
// doc's). They bind agents for the item and everything below it over "Part of" – all parents,
// not only the home. The MCP server hands them out with every answer that touches items.
import { type Item, SETTINGS_ID } from "./model";
import type { Index } from "./graph";

export interface AgentRule {
  /** The item that holds the rule; null: the whole workspace. */
  owner: string | null;
  text: string;
}

/** The workspace's rules, if there are. */
export function workspaceRules(ix: Index): AgentRule | undefined {
  const text = ix.all.get(SETTINGS_ID)?.rules.trim();
  return text ? { owner: null, text } : undefined;
}

/** The rules that apply to one item: the workspace's, then its ancestors' from the top down, then its own. */
export function rulesFor(ix: Index, id: string): AgentRule[] {
  return rulesForAll(ix, [id]);
}

/** The rules that apply to several items, each once (by owner and by text), in the order of rulesFor. */
export function rulesForAll(ix: Index, ids: Iterable<string>): AgentRule[] {
  const out: AgentRule[] = [];
  const owners = new Set<string>();
  const texts = new Set<string>();
  const add = (r: AgentRule | undefined) => {
    if (!r || texts.has(r.text)) return;
    texts.add(r.text);
    out.push(r);
  };
  add(workspaceRules(ix));
  for (const id of ids) {
    for (const o of [...above(ix, id), id]) {
      if (owners.has(o)) continue;
      owners.add(o);
      const text = (ix.get(o) ?? ix.all.get(o))?.rules.trim();
      if (text) add({ owner: o, text });
    }
  }
  return out;
}

/** The ancestors of an item, top down; one in the trash: those of the places it had. */
function above(ix: Index, id: string): string[] {
  if (ix.get(id)) return ix.ancestors(id);
  const places = Object.keys(ix.all.get(id)?.parents ?? {}).filter((p) => ix.get(p));
  return [...new Set(places.flatMap((p) => [...ix.ancestors(p), p]))];
}

/** The items above `id` whose rules apply to it (not the workspace), top down. */
export function inheritedOwners(ix: Index, id: string): Item[] {
  return ix.ancestors(id).map((a) => ix.get(a)).filter((a): a is Item => !!a?.rules.trim());
}

/** Every live item that holds rules. */
export function ruleOwners(ix: Index): Item[] {
  return ix.live.filter((i) => i.rules.trim());
}
