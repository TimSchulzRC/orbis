// Playwright's mouse and keyboard for the component tests, which run in an iframe of Vitest's
// page: positions are taken in the test's own coordinates (getBoundingClientRect) and moved by
// the iframe's place on the page.
import type { BrowserCommand } from "vitest/node";

type Mouse = "move" | "down" | "up" | "click";

const offset = async (ctx: Parameters<BrowserCommand>[0]) => {
  const box = await (await (await ctx.frame()).frameElement()).boundingBox();
  return { x: box?.x ?? 0, y: box?.y ?? 0 };
};

export const mouse: BrowserCommand<[action: Mouse, x?: number, y?: number, opts?: { button?: "left" | "right"; steps?: number }]> = async (ctx, action, x = 0, y = 0, opts = {}) => {
  const m = ctx.page.mouse;
  if (action === "down" || action === "up") return void (await m[action]({ button: opts.button }));
  const o = await offset(ctx);
  if (action === "move") await m.move(o.x + x, o.y + y, { steps: opts.steps });
  else await m.click(o.x + x, o.y + y, { button: opts.button });
};

/** Playwright's key names: "Control+End", "ArrowUp"; or text to type with `type`. */
export const keys: BrowserCommand<[action: "press" | "type", what: string]> = async (ctx, action, what) => {
  await ctx.page.keyboard[action](what);
};

declare module "vitest/browser" {
  interface BrowserCommands {
    mouse: (action: Mouse, x?: number, y?: number, opts?: { button?: "left" | "right"; steps?: number }) => Promise<void>;
    keys: (action: "press" | "type", what: string) => Promise<void>;
  }
}
