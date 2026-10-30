// Colours for types (their light and dark values are --pal-* in packages/ui/src/theme.css) and the icon names types can use.
export const COLORS = ["blue", "violet", "green", "slate", "teal", "pink", "brown", "amber", "red", "indigo", "olive", "gray"] as const;
export type Color = (typeof COLORS)[number];

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
