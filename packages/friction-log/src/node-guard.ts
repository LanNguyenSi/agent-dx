import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Extract the minimum major version from an engines range such as ">=22".
 * Returns null when the range is not of the simple ">=N[.x.y]" form.
 */
export function parseMinMajor(range: string): number | null {
  const m = /^\s*>=\s*v?(\d+)(?:\.\d+){0,2}\s*$/.exec(range);
  return m ? Number(m[1]) : null;
}

/** True when the running Node version satisfies the minimum major. */
export function isSupportedNode(running: string, minMajor: number): boolean {
  const major = Number(running.replace(/^v/, "").split(".")[0]);
  return Number.isInteger(major) && major >= minMajor;
}

/**
 * Returns an error message when `running` is below the major required by
 * `enginesRange`, or null when it is supported (or the range is not parseable).
 */
export function nodeGuardMessage(
  running: string,
  enginesRange: string,
): string | null {
  const minMajor = parseMinMajor(enginesRange);
  if (minMajor === null || isSupportedNode(running, minMajor)) return null;
  return (
    `friction-log requires Node ${enginesRange} but is running on Node ${running}. ` +
    `Its SQLite binding does not work on this version; upgrade Node and retry.`
  );
}

/** Reads the `engines.node` range from the package's own package.json. */
export function readEnginesNode(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { engines?: { node?: unknown } };
  const node = parsed.engines?.node;
  return typeof node === "string" ? node : "";
}
