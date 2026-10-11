import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./errors.js";

/**
 * An alias names a companion bundle in `--companion <alias>=<dir>` and in a
 * frontmatter reference `<alias>:<path>`. The same grammar is used on both
 * sides so a reference's prefix is classified exactly like a declared alias.
 */
export const ALIAS_PATTERN = /^[a-z0-9-]+$/;

/**
 * Parses repeatable `--companion <alias>=<dir>` values into an alias ->
 * absolute directory map. Every malformed value is a UsageError (exit 2),
 * never silently ignored: no `=`, empty alias or dir, an alias outside
 * `[a-z0-9-]+`, a duplicate alias, or a directory that does not exist.
 */
export function parseCompanions(values: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const value of values) {
    const eq = value.indexOf("=");
    if (eq === -1) {
      throw new UsageError(
        `--companion expects <alias>=<dir>, got \`${value}\` (missing \`=\`)`,
      );
    }
    const alias = value.slice(0, eq);
    const dir = value.slice(eq + 1);
    if (alias === "") {
      throw new UsageError(
        `--companion alias is empty in \`${value}\`; expected <alias>=<dir>`,
      );
    }
    if (dir === "") {
      throw new UsageError(
        `--companion directory is empty in \`${value}\`; expected <alias>=<dir>`,
      );
    }
    if (!ALIAS_PATTERN.test(alias)) {
      throw new UsageError(
        `--companion alias \`${alias}\` must match [a-z0-9-]+`,
      );
    }
    if (out.has(alias)) {
      throw new UsageError(`--companion alias \`${alias}\` is given twice`);
    }
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new UsageError(
        `--companion directory does not exist for alias \`${alias}\`: ${dir}`,
      );
    }
    out.set(alias, resolved);
  }
  return out;
}
