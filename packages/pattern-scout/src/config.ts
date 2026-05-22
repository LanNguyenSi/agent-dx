import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ResolvedConfig } from "./types.js";

/**
 * Reference repos fetched by `pattern-scout setup`. These are the exemplar
 * codebases we mine patterns from; each entry is an opensrc spec (a bare npm
 * name, a `crates:` / `pypi:` prefix, or `owner/repo` for GitHub).
 *
 * `@changesets/cli` is intentionally the GitHub monorepo `changesets/changesets`
 * rather than the scoped npm package: opensrc cannot resolve that scoped
 * package and fails with "error decoding response body".
 */
export const DEFAULT_REPOS: readonly string[] = [
  "@modelcontextprotocol/sdk",
  "zod",
  "clipanion",
  "env-paths",
  "conf",
  "simple-git-hooks",
  "lint-staged",
  "crates:clap",
  "modelcontextprotocol/servers",
  "vercel/turborepo",
  "changesets/changesets",
];

const ConfigFileSchema = z
  .object({
    defaultRepos: z.array(z.string().min(1)).optional(),
    opensrcCommand: z.string().min(1).optional(),
    oracleCommand: z.string().min(1).optional(),
    oracleCwd: z.string().min(1).optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** The built-in configuration used when no config file is supplied. */
export function defaultConfig(): ResolvedConfig {
  return {
    defaultRepos: [...DEFAULT_REPOS],
    opensrcCommand: "opensrc",
    oracleCommand: "codebase-oracle",
  };
}

/** Merge a parsed config file over the built-in defaults. */
export function mergeConfig(file: ConfigFile): ResolvedConfig {
  const base = defaultConfig();
  return {
    defaultRepos: file.defaultRepos ?? base.defaultRepos,
    opensrcCommand: file.opensrcCommand ?? base.opensrcCommand,
    oracleCommand: file.oracleCommand ?? base.oracleCommand,
    oracleCwd: file.oracleCwd ?? base.oracleCwd,
  };
}

/**
 * Load configuration. With no path, returns the built-in defaults. With a
 * path, reads and validates a `pattern-scout.config.json` and merges it over
 * the defaults.
 */
export function loadConfig(configPath?: string): ResolvedConfig {
  if (!configPath) return defaultConfig();

  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Config file is not valid JSON (${abs}): ${msg}`);
  }
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at ${abs}: ${result.error.message}`);
  }
  return mergeConfig(result.data);
}
