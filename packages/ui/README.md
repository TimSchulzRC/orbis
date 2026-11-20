# UI components and theme

Orbis uses locally owned shadcn/ui components in `src/components/ui`, based on the New York registry and Radix primitives. `components.json` configures the shared UI package. Keep application-specific components such as the editor, graph, query builder and item rows in `src/ui`.

Edit `src/theme.css` to change the application palette, semantic colors and radius. Both light mode and `html[data-theme="dark"]` are defined there. `src/styles.css` maps the tokens to Tailwind and contains application layout rules. Existing domain colors and CSS aliases resolve to the same theme.

Use the shared Button, Input, Textarea, Checkbox, NativeSelect and Table components for controls. Button's `plain` variant and `none` size support navigation rows and compact editor actions whose geometry is defined by the application. Standard actions use the default, ghost, outline or destructive variants. Preserve accessible names and touch target classes when changing these actions.

`src/ui/bits.tsx` provides application-level adapters for buttons, dialogs, anchored popovers, progress and segmented controls. Dialogs, command search, mobile sheets and the media viewer use Radix focus management. Keep application-specific search ranking and keyboard shortcuts in the command palette.

Inline fields keep their text-like appearance when a custom class is supplied. Native file and date inputs retain browser functionality. Toasts continue to use Sonner with theme tokens.

Run `bun run typecheck`, `bun test`, `bun run test:browser` and `bun run test:e2e` after changes. A change to how a part of the interface behaves gets a test in `tests/browser`; `tests/e2e` only checks that every page renders and the flows that need the server. The root typecheck includes tests. There is currently no lint script.
