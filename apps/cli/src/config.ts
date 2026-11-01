// Where the CLI keeps the server, workspace and token: one file per user, readable only by them.
// OBTION_SERVER, OBTION_WORKSPACE and OBTION_TOKEN override it (scripts, CI, agents).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  server: string;
  workspace: string;
  token: string;
}

export class CliError extends Error {}

type Env = Record<string, string | undefined>;

/** Linux: $XDG_CONFIG_HOME/obtion, macOS: ~/Library/Application Support/obtion, Windows: %APPDATA%\obtion. */
export function configPath(env: Env = process.env, platform: string = process.platform): string {
  if (env.OBTION_CONFIG) return env.OBTION_CONFIG;
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "obtion", "config.json");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "obtion", "config.json");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "obtion", "config.json");
}

/** The stored login with the environment on top; parts may be missing. */
export function loadConfig(env: Env = process.env): Partial<Config> {
  const path = configPath(env);
  let file: Partial<Config> = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new CliError(`${path} is not valid JSON. Log in again: obtion login <server> --workspace <id>`);
    }
  }
  return {
    server: env.OBTION_SERVER || file.server,
    workspace: env.OBTION_WORKSPACE || file.workspace,
    token: env.OBTION_TOKEN || file.token,
  };
}

export function requireConfig(env: Env = process.env): Config {
  const c = loadConfig(env);
  if (!c.server || !c.workspace || !c.token) throw new CliError("Not logged in. Run: obtion login <server> --workspace <id> (token on stdin or in OBTION_TOKEN)");
  return { server: normalizeServer(c.server), workspace: c.workspace, token: c.token };
}

export function normalizeServer(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) throw new CliError(`"${url}" is not a server address (http:// or https://).`);
  return u;
}

/** Written to a temporary file first, mode 0600 in a 0700 folder (Windows: the user's profile protects it). */
export function saveConfig(c: Config, env: Env = process.env) {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: no POSIX modes
  }
  return path;
}
