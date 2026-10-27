// Colours for types (each with a light and a dark value) and the icon names types can use.
export const PALETTE: Record<string, [string, string]> = {
  blue: ["#2f6ae0", "#6e96ff"],
  violet: ["#8b4fd8", "#b58cf0"],
  green: ["#23905f", "#50c88c"],
  slate: ["#5c6b80", "#94a3b8"],
  teal: ["#0d828c", "#46c8d2"],
  pink: ["#c84078", "#f082af"],
  brown: ["#9a6b45", "#c79a73"],
  amber: ["#be780a", "#f0b040"],
  red: ["#d1453b", "#f06b60"],
  indigo: ["#4f55d8", "#9399ff"],
  olive: ["#6b7a1f", "#b4c35a"],
  gray: ["#706258", "#c4b6aa"],
};
export const COLORS = Object.keys(PALETTE);

export const ICONS = [
  "sticky-note", "map", "folder-kanban", "circle-check", "book", "user", "pen-line", "graduation-cap", "building-2",
  "file-text", "star", "heart", "lightbulb", "calendar", "flag", "bookmark", "briefcase", "house", "music", "film",
  "globe", "code", "coffee", "camera", "users", "target", "layers", "box", "leaf", "rocket", "message-circle", "link", "inbox", "image", "paperclip", "list-todo", "archive",
];

/** A colour for a new type: the first one no type uses yet, so new types tell apart at a glance. */
export function freshColor(used: (string | undefined)[]): string {
  const taken = new Set(used);
  return COLORS.find((c) => !taken.has(c)) ?? COLORS[used.length % COLORS.length]!;
}
