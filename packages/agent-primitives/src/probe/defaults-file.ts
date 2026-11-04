import fs from "node:fs";
import path from "node:path";
import {
  CHECK_NAME_PATTERN,
  INTEGRAL_KEY_PATTERN,
  PRESET_SCRIPT_FIRST_CHAR,
} from "../check-names.js";
import { linkEntryUsageError } from "./link-list.js";

/** The repo-level defaults file every `probe`/`--plan` invocation and every
 * `verify` invocation reads: `.agent-primitives.json` at the repository
 * root -- the directory both treat as the repo root (the git work-tree
 * root, or `cwd` when not in a repository), never a subdirectory the
 * invocation `cwd` happens to sit in. What it can hold: `link` (the probe
 * link list) and `verify` (the check preset `verify` runs when `-c` says
 * nothing else). */
export const DEFAULTS_FILE_NAME = ".agent-primitives.json";

/** The only keys the schema recognizes. Unknown keys are a usage error
 * naming the path and the keys (fail-closed), so a typo does not silently
 * do nothing. Both keys are read WHOLE-FILE on every consumer: a file
 * carrying an invalid `verify` is refused by `probe` exactly as an invalid
 * `link` is refused by `verify`, because there is one loader and one
 * validation pass (see `src/verify/index.ts`'s preset resolution). */
const DEFAULTS_FILE_KEYS = ["link", "verify"] as const;

/** A defaults file this small can only be config, never data; well
 * above what a real `link` list needs, and small enough that reading it
 * whole on every invocation is free. */
export const DEFAULTS_FILE_MAX_BYTES = 64 * 1024;

export type DefaultsFileFailureReason =
  | "defaults_file_invalid"
  | "defaults_file_not_readable"
  /** A `verify` key whose `checks` object is present but has no key at
   * all: a preset that names no check would silently mean "run nothing",
   * so it is refused on its own reason rather than as a shape error. */
  | "empty_preset";

/** The `verify` section, validated: `checks` maps a check name to the
 * `package.json` script that satisfies it (in the file's own key order),
 * `order` is the subset of those names to run first, the rest following in
 * object order. `checks` is a null-prototype object, so a `__proto__` key
 * in the file is an ordinary (refused) key rather than a prototype
 * assignment. */
export interface DefaultsFileVerify {
  checks: Record<string, string>;
  order: string[];
}

export type DefaultsFileReadResult =
  | {
      ok: true;
      path: string;
      present: boolean;
      links: string[];
      verify?: DefaultsFileVerify;
    }
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
 * unknown key, whose `link` is not an array of valid link strings (see
 * `linkEntryUsageError`, applied to each entry the same as a `--plan`
 * file's own `link` field), or whose `verify` is not a valid preset (see
 * `parseVerifyPreset`) is refused by `reason` and a `message` naming the
 * path (and, for an unknown key, the key itself).
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
      message: `${filePath}: unknown key "${extraKey}" (only "link" and "verify" are known keys)`,
    };
  }
  const links: string[] = [];
  if (record.link !== undefined) {
    if (!Array.isArray(record.link)) {
      return {
        ok: false,
        path: filePath,
        reason: "defaults_file_invalid",
        message: `${filePath}: "link" must be an array of strings`,
      };
    }
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
  }
  let verify: DefaultsFileVerify | undefined;
  if (record.verify !== undefined) {
    const parsed = parseVerifyPreset(record.verify, filePath);
    if (!parsed.ok) {
      return {
        ok: false,
        path: filePath,
        reason: parsed.reason,
        message: parsed.message,
      };
    }
    verify = parsed.preset;
  }
  return {
    ok: true,
    path: filePath,
    present: true,
    links,
    ...(verify ? { verify } : {}),
  };
}

