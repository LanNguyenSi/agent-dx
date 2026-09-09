import fs from "node:fs";
import path from "node:path";
import { linkEntryUsageError } from "./link-list.js";

/** The repo-level defaults file every probe invocation reads:
 * `.agent-primitives.json` at the repository root --
 * the directory `probe` treats as the repo root (the git work-tree
 * root, or `cwd` when not in a repository), never a subdirectory the
 * invocation `cwd` happens to sit in. */
export const DEFAULTS_FILE_NAME = ".agent-primitives.json";

/** The only key the schema recognizes today. Unknown keys are a usage
 * error naming the path and the key (fail-closed), so a typo does not
 * silently do nothing. */
const DEFAULTS_FILE_KEYS = ["link"] as const;

/** A defaults file this small can only be config, never data; well
 * above what a real `link` list needs, and small enough that reading it
 * whole on every invocation is free. */
export const DEFAULTS_FILE_MAX_BYTES = 64 * 1024;

export type DefaultsFileFailureReason =
  "defaults_file_invalid" | "defaults_file_not_readable";

export type DefaultsFileReadResult =
  | { ok: true; path: string; present: boolean; links: string[] }
  | {
      ok: false;
      path: string;
      reason: DefaultsFileFailureReason;
      message: string;
    };

/**
 * Reads and validates `.agent-primitives.json` at `root`. Absent is not
 * an error -- most repositories have none -- and reads as `present:
 * false`, `links: []`. Present but not a regular file, over the size
 * cap, unreadable, not valid JSON, not a JSON object, carrying an
 * unknown key, or whose `link` is not an array of valid link strings
 * (see `linkEntryUsageError`, applied to each entry the same as a
 * `--plan` file's own `link` field) is refused by `reason` and a
 * `message` naming the path (and, for an unknown key, the key itself).
 * Entries are returned unresolved, relative to `root` (this file's own
 * location IS the root, so its paths are portable across the invocation
 * cwd within the repo) -- the caller resolves and merges them with the
 * plan's and `--link`'s own values via `mergeLinkSources`.
 */
export function readDefaultsFile(root: string): DefaultsFileReadResult {
  const filePath = path.join(root, DEFAULTS_FILE_NAME);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: true, path: filePath, present: false, links: [] };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      path: filePath,
      reason: "defaults_file_not_readable",
      message: `${filePath} is not a regular file`,
    };
  }
  if (stat.size > DEFAULTS_FILE_MAX_BYTES) {
    return {
      ok: false,
      path: filePath,
      reason: "defaults_file_not_readable",
      message:
        `${filePath} is ${String(stat.size)} bytes, over the ` +
        `${String(DEFAULTS_FILE_MAX_BYTES)}-byte cap`,
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      reason: "defaults_file_not_readable",
      message: `${filePath} could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      reason: "defaults_file_invalid",
      message: `${filePath}: not valid JSON (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      path: filePath,
      reason: "defaults_file_invalid",
      message: `${filePath}: must be a JSON object`,
    };
  }
  const record = parsed as Record<string, unknown>;
  const extraKey = Object.keys(record).find(
    (key) => !(DEFAULTS_FILE_KEYS as readonly string[]).includes(key),
  );
  if (extraKey !== undefined) {
    return {
      ok: false,
      path: filePath,
      reason: "defaults_file_invalid",
      message: `${filePath}: unknown key "${extraKey}" (only "link" is a known key)`,
    };
  }
  if (record.link === undefined) {
    return { ok: true, path: filePath, present: true, links: [] };
  }
  if (!Array.isArray(record.link)) {
    return {
      ok: false,
      path: filePath,
      reason: "defaults_file_invalid",
      message: `${filePath}: "link" must be an array of strings`,
    };
  }
  const links: string[] = [];
  for (const [index, entry] of record.link.entries()) {
    const err = linkEntryUsageError(entry);
    if (err !== undefined) {
      return {
        ok: false,
        path: filePath,
        reason: "defaults_file_invalid",
        message: `${filePath}: link[${String(index)}] ${err}`,
      };
    }
    links.push(entry as string);
  }
  return { ok: true, path: filePath, present: true, links };
}
