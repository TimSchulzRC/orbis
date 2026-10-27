// The replica every component reads and writes, on the browser's platform (browser.ts).
import { Repo } from "@obtion/sync";
import { browserHost } from "./browser";

export const repo = new Repo(browserHost());
