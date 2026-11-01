// Every localStorage key. Values are JSON, except those read before the app starts or by older
// versions (theme: index.html; lang, active space, file mode: plain text).

export const KEYS = {
  account: "obtion.account",
  spaces: "obtion.spaces",
  active: "obtion.active",
  shown: "obtion.shown",
  /** before workspaces: the accounts of this device, moved over once */
  legacyAccounts: "obtion.accounts",
  lang: "obtion.lang",
  theme: "obtion.theme",
  device: "obtion.device",
  fileMode: "obtion.fileMode",
  recentPlaces: "obtion.recentPlaces",
  captureSpace: "obtion.capture.space",
  timelineScale: "obtion.timeline.scale",
  sidebarTree: "obtion.sidebar.tree",
  sidebarSpace: (space: string) => `obtion.sidebar.space.${space}`,
  sidebarTypes: (space: string) => `obtion.sidebar.types.${space}`,
  /** a view's tab shown last (a type's page, a block) */
  tab: (key: string) => `obtion.tab.${key}`,
  /** folded groups of a table */
  fold: (key: string) => `obtion.fold.${key}`,
  /** opened rows: sub-items of a table, parts of a page */
  open: (key: string) => `obtion.open.${key}`,
};

/** A stored value, or `fallback`; text stored as plain text by an older version reads as that text. */
export function readJSON<T>(key: string, fallback: T): T {
  const s = localStorage.getItem(key);
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return (typeof fallback === "string" || fallback === null ? s : fallback) as T;
  }
}

export function writeJSON(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}
