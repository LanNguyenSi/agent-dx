/**
 * The path rules of `spec-gate export --format ow`, documented in
 * `docs/export.md`.
 *
 * Rule one: export refuses non-canonical binding paths. A `bindings.yaml`
 * whose `file` or `fixtures` entry is not in canonical repo-relative form
 * (`isCanonicalRepoPath`) never reaches the briefing: `export` exits with
 * the named refusal `binding-path-not-canonical`, naming the TP id and the
 * path. The check reads the decoded document (strings only) before
 * `bindings.yaml` is validated as a format, so the refusal is about the
 * spelling and not about anything else the file may also get wrong.
 *
 * Rule two: the hint drops what is forbidden. A candidate of
 * `allowed_changes_hint` is dropped when it is one of the spec's own
 * normative files or when a Non-goal path covers it: equal to the entry,
 * below the entry (the entry, or the entry plus `/`, is its prefix), or
 * matched by the entry when the entry holds a glob. The glob semantics are
 * those of the Non-goal `paths` attribute (`docs/formats.md`, "spec.md"):
 * `*` matches any characters except `/`, `**` matches any characters
 * including `/`, every other character matches itself.
 */
import path from "node:path";
import { parseYamlText } from "../formats/index.js";
import { ExportError } from "./errors.js";
import type { ExportErrorCode } from "./errors.js";

/** The refusal code of rule one. */
export const BINDING_PATH_NOT_CANONICAL: ExportErrorCode =
  "binding-path-not-canonical";

/**
 * True when `p` is in canonical repo-relative form: no leading `./`, no
 * `//`, no trailing `/`, no `.` or `..` component, no backslash, and equal
 * to its own POSIX normalisation. A leading `/` is refused as an empty
 * first segment: an absolute path is not repo-relative.
 */
export function isCanonicalRepoPath(p: string): boolean {
  if (p.includes("\\")) return false;
  for (const segment of p.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return path.posix.normalize(p) === p;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(tpId: string, field: string, value: string): never {
  throw new ExportError(
    BINDING_PATH_NOT_CANONICAL,
    `binding ${tpId}: ${field} ${JSON.stringify(value)} is not a canonical repo-relative path: no './', '.' or '..' segment, no '//' or leading or trailing '/', no backslash, and unchanged by POSIX normalisation`,
  );
}

/**
 * Refuses a `bindings.yaml` text that holds a non-canonical binding path
 * in any `file` or `fixtures` entry. Unparsable YAML and non-string values
 * are left to the format parser, which names them.
 */
export function assertCanonicalBindingPaths(text: string): void {
  const decoded = parseYamlText(text);
  if (!decoded.ok || !isMapping(decoded.value)) return;
  for (const [tpId, raw] of Object.entries(decoded.value)) {
    if (!isMapping(raw)) continue;
    const file = raw["file"];
    if (typeof file === "string" && !isCanonicalRepoPath(file)) {
      refuse(tpId, "file", file);
    }
    const fixtures = raw["fixtures"];
    if (Array.isArray(fixtures)) {
      fixtures.forEach((entry, i) => {
        if (typeof entry === "string" && !isCanonicalRepoPath(entry)) {
          refuse(tpId, `fixtures[${i}]`, entry);
        }
      });
    }
  }
}

/** A Non-goal path spelling a glob. */
function isGlob(pattern: string): boolean {
  return pattern.includes("*");
}

/**
 * The matcher of the documented glob semantics: `*` is any characters
 * except `/`, `**` is any characters including `/`, everything else is
 * literal (a `?` matches itself).
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += "[\\s\\S]*";
        i++;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** True when the Non-goal path `nonGoal` covers the candidate path. */
export function nonGoalCovers(nonGoal: string, candidate: string): boolean {
  if (candidate === nonGoal) return true;
  if (isGlob(nonGoal)) return globToRegExp(nonGoal).test(candidate);
  const dir = nonGoal.endsWith("/") ? nonGoal : `${nonGoal}/`;
  return candidate.startsWith(dir);
}

/**
 * True when the hint candidate must be dropped: it is the spec's own
 * `spec.md` or `testplan.yaml`, or a Non-goal path covers it.
 */
export function isDroppedHintPath(
  candidate: string,
  specMdRel: string,
  testplanRel: string,
  nonGoalPaths: readonly string[],
): boolean {
  if (candidate === specMdRel || candidate === testplanRel) return true;
  return nonGoalPaths.some((nonGoal) => nonGoalCovers(nonGoal, candidate));
}
