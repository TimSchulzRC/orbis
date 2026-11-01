// Who made a change, as steps, events, updates and createdBy keep it: one string that stays
// readable in the database.
//   "web:Tim;u=<account id>;d=Mac-x3f9"     a person in the app, on a device
//   "agent:claude-code;u=<account id>;n=Tim" an agent working with that person's access
//   "import:notion", "system:clock"          everything else
// Entries from before: "web:Tim@Mac-x3f9", "web:Tim", "web:Mac-x3f9" (written by the app),
// "agent:claude" (no person). The device is recorded for later queries, never shown.

/** An account as changes name it: its id and the name others see. */
export interface Person {
  id: string;
  name: string;
}

export interface Actor {
  /** "web", "agent", "import", "system" – or "" for an origin without a kind */
  kind: string;
  /** web: the person's name; agent: the agent id ("claude-code"); import: the source */
  name: string;
  /** the account behind it; id is missing in entries from before */
  person?: { id?: string; name: string };
  device?: string;
}

/** How a user shows up in a workspace: their first name, else the start of the e-mail address. */
export const firstName = (user: { name: string; email: string }) => user.name.trim().split(/\s+/)[0] || user.email.split("@")[0]!;

// separators of the format; "," joins several origins of one transaction
const clean = (s: string) => s.replace(/[;=,]/g, " ").trim();

/** A person in the app; with the device it is on (recorded, not shown). */
export const personOrigin = (p: Person, device?: string) => `web:${clean(p.name)};u=${clean(p.id)}${device ? `;d=${clean(device).slice(0, 40)}` : ""}`;

/** An agent; with the account whose access it uses. */
export const agentOrigin = (agent: string, p?: Person) => `agent:${clean(agent)}${p ? `;u=${clean(p.id)};n=${clean(p.name)}` : ""}`;

export function parseOrigin(origin: string): Actor {
  const [head = "", ...parts] = origin.split(",")[0]!.trim().split(";");
  const colon = head.indexOf(":");
  const kind = colon < 0 ? "" : head.slice(0, colon);
  let name = colon < 0 ? head : head.slice(colon + 1);
  const kv: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq > 0) kv[p.slice(0, eq)] = p.slice(eq + 1);
  }
  let device = kv.d;
  if (kind === "web" && !kv.u && name.includes("@")) [name, device] = [name.slice(0, name.indexOf("@")), name.slice(name.indexOf("@") + 1)];
  const person = kind === "web" ? { id: kv.u, name } : kv.n ? { id: kv.u, name: kv.n } : undefined;
  return { kind, name, person, device };
}

/** The origin in plain English for agents and logs: "Tim", "claude-code for Tim", "import:notion". */
export function originText(origin: string): string {
  const a = parseOrigin(origin);
  if (a.kind === "web") return a.person!.name;
  if (a.kind === "agent") return a.person ? `${a.name} for ${a.person.name}` : a.name;
  return origin.split(",")[0]!.split(";")[0]!.trim();
}