/** A JSON object (not null, not an array): the shape every `verify`
 * section and its `checks` map has to have to be read any further. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type VerifyPresetParse =
  | { ok: true; preset: DefaultsFileVerify }
  | { ok: false; reason: DefaultsFileFailureReason; message: string };

/**
 * Validates the `verify` section: `{ checks: { <checkName>: <scriptName>,
 * ... }, order?: [<checkName>, ...] }`. A preset names SCRIPTS, never
 * commands: a key must be a check name (`CHECK_NAME_PATTERN`, which is
 * what refuses every shell metacharacter), must not look like an integer
 * (JavaScript reorders such keys, so the file's own run order could not be
 * honoured), and must not be `__proto__` (a legal check name as far as the
 * pattern goes, and the one key whose meaning is never a check name). A
 * value must be a string naming a script: it matches the same pattern and
 * additionally starts with a letter or a digit, so it can never reach npm
 * as a flag (`--workspaces` would change what every script in the run
 * means). `order`, when present, is an array of distinct names taken from
 * `checks`. `checks` present but empty is `empty_preset`; every other
 * violation is `defaults_file_invalid`, each message naming the key it
 * refused.
 */
function parseVerifyPreset(
  value: unknown,
  filePath: string,
): VerifyPresetParse {
  const invalid = (message: string): VerifyPresetParse => ({
    ok: false,
    reason: "defaults_file_invalid",
    message: `${filePath}: ${message}`,
  });
  if (!isJsonObject(value)) {
    return invalid(
      '"verify" must be an object with a non-empty "checks" object',
    );
  }
  const section = value;
  if (!isJsonObject(section.checks)) {
    return invalid(
      '"verify.checks" must be an object mapping a check name to an npm script name',
    );
  }
  const source = section.checks;
  const keys = Object.keys(source);
  if (keys.length === 0) {
    return {
      ok: false,
      reason: "empty_preset",
      message: `${filePath}: "verify.checks" is empty: a preset must name at least one check`,
    };
  }
  const checks: Record<string, string> = Object.create(null);
  for (const key of keys) {
    if (INTEGRAL_KEY_PATTERN.test(key)) {
      return invalid(
        `"verify.checks" key "${key}" looks like an integer: a JSON object reorders such keys, so the file's own run order could not be honoured`,
      );
    }
    if (key === "__proto__") {
      return invalid(
        '"verify.checks" key "__proto__" is refused: a key must be a check name',
      );
    }
    if (!CHECK_NAME_PATTERN.test(key)) {
      return invalid(
        `"verify.checks" key "${key}" must match ${CHECK_NAME_PATTERN}`,
      );
    }
    const script = source[key];
    if (typeof script !== "string") {
      return invalid(
        `"verify.checks" value for "${key}" must be a string naming an npm script`,
      );
    }
    if (!PRESET_SCRIPT_FIRST_CHAR.test(script)) {
      return invalid(
        `"verify.checks" value for "${key}" must start with a letter or a digit: a leading "-" would reach npm as a flag`,
      );
    }
    if (!CHECK_NAME_PATTERN.test(script)) {
      return invalid(
        `"verify.checks" value for "${key}" must match ${CHECK_NAME_PATTERN} (a preset names an npm script, never a command)`,
      );
    }
    checks[key] = script;
  }
  const order: string[] = [];
  if (section.order !== undefined) {
    if (!Array.isArray(section.order)) {
      return invalid('"verify.order" must be an array of check names');
    }
    for (const [index, entry] of section.order.entries()) {
      if (typeof entry !== "string") {
        return invalid(
          `${'"verify.order"'} entry ${String(index)} must be a check name`,
        );
      }
      if (!Object.prototype.hasOwnProperty.call(checks, entry)) {
        return invalid(
          `"verify.order" entry "${entry}" is not one of "verify.checks"`,
        );
      }
      if (order.includes(entry)) {
        return invalid(`"verify.order" lists "${entry}" more than once`);
      }
      order.push(entry);
    }
  }
  return { ok: true, preset: { checks, order } };
}
