// The inbox: whatever its rule matches – stored in the settings (`settings.inbox`), the default
// from the code while unset. Whether something is in the inbox is always checked against this
// rule (placement.ts), never against one rebuilt elsewhere.
import { SETTINGS_ID } from "./model";
import type { Index } from "./graph";
import type { Cond } from "./query";

/** ohne:typ ohne:eltern -angeheftet | datei ohne:eltern ohne:verwendung */
export const DEFAULT_INBOX_WHERE: Cond = {
  or: [
    { and: [{ without: "type" }, { without: "parents" }, { not: { pinned: true } }] },
    { and: [{ file: true }, { without: "parents" }, { without: "usage" }] },
  ],
};

export function inboxWhere(ix: Index): Cond {
  return ix.all.get(SETTINGS_ID)?.settings?.inbox ?? DEFAULT_INBOX_WHERE;
}
