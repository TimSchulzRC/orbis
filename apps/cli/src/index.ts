#!/usr/bin/env bun
// obtion: work with a subtree of Obtion as a local folder. See docs/cli.md.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client, ToolError } from "./client";
import { CliError, normalizeServer, requireConfig, saveConfig } from "./config";
import { findRoot, loadState } from "./local";
import { openFolder, pull, push, status } from "./sync";
import { importRepo, readConfig } from "./import";

export const VERSION = "0.1.0";

const USAGE = `obtion ${VERSION} – a part of Obtion as a local folder

  obtion login <server> --workspace <id>   token from OBTION_TOKEN or stdin
  obtion pull <id or title> <folder>       mirror an item and everything below it
  obtion pull [<folder>]                   bring a pulled folder up to date
  obtion status [<folder>] [--local]       local changes and changes in Obtion since the last pull
  obtion push [<folder>] [--delete]        send edited and new notes and files
  obtion import <folder> --into <id or title> [--config mapping.json] [--report file.md]
                                           a folder or Git repository, with history and a completeness report

  --dry-run   pull and push: only show what would happen
  --force     pull: replace local edits (kept as *.obtion-conflict.* copies)
  --delete    push: move items deleted here to the trash
  --no-history, --no-bundle, --tmp <dir>   import: leave out the Git history or the bundle; scratch space

Environment: OBTION_SERVER, OBTION_WORKSPACE, OBTION_TOKEN override the login; OBTION_CONFIG names
the config file. Exit code 1: conflicts or failures (listed), 2: wrong use or an error.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("Token (shown while typing; better: pipe it or set OBTION_TOKEN): ");
    for await (const line of console) return line;
    return "";
  }
  return await new Response(Bun.stdin.stream()).text();
}

export async function main(argv: string[]): Promise<number> {
  const { values: o, positionals: args } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workspace: { type: "string", short: "w" },
      "dry-run": { type: "boolean", short: "n" },
      force: { type: "boolean" },
      delete: { type: "boolean" },
      local: { type: "boolean" },
      into: { type: "string" },
      config: { type: "string" },
      report: { type: "string" },
      tmp: { type: "string" },
      "no-history": { type: "boolean" },
      "no-bundle": { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  const [cmd, ...rest] = args;
  if (o.version) return (console.log(VERSION), 0);
  if (!cmd || o.help || cmd === "help") return (console.log(USAGE), cmd || o.help ? 0 : 2);

  switch (cmd) {
    case "login": {
      const server = rest[0];
      if (!server || !o.workspace) throw new CliError("usage: obtion login <server> --workspace <id> (token from OBTION_TOKEN or stdin)");
      const token = (process.env.OBTION_TOKEN || (await readStdin())).trim();
      if (!token) throw new CliError("No token. Create one in Obtion (settings › Connect an agent) and pipe it in, or set OBTION_TOKEN.");
      const cfg = { server: normalizeServer(server), workspace: o.workspace, token };
      await new Client(cfg).tool("schema", {}); // the token opens this workspace
      const path = saveConfig(cfg);
      console.log(`Logged in to workspace ${cfg.workspace} on ${cfg.server}. Saved in ${path}.`);
      return 0;
    }
    case "pull": {
      const client = new Client(requireConfig());
      if (rest.length >= 2) return pull(client, resolve(rest[1]!), rest[0], { dryRun: o["dry-run"], force: o.force, quiet: o.quiet });
      const dir = rest[0] ? resolve(rest[0]) : findRoot(".");
      if (rest[0] && !(existsSync(rest[0]) && loadState(dir!))) throw new CliError(`${rest[0]} is not a pulled folder. First time: obtion pull <id or title> <folder>`);
      if (!dir) throw new CliError("No pulled folder here or above. First time: obtion pull <id or title> <folder>");
      return pull(client, dir, undefined, { dryRun: o["dry-run"], force: o.force, quiet: o.quiet });
    }
    case "status": {
      const { dir, state } = openFolder(rest[0]);
      return status(o.local ? undefined : new Client(requireConfig()), dir, state);
    }
    case "push": {
      const { dir, state } = openFolder(rest[0]);
      return push(new Client(requireConfig()), dir, state, { dryRun: o["dry-run"], delete: o.delete });
    }
    case "import": {
      if (!rest[0] || !o.into) throw new CliError("usage: obtion import <folder> --into <id or title> [--config mapping.json] [--dry-run]");
      return importRepo(new Client(requireConfig()), rest[0], o.into, {
        config: o.config ? readConfig(o.config) : undefined,
        dryRun: o["dry-run"],
        report: o.report,
        tmp: o.tmp,
        history: !o["no-history"],
        bundle: !o["no-bundle"],
        quiet: o.quiet,
      });
    }
    default:
      throw new CliError(`Unknown command "${cmd}".\n\n${USAGE}`);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliError || e instanceof ToolError || String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS")) console.error(`obtion: ${(e as Error).message}`);
    else console.error(e);
    process.exitCode = 2;
  }
}
