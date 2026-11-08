// Who made a change (steps, events, updates, createdBy), as one string that stays readable in
// the database:
//   "web:Tim;u=<account id>;d=Mac-x3f9"     a person in the app, on a device
//   "agent:claude-code;u=<account id>;n=Tim" an agent working with that person's access
//   "import:notion", "system:clock"          everything else
// The device is recorded for later queries, never shown.

export interface Person {
  id: string;
  name: string;
}

export interface Actor {
  /** "web", "agent", "import", "system" – or "" for an origin without a kind */
  kind: string;
  /** web: the person's name; agent: the agent id ("claude-code"); import: the source */
  name: string;
  /** the account behind it */
  person?: Person;
  device?: string;
}

export const firstName = (user: { name: string; email: string }) => user.name.trim().split(/\s+/)[0] || user.email.split("@")[0]!;

const MAX_DEVICE_LEN = 40;
// separators of the format; "," joins several origins of one transaction
const clean = (s: string) => s.replace(/[;=,]/g, " ").trim();

export const personOrigin = (p: Person, device?: string) => `web:${clean(p.name)};u=${clean(p.id)}${device ? `;d=${clean(device).slice(0, MAX_DEVICE_LEN)}` : ""}`;

/** `p` is the account whose access the agent uses. */
export const agentOrigin = (agent: string, p: Person) => `agent:${clean(agent)};u=${clean(p.id)};n=${clean(p.name)}`;

export function parseOrigin(origin: string): Actor {
  const [head = "", ...parts] = origin.split(",")[0]!.trim().split(";");
  const colon = head.indexOf(":");
  const kind = colon < 0 ? "" : head.slice(0, colon);
  const name = colon < 0 ? head : head.slice(colon + 1);
  const kv: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq > 0) kv[p.slice(0, eq)] = p.slice(eq + 1);
  }
  const device = kv.d;
  const person = kind === "web" ? { id: kv.u ?? "", name } : kv.n ? { id: kv.u ?? "", name: kv.n } : undefined;
  return { kind, name, person, device };
}

/** The origin in plain English for agents and logs: "Tim", "claude-code for Tim", "import:obsidian". */
export function originText(origin: string): string {
  const a = parseOrigin(origin);
  if (a.kind === "web") return a.person!.name;
  if (a.kind === "agent") return a.person ? `${a.name} for ${a.person.name}` : a.name;
  return origin.split(",")[0]!.split(";")[0]!.trim();
}
